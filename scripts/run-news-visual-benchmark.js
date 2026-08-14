const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { runProcess } = require('../engine-runtime');
const {
  NEWS_SCENE_TYPES, RapidOcrProvider, VisualFindingCache, VisualRiskService, VisualSamplingService,
  cheapScan, classifyNewsScene, hammingDistance, loadVisualRiskConfig, normalizeOcrOutput,
  overlayHash, perceptualHash, refineTextScene, screenOcrRisk
} = require('../services/visualRisk');
const { OllamaVisualProvider } = require('../services/visualRisk/provider');

const root = path.join(__dirname, '..');
const ffmpeg = path.join(root, 'resources', 'bin', 'fallback', 'ffmpeg.exe');
const manifest = require('../test/news-visual/manifest.json');
const newsRoot = process.env.NEWS_VISUAL_PROXY_DIR || path.join(os.tmpdir(), 'tpc-phase5-4-news');
const stressRoot = process.env.VISUAL_STRESS_PROXY_DIR || path.join(os.tmpdir(), 'tpc-phase5-1-review');
const outputPath = process.env.NEWS_VISUAL_OUTPUT || path.join(root, 'docs', 'evidence', 'phase5-4-news-results.json');
const config = loadVisualRiskConfig();

const ocrCases = [
  ['software-screen', 'M7lc1UVf-VE', 720, ['youtube', 'developers']],
  ['news-headline', 'wxEpPin8MWw', 21, ['false', 'london']],
  ['prevention-card', 'Le7n6i0dpTI', 23.5, ['mental health']],
  ['news-overlay', '6qv5nYmGqLs', 297, ['911']],
  ['firearm-title', 'KTuYS857lOE', 55, ['glock']],
  ['handheld-overlay', '8y-hasHqCK8', 282.5, ['shoot']],
  ['fast-title', '11csVIXiFg4', 9, ['editing']],
  ['small-ui', 'qojC09CbSQA', 550, ['settings', 'save']],
  ['watermark', '0BEDHqtb0aw', 175.5, ['production']],
  ['first-aid-title', 'AhANvBB9hz0', 6.5, ['sometimes']],
  ['first-aid-step', 'AhANvBB9hz0', 30, ['step 4']],
  ['swim-label', 'BQW9Zw0CsQ8', 143, ['breathing']]
];

function probeVram() {
  return new Promise(resolve => execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
    (error, stdout) => resolve(error ? null : Number.parseInt(stdout, 10))));
}

function segments(duration) {
  const result = [];
  for (let startSeconds = 0; startSeconds < duration; startSeconds += 30) {
    result.push({ startSeconds, endSeconds: Math.min(duration, startSeconds + 30), text: 'Neutral news transcript window.' });
  }
  return result;
}

async function removeTree(target) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return; }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 7) throw error; await new Promise(resolve => setTimeout(resolve, 150)); }
  }
}

async function extract(sampler, videoPath, timestamp, workDir, name) {
  const rawPath = path.join(workDir, `${name}.rgb`);
  const jpgPath = path.join(workDir, `${name}.jpg`);
  const bytes = await sampler.extractRaw(videoPath, timestamp, rawPath);
  await sampler.extractJpeg(videoPath, timestamp, jpgPath);
  fs.rmSync(rawPath, { force: true });
  return { bytes, jpgPath };
}

async function classificationBenchmark(sampler, ocr, workDir) {
  const rows = [];
  for (const video of manifest.videos) {
    const videoPath = path.join(newsRoot, `${video.id}.mp4`);
    let state = null;
    for (let index = 0; index < video.labels.length; index++) {
      const label = video.labels[index];
      const item = await extract(sampler, videoPath, label.timestamp, workDir, `class-${video.id}-${index}`);
      const frameHash = perceptualHash(item.bytes, config.frameWidth, config.frameHeight);
      const currentOverlayHash = overlayHash(item.bytes, config.frameWidth, config.frameHeight);
      const signals = cheapScan(item.bytes, config.frameWidth, config.frameHeight, config);
      const hashDistance = state ? hammingDistance(state.frameHash, frameHash) : null;
      const overlayDistance = state ? hammingDistance(state.overlayHash, currentOverlayHash) : null;
      let predicted = classifyNewsScene({ signals, hashDistance, overlayDistance, sceneCut: false, config });
      let ocrText = '';
      if (label.ocrUseful) {
        const raw = await ocr.inspectFrame(item.jpgPath, label.timestamp);
        const normalized = normalizeOcrOutput(raw, label.timestamp, new Set(), config.ocrMinimumConfidence);
        ocrText = normalized.normalizedText;
        predicted = refineTextScene(predicted, normalized, signals);
      }
      rows.push({ videoId: video.id, timestamp: label.timestamp, expected: label.sceneType, predicted,
        match: predicted === label.sceneType, ocrUsefulExpected: label.ocrUseful,
        signals: { skinRatio: signals.skinRatio, textHeavy: signals.textHeavy, complexObject: signals.complexObject,
          edgeDensity: signals.edgeDensity, hashDistance, overlayDistance }, ocrText: ocrText.slice(0, 180) });
      state = { frameHash, overlayHash: currentOverlayHash };
      fs.rmSync(item.jpgPath, { force: true });
    }
  }
  return { labels: rows.length, matched: rows.filter(row => row.match).length,
    unknown: rows.filter(row => row.predicted === NEWS_SCENE_TYPES.UNKNOWN).length, rows };
}

async function ocrBenchmark(sampler, ocr, workDir, coldStartMs) {
  const rows = [];
  for (let index = 0; index < ocrCases.length; index++) {
    const [name, id, timestamp, expected] = ocrCases[index];
    const item = await extract(sampler, path.join(stressRoot, `${id}.mp4`), timestamp, workDir, `ocr-${index}`);
    const started = Date.now();
    const raw = await ocr.inspectFrame(item.jpgPath, timestamp);
    const normalized = normalizeOcrOutput(raw, timestamp, new Set(), config.ocrMinimumConfidence);
    const lower = normalized.normalizedText.toLowerCase();
    const useful = expected.some(fragment => lower.includes(fragment));
    rows.push({ name, videoId: id, timestamp, useful, expectedAny: expected, text: normalized.normalizedText,
      wallMs: Date.now() - started, engineMs: raw.engineMs, cpuMs: raw.cpuMs, risk: screenOcrRisk(normalized.normalizedText) });
    fs.rmSync(item.jpgPath, { force: true });
  }
  const german = await extract(sampler, path.join(stressRoot, 'qojC09CbSQA.mp4'), 600, workDir, 'ocr-german');
  const germanRaw = await ocr.inspectFrame(german.jpgPath, 600);
  const germanText = normalizeOcrOutput(germanRaw, 600, new Set(), config.ocrMinimumConfidence).normalizedText;
  fs.rmSync(german.jpgPath, { force: true });
  const totalWall = rows.reduce((sum, row) => sum + row.wallMs, 0);
  const totalCpu = rows.reduce((sum, row) => sum + (row.cpuMs || 0), 0);
  return { cases: rows.length, useful: rows.filter(row => row.useful).length, coldStartMs,
    status: rows.filter(row => row.useful).length >= 10 ? 'PASS' : 'OCR_GAP',
    meanWallMs: Math.round(totalWall / rows.length), meanCpuMs: Math.round(totalCpu / rows.length),
    cpuToWallRatio: Number((totalCpu / Math.max(totalWall, 1)).toFixed(2)),
    warmThroughputFramesPerSecond: Number((rows.length / Math.max(totalWall / 1000, 0.001)).toFixed(2)),
    multilingualLatin: { language: 'German', useful: /deine|restaurant|bar/i.test(germanText), text: germanText }, rows };
}

function routingBenchmark() {
  const labels = manifest.videos.flatMap(video => video.labels.map(label => ({ videoId: video.id, ...label })));
  const genericGemmaCalls = labels.length;
  const optimizedGemmaCalls = labels.filter(label => label.gemmaUseful).length;
  return { reviewedFrames: labels.length, genericGemmaCalls, optimizedGemmaCalls,
    reductionPercent: Number(((1 - optimizedGemmaCalls / genericGemmaCalls) * 100).toFixed(1)),
    basis: 'Manual frame-level usefulness labels from the reviewed news corpus.' };
}

async function longRealRun(sampler, workDir) {
  if (process.env.NEWS_BENCHMARK_SKIP_LONG === '1') return { skipped: true };
  const video = manifest.videos.find(item => item.id === 'LK5j3pp0Too');
  const transcriptSegments = segments(video.durationSeconds);
  const judgments = transcriptSegments.map((_, index) => ({ id: `segment-${index + 1}`, decision: 'KEEP', categories: [], requiresVisualReview: false }));
  const genericConfig = loadVisualRiskConfig({ newsOptimizationEnabled: false, ocrEnabled: false });
  const countingProvider = { healthCheck: async () => ({ ok: true }), unload: async () => {},
    inspectFrame: async () => ({ findings: [], detectedText: '' }) };
  const genericStarted = Date.now();
  const generic = await new VisualRiskService({ config: genericConfig, provider: countingProvider,
    ocrProvider: { close: () => {} }, sampler, cache: new VisualFindingCache() }).analyze(
      path.join(newsRoot, `${video.id}.mp4`), workDir, { metadata: { videoId: video.id }, transcriptSegments }, judgments);
  const genericRoute = { runtimeMs: Date.now() - genericStarted, framesSampled: generic.metrics.framesSampled,
    gemmaCalls: generic.metrics.gemmaCalls, safeWindowSegments: generic.framesBySegment.length };
  const provider = new OllamaVisualProvider(config);
  const ocr = new RapidOcrProvider();
  const service = new VisualRiskService({ config, provider, ocrProvider: ocr, sampler,
    cache: new VisualFindingCache({ maxEntries: config.cacheMaxEntries }), textModel: 'qwen3:14b' });
  const beforeVramMiB = await probeVram();
  let peakVramMiB = beforeVramMiB;
  const monitor = setInterval(async () => { const current = await probeVram(); if (Number.isFinite(current)) peakVramMiB = Math.max(peakVramMiB || 0, current); }, 400);
  const started = Date.now();
  try {
    const result = await service.analyze(path.join(newsRoot, `${video.id}.mp4`), workDir,
      { metadata: { videoId: video.id }, transcriptSegments }, judgments);
    const runtimeMs = Date.now() - started;
    const frames = result.framesBySegment.flat();
    const gemmaReasons = Object.fromEntries(Object.entries(frames.filter(frame => frame.whyGemmaCalled)
      .reduce((counts, frame) => { counts[frame.whyGemmaCalled] = (counts[frame.whyGemmaCalled] || 0) + 1; return counts; }, {})));
    const reviewFrames = result.framesBySegment.flat().filter(frame => frame.findings.length || frame.ocrRequiredUnavailable).length;
    return { skipped: false, videoId: video.id, durationSeconds: video.durationSeconds, runtimeMs,
      targetMet: runtimeMs <= 120000, reviewFrames, safeWindowSegments: result.framesBySegment.length - new Set(result.framesBySegment.flatMap((frames, index) => frames.some(frame => frame.findings.length || frame.ocrRequiredUnavailable) ? [index] : [])).size,
      genericRoute, measuredGemmaReductionPercent: Number(((1 - result.metrics.gemmaCalls / genericRoute.gemmaCalls) * 100).toFixed(1)),
      vram: { beforeMiB: beforeVramMiB, peakMiB: peakVramMiB }, visualStatus: result.visualStatus,
      visualError: result.visualError, ocrStatus: result.ocrStatus, ocrError: result.ocrError, gemmaReasons, metrics: result.metrics };
  } finally { clearInterval(monitor); }
}

async function main() {
  const missingNews = manifest.videos.filter(video => !fs.existsSync(path.join(newsRoot, `${video.id}.mp4`)));
  const missingOcr = ocrCases.filter(([, id]) => !fs.existsSync(path.join(stressRoot, `${id}.mp4`)));
  if (missingNews.length || missingOcr.length) throw new Error(`Missing local proxies: ${[...missingNews.map(v => v.id), ...missingOcr.map(v => v[1])].join(', ')}`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-4-news-benchmark-'));
  const sampler = new VisualSamplingService({ ffmpegPath: ffmpeg, runProcess, config });
  const ocr = new RapidOcrProvider();
  const started = Date.now();
  try {
    const health = await ocr.healthCheck();
    if (!health.ok) throw Object.assign(new Error(health.message), { code: health.code });
    const ocrVramBeforeMiB = await probeVram();
    const coldStarted = Date.now();
    await ocr.start();
    const coldStartMs = Date.now() - coldStarted;
    const classification = await classificationBenchmark(sampler, ocr, workDir);
    const ocrResult = await ocrBenchmark(sampler, ocr, workDir, coldStartMs);
    const ocrVramAfterMiB = await probeVram();
    ocr.close();
    const longRealVideo = await longRealRun(sampler, workDir);
    const result = { generatedAt: new Date().toISOString(), corpusSize: manifest.videos.length,
      sourceMediaCommitted: false, runtimeMs: Date.now() - started, routing: routingBenchmark(), classification,
      ocr: { ...ocrResult, device: 'CPU/ONNX Runtime', gpuMemoryDeltaMiB: Number.isFinite(ocrVramBeforeMiB) && Number.isFinite(ocrVramAfterMiB) ? ocrVramAfterMiB - ocrVramBeforeMiB : null },
      longRealVideo };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ outputPath, corpusSize: result.corpusSize, routing: result.routing,
      classification: { labels: classification.labels, matched: classification.matched, unknown: classification.unknown },
      ocr: { cases: result.ocr.cases, useful: result.ocr.useful, status: result.ocr.status, meanWallMs: result.ocr.meanWallMs }, longRealVideo }, null, 2));
  } finally { ocr.close(); await removeTree(workDir); }
}

main().catch(error => { console.error(JSON.stringify({ code: error.code || 'NEWS_VISUAL_BENCHMARK_FAILED', message: error.message })); process.exitCode = 1; });
