const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { runProcess } = require('../engine-runtime');
const {
  VisualFindingCache, VisualRiskService, VisualSamplingService, cheapScan, hammingDistance,
  loadVisualRiskConfig, perceptualHash, preferSceneCuts, samplePositions, visualCacheKey
} = require('../services/visualRisk');
const { OllamaVisualProvider } = require('../services/visualRisk/provider');

const root = path.join(__dirname, '..');
const ffmpeg = path.join(root, 'resources', 'bin', 'fallback', 'ffmpeg.exe');
const manifest = require('../test/real-world-visual/manifest.json');
const proxyRoot = process.env.VISUAL_STRESS_PROXY_DIR;
const outputPath = process.env.VISUAL_STRESS_OUTPUT || path.join(root, 'docs', 'evidence', 'phase5-1-real-world-results.json');
const config = loadVisualRiskConfig();
const aggressiveProfile = { short: 3, medium: 5, long: 7 };
const riskLabels = new Set(['WEAPON_VISIBLE', 'BLOOD_VISIBLE', 'INJURY_VISIBLE', 'NUDITY_RISK', 'TEXT_RISK', 'OTHER_VISUAL_RISK']);

function segments(duration) {
  const result = [];
  for (let startSeconds = 0; startSeconds < duration; startSeconds += 20) {
    result.push({ startSeconds, endSeconds: Math.min(duration, startSeconds + 20), text: 'Transcript-aligned 20-second evaluation window.' });
  }
  return result;
}

function labelsAt(video, timestamp) {
  return [...new Set(video.reviewWindows.filter(window => timestamp >= window.start && timestamp <= window.end).flatMap(window => window.labels))];
}

function covered(timestampList, window) {
  return timestampList.some(timestamp => timestamp >= window.start && timestamp <= window.end);
}

function probeVram() {
  return new Promise(resolve => execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], (error, stdout) => resolve(error ? null : Number.parseInt(stdout, 10))));
}

async function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return; }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 9) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
}

async function checked(args, timeoutMs = 30000, signal) {
  const result = await runProcess(ffmpeg, args, { timeoutMs, signal });
  if (result.cancelled) return result;
  if (!result.ok) throw new Error(result.error || result.stderr);
  return result;
}

async function frame(sampler, proxy, timestamp, workDir, id, height = 360) {
  const base = `${id}-${String(timestamp).replace('.', '_')}-${height}`;
  const rawPath = path.join(workDir, `${base}.rgb`);
  const jpgPath = path.join(workDir, `${base}.jpg`);
  if (height === config.frameHeight) {
    const bytes = await sampler.extractRaw(proxy, timestamp, rawPath);
    await sampler.extractJpeg(proxy, timestamp, jpgPath);
    fs.rmSync(rawPath, { force: true });
    return { bytes, jpgPath, width: config.frameWidth, height };
  }
  const width = Math.round(height * 16 / 9);
  await checked(['-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', proxy, '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', rawPath]);
  await checked(['-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', proxy, '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-q:v', '4', '-y', jpgPath]);
  const bytes = fs.readFileSync(rawPath); fs.rmSync(rawPath, { force: true });
  return { bytes, jpgPath, width, height };
}

function expectedHit(labels, inspected) {
  const applied = new Set(inspected.findings.filter(item => item.applies).map(item => item.category));
  if (labels.includes('WEAPON_VISIBLE')) return applied.has('weapon');
  if (labels.includes('BLOOD_VISIBLE')) return applied.has('blood');
  if (labels.includes('INJURY_VISIBLE')) return applied.has('blood') || applied.has('graphic_injury');
  if (labels.includes('NUDITY_RISK')) return true;
  if (labels.includes('TEXT_RISK')) return Boolean(inspected.detectedText);
  return true;
}

function falsePositive(labels, inspected) {
  const applied = inspected.findings.filter(item => item.applies).map(item => item.category);
  const allowed = new Set();
  if (labels.includes('WEAPON_VISIBLE')) allowed.add('weapon');
  if (labels.includes('BLOOD_VISIBLE')) allowed.add('blood');
  if (labels.includes('INJURY_VISIBLE')) { allowed.add('blood'); allowed.add('graphic_injury'); }
  if (labels.includes('TEXT_RISK')) allowed.add('on_screen_text_risk');
  return applied.some(category => !allowed.has(category));
}

async function main() {
  if (!proxyRoot || !path.isAbsolute(proxyRoot)) throw new Error('Set VISUAL_STRESS_PROXY_DIR to the absolute directory containing reviewed proxies.');
  const missing = manifest.videos.filter(video => !fs.existsSync(path.join(proxyRoot, `${video.id}.mp4`)));
  if (missing.length) throw new Error(`Missing reviewed proxies: ${missing.map(video => video.id).join(', ')}`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-1-stress-'));
  const sampler = new VisualSamplingService({ ffmpegPath: ffmpeg, runProcess, config });
  const provider = new OllamaVisualProvider(config);
  const vramBeforeMiB = await probeVram();
  let peakVramMiB = vramBeforeMiB;
  const vramSequential = {};
  const monitor = setInterval(async () => { const value = await probeVram(); if (Number.isFinite(value)) peakVramMiB = Math.max(peakVramMiB || 0, value); }, 400);
  const started = Date.now();
  try {
    const health = await provider.healthCheck();
    if (!health.ok) throw Object.assign(new Error(health.message), { code: health.code });
    await provider.unload('qwen3:14b');
    const vramAfterQwenUnloadMiB = await probeVram();
    const rows = [];
    const vlmCases = [];
    const resolutionCases = [];
    const briefEvents = [];
    const failureCounts = { SAMPLING: 0, DEDUPE: 0, ESCALATION: 0, VLM: 0, OCR: 0, POLICY_MAPPING: 0 };
    for (const video of manifest.videos) {
      const proxy = path.join(proxyRoot, `${video.id}.mp4`);
      const cuts = await sampler.sceneCuts(proxy);
      const transcriptSegments = segments(video.durationSeconds);
      const baseline = transcriptSegments.flatMap(segment => preferSceneCuts(samplePositions(segment), cuts, config.sceneWindowSeconds));
      const aggressive = transcriptSegments.flatMap(segment => preferSceneCuts(samplePositions(segment, aggressiveProfile), cuts, config.sceneWindowSeconds));
      const targetWindows = video.reviewWindows.filter(window => window.labels.some(label => riskLabels.has(label)));
      const baselineMisses = targetWindows.filter(window => !covered(baseline, window));
      const aggressiveMisses = targetWindows.filter(window => !covered(aggressive, window));
      briefEvents.push(...video.reviewWindows.filter(window => window.briefEventBand).map(window => ({ id: video.id, band: window.briefEventBand, baselineHit: covered(baseline, window), aggressiveHit: covered(aggressive, window) })));
      failureCounts.SAMPLING += baselineMisses.length;
      const frames = []; const extractionStarted = Date.now();
      for (let index = 0; index < baseline.length; index++) {
        const timestamp = baseline[index];
        const item = await frame(sampler, proxy, timestamp, workDir, `${video.id}-sample-${index}`);
        const hash = perceptualHash(item.bytes, item.width, item.height);
        const signals = cheapScan(item.bytes, item.width, item.height, config);
        frames.push({ timestamp, hash, signals, labels: labelsAt(video, timestamp) });
        fs.rmSync(item.jpgPath, { force: true });
      }
      const dedupe = {};
      for (const threshold of [4, 7, 10]) {
        const comparisonStarted = Date.now();
        const representatives = [];
        let removed = 0; let riskLost = 0;
        for (const item of frames) {
          const duplicate = representatives.find(candidate => hammingDistance(candidate.hash, item.hash) <= threshold);
          if (!duplicate) representatives.push(item);
          else {
            removed++;
            const currentRisk = item.labels.some(label => riskLabels.has(label));
            const sameEvidence = item.labels.some(label => duplicate.labels.includes(label));
            if (currentRisk && !sameEvidence) riskLost++;
          }
        }
        dedupe[threshold] = { retained: representatives.length, removed, riskLost, vlmCandidates: representatives.filter(item => item.signals.escalate).length, comparisonMs: Date.now() - comparisonStarted };
        if (threshold === 7) failureCounts.DEDUPE += riskLost;
      }
      const cheapEscalated = frames.filter(item => item.signals.escalate).length;
      const riskNotEscalated = frames.filter(item => item.labels.some(label => riskLabels.has(label)) && !item.signals.escalate).length;
      failureCounts.ESCALATION += riskNotEscalated;
      rows.push({
        id: video.id, durationSeconds: video.durationSeconds, challenges: video.challenges, sceneCutsDetected: cuts.length, framesExtracted: frames.length, extractionAndScanMs: Date.now() - extractionStarted,
        sampling: { baselinePlanned: baseline.length, aggressivePlanned: aggressive.length, targetWindows: targetWindows.length, baselineMisses: baselineMisses.map(window => [window.start, window.end]), aggressiveMisses: aggressiveMisses.map(window => [window.start, window.end]) },
        dedupe, cheapEscalation: { escalated: cheapEscalated, retainedAt7: dedupe[7].retained, riskNotEscalated }
      });
      const chosen = targetWindows.filter(window => !window.labels.includes('OTHER_VISUAL_RISK')).slice(0, 2);
      if (!chosen.length) chosen.push(video.reviewWindows[0]);
      for (const window of chosen) vlmCases.push({ video, proxy, window, timestamp: (window.start + window.end) / 2 });
      for (const window of chosen.filter(item => item.smallObjectOrText)) resolutionCases.push({ video, proxy, window, timestamp: (window.start + window.end) / 2 });
    }

    const vlm = [];
    const cache = new VisualFindingCache();
    for (let index = 0; index < vlmCases.length; index++) {
      const item = vlmCases[index];
      const extracted = await frame(sampler, item.proxy, item.timestamp, workDir, `${item.video.id}-vlm-${index}`);
      const signals = cheapScan(extracted.bytes, extracted.width, extracted.height, config);
      const hash = perceptualHash(extracted.bytes, extracted.width, extracted.height);
      const key = visualCacheKey({ videoId: item.video.id, timestamp: item.timestamp, frameHash: hash, config });
      const caseStarted = Date.now();
      let inspected = cache.get(key);
      const cacheHit = Boolean(inspected);
      if (!inspected) { inspected = await provider.inspectFrame(extracted.jpgPath, signals); cache.set(key, inspected); }
      const falsePositiveFinding = falsePositive(item.window.labels, inspected);
      const pass = expectedHit(item.window.labels, inspected) && !falsePositiveFinding;
      if (!pass) failureCounts.VLM++;
      if (item.window.ocrTextPresent && !inspected.detectedText) failureCounts.OCR++;
      vlm.push({ id: item.video.id, timestamp: item.timestamp, labels: item.window.labels, pass, falsePositive: falsePositiveFinding, cacheHit, latencyMs: Date.now() - caseStarted, findings: inspected.findings.filter(value => value.applies), detectedText: inspected.detectedText });
      if (index === 4 || index === 9) vramSequential[index + 1] = await probeVram();
      fs.rmSync(extracted.jpgPath, { force: true });
    }

    const cacheCases = vlmCases.slice(0, 3);
    const cacheStarted = Date.now(); let cacheHits = 0;
    for (let index = 0; index < cacheCases.length; index++) {
      const item = cacheCases[index];
      const extracted = await frame(sampler, item.proxy, item.timestamp, workDir, `${item.video.id}-cache-${index}`);
      const hash = perceptualHash(extracted.bytes, extracted.width, extracted.height);
      const key = visualCacheKey({ videoId: item.video.id, timestamp: item.timestamp, frameHash: hash, config });
      if (cache.get(key)) cacheHits++;
      fs.rmSync(extracted.jpgPath, { force: true });
    }
    const cacheRuntimeMs = Date.now() - cacheStarted;

    const resolution = [];
    for (let index = 0; index < resolutionCases.length; index++) {
      const item = resolutionCases[index]; const comparison = { id: item.video.id, timestamp: item.timestamp };
      for (const height of [360, 480]) {
        const extracted = await frame(sampler, item.proxy, item.timestamp, workDir, `${item.video.id}-resolution-${index}`, height);
        const scanConfig = { ...config, frameWidth: extracted.width, frameHeight: height };
        const signals = cheapScan(extracted.bytes, extracted.width, height, scanConfig);
        const inspected = await provider.inspectFrame(extracted.jpgPath, signals);
        comparison[height] = { pass: expectedHit(item.window.labels, inspected), findings: inspected.findings.filter(value => value.applies), detectedText: inspected.detectedText };
        fs.rmSync(extracted.jpgPath, { force: true });
      }
      resolution.push(comparison);
    }

    const inferenceCancelFrame = await frame(sampler, path.join(proxyRoot, 'Le7n6i0dpTI.mp4'), 23.5, workDir, 'inference-cancel');
    const inferenceAborter = new AbortController();
    const inferenceCancelPromise = provider.inspectFrame(inferenceCancelFrame.jpgPath, {}, { signal: inferenceAborter.signal }).then(() => null, error => error.code || error.message);
    setTimeout(() => inferenceAborter.abort(), 20);
    const inferenceCancelCode = await inferenceCancelPromise;
    fs.rmSync(inferenceCancelFrame.jpgPath, { force: true });

    const cancelDir = fs.mkdtempSync(path.join(workDir, 'cancel-'));
    const aborter = new AbortController();
    const cancelPromise = checked(['-hide_banner', '-loglevel', 'error', '-stream_loop', '-1', '-i', path.join(proxyRoot, `${manifest.videos[0].id}.mp4`), '-t', '600', '-c:v', 'libx264', '-y', path.join(cancelDir, 'cancel.mp4')], 0, aborter.signal);
    setTimeout(() => aborter.abort(), 30);
    const cancelResult = await cancelPromise;
    await removeTree(cancelDir);

    const longVideo = manifest.videos.find(video => video.id === '6qv5nYmGqLs');
    const longSegments = segments(longVideo.durationSeconds);
    const longService = new VisualRiskService({ config, provider, cache: new VisualFindingCache(), sampler, textModel: 'qwen3:14b' });
    const longStarted = Date.now();
    const longRun = await longService.analyze(path.join(proxyRoot, `${longVideo.id}.mp4`), workDir, { metadata: { videoId: longVideo.id }, transcriptSegments: longSegments }, longSegments.map((_, index) => ({ id: `segment-${index + 1}`, decision: 'KEEP', categories: [], requiresVisualReview: false })));
    const longRuntimeMs = Date.now() - longStarted;
    await provider.unload(config.model);
    const vramAfterGemmaUnloadMiB = await probeVram();
    const result = {
      generatedAt: new Date().toISOString(), model: config.model, corpusSize: manifest.videos.length,
      sourceMediaCommitted: false, runtimeMs: Date.now() - started,
      vram: { beforeMiB: vramBeforeMiB, afterQwenUnloadMiB: vramAfterQwenUnloadMiB, after5VideosMiB: vramSequential[5] || null, after10VideosMiB: vramSequential[10] || null, peakMiB: peakVramMiB, afterGemmaUnloadMiB: vramAfterGemmaUnloadMiB },
      videos: rows, vlm, resolution,
      vlmLatency: (() => { const values = vlm.map(item => item.latencyMs); const warm = values.slice(1).sort((a, b) => a - b); const percentile = p => warm[Math.min(warm.length - 1, Math.floor(warm.length * p))]; return { coldFirstMs: values[0], warmMeanMs: Math.round(warm.reduce((a, b) => a + b, 0) / warm.length), warmP50Ms: percentile(0.5), warmP95Ms: percentile(0.95), totalMs: values.reduce((a, b) => a + b, 0) }; })(),
      cache: { videos: cacheCases.length, secondRunHits: cacheHits, secondRunVlmCalls: cacheCases.length - cacheHits, firstRunVlmMs: vlm.slice(0, 3).reduce((sum, item) => sum + item.latencyMs, 0), secondRunMs: cacheRuntimeMs },
      cancellation: { processCancelled: cancelResult.cancelled, inferenceCancelCode, tempClean: !fs.existsSync(cancelDir) },
      longRealVideo: { id: longVideo.id, durationSeconds: longVideo.durationSeconds, runtimeMs: longRuntimeMs, ...longRun.metrics },
      briefEvents, failureCounts
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ outputPath, corpusSize: result.corpusSize, runtimeMs: result.runtimeMs, peakVramMiB, longRealVideo: result.longRealVideo, failureCounts }, null, 2));
  } finally {
    clearInterval(monitor);
    await removeTree(workDir);
  }
}

main().catch(error => { console.error(JSON.stringify({ code: error.code || 'REAL_WORLD_VISUAL_STRESS_FAILED', message: error.message, rawOutput: error.rawOutput || null })); process.exitCode = 1; });
