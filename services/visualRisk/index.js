const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('../../config/visual-risk.json').visualRisk;
const { OllamaVisualProvider, VisualModelError } = require('./provider');

function loadVisualRiskConfig(overrides = {}) {
  const config = {
    ...defaults, ...overrides,
    baseUrl: process.env.VISUAL_MODEL_SERVER_URL || overrides.baseUrl || defaults.baseUrl,
    model: process.env.VISUAL_MODEL || overrides.model || defaults.model
  };
  if (!Number.isInteger(config.proxyHeight) || config.proxyHeight < 240 || config.proxyHeight > 720) throw new TypeError('proxyHeight must be from 240 to 720.');
  if (!Number.isInteger(config.frameWidth) || !Number.isInteger(config.frameHeight)) throw new TypeError('Frame dimensions must be integers.');
  return Object.freeze(config);
}

function samplePositions(segment) {
  const start = Number(segment.startSeconds);
  const duration = Math.max(0.1, Number(segment.endSeconds) - start);
  const fractions = duration <= 15 ? [0.25, 0.75] : duration <= 30 ? [0.15, 0.5, 0.85] : [0.1, 0.37, 0.63, 0.9];
  return fractions.map(fraction => Number((start + duration * fraction).toFixed(3)));
}

function preferSceneCuts(planned, sceneCuts, windowSeconds = 2.5) {
  const used = new Set();
  return planned.map(timestamp => {
    const nearest = sceneCuts
      .filter(cut => !used.has(cut) && Math.abs(cut - timestamp) <= windowSeconds)
      .sort((a, b) => Math.abs(a - timestamp) - Math.abs(b - timestamp))[0];
    if (nearest === undefined) return timestamp;
    used.add(nearest);
    return nearest;
  }).sort((a, b) => a - b);
}

function parseSceneCuts(stderr) {
  return [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)].map(match => Number(match[1])).filter(Number.isFinite);
}

function grayscale(bytes, offset) {
  return Math.round(bytes[offset] * 0.299 + bytes[offset + 1] * 0.587 + bytes[offset + 2] * 0.114);
}

function perceptualHash(bytes, width, height) {
  let bits = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y++) {
    const py = Math.min(height - 1, Math.floor((y + 0.5) * height / 8));
    for (let x = 0; x < 8; x++) {
      const left = (py * width + Math.min(width - 1, Math.floor((x + 0.5) * width / 9))) * 3;
      const right = (py * width + Math.min(width - 1, Math.floor((x + 1.5) * width / 9))) * 3;
      if (grayscale(bytes, left) > grayscale(bytes, right)) bits |= 1n << bit;
      bit++;
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function hammingDistance(a, b) {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value) { count++; value &= value - 1n; }
  return count;
}

function cheapScan(bytes, width, height, config) {
  const pixels = width * height;
  if (!Buffer.isBuffer(bytes) || bytes.length !== pixels * 3) throw new Error('Invalid RGB frame.');
  let red = 0;
  let skin = 0;
  let edges = 0;
  let textEdges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const r = bytes[offset]; const g = bytes[offset + 1]; const b = bytes[offset + 2];
      if (r > 105 && r > g * 1.55 && r > b * 1.35) red++;
      const cb = 128 - 0.169 * r - 0.331 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.419 * g - 0.081 * b;
      if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) skin++;
      if (x) {
        const delta = Math.abs(grayscale(bytes, offset) - grayscale(bytes, offset - 3));
        if (delta > 48) edges++;
        if (delta > 72 && y > height * 0.15 && y < height * 0.9) textEdges++;
      }
    }
  }
  const signals = {
    redRatio: red / pixels,
    skinRatio: skin / pixels,
    edgeDensity: edges / Math.max(1, pixels - height),
    textDensity: textEdges / Math.max(1, pixels - height)
  };
  signals.possibleBlood = signals.redRatio >= config.redRatioThreshold;
  signals.possibleNudity = signals.skinRatio >= config.skinRatioThreshold;
  signals.complexObject = signals.edgeDensity >= config.edgeDensityThreshold;
  signals.textHeavy = signals.textDensity >= config.textEdgeThreshold;
  signals.escalate = signals.possibleBlood || signals.possibleNudity || signals.complexObject || signals.textHeavy;
  return signals;
}

function normalizeOcr(text, seen = new Set()) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (key.length < 3 || seen.has(key)) return '';
  seen.add(key);
  return value.slice(0, 500);
}

function ocrRisk(text) {
  return /\b(?:kill|shoot|suicide method|how to die|buy (?:a )?gun|weapon for sale|drug(?:s)? for sale|address|phone number|doxx?|racial slur)\b/i.test(text);
}

function visualCacheKey({ videoId, timestamp, frameHash, config }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    videoId, timestamp, frameHash, detectorVersion: config.detectorVersion,
    modelVersion: config.modelVersion, thresholdVersion: config.thresholdVersion
  })).digest('hex');
}

class VisualFindingCache {
  constructor({ filePath = null, maxEntries = 20000, fileSystem = fs } = {}) {
    this.filePath = filePath; this.maxEntries = maxEntries; this.fs = fileSystem; this.entries = new Map();
    if (filePath && fileSystem.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
        if (parsed.version === 1) Object.entries(parsed.entries || {}).forEach(([key, value]) => this.entries.set(key, value));
      } catch (_) { this.entries.clear(); }
    }
  }
  get(key) { return this.entries.get(key) || null; }
  set(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    if (!this.filePath) return;
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    this.fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }), 'utf8');
    this.fs.renameSync(temp, this.filePath);
  }
}

class VisualMediaService {
  constructor({ tempRoot, downloadProxy, fileSystem = fs } = {}) {
    if (!path.isAbsolute(tempRoot)) throw new TypeError('Visual temp root must be absolute.');
    this.tempRoot = path.resolve(tempRoot); this.downloadProxy = downloadProxy; this.fs = fileSystem;
  }
  cleanupStale() {
    this.fs.mkdirSync(this.tempRoot, { recursive: true });
    for (const entry of this.fs.readdirSync(this.tempRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('analysis-')) this.fs.rmSync(path.join(this.tempRoot, entry.name), { recursive: true, force: true });
    }
  }
  async withProxy(ingestion, options, operation) {
    this.fs.mkdirSync(this.tempRoot, { recursive: true });
    const workDir = this.fs.mkdtempSync(path.join(this.tempRoot, 'analysis-'));
    try {
      const proxyPath = await this.downloadProxy(ingestion.metadata.url, workDir, options.signal);
      return await operation(proxyPath, workDir);
    } finally {
      this.fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

class VisualSamplingService {
  constructor({ ffmpegPath, runProcess, config = loadVisualRiskConfig(), fileSystem = fs } = {}) {
    this.ffmpegPath = ffmpegPath; this.run = runProcess; this.config = config; this.fs = fileSystem;
  }
  async sceneCuts(proxyPath, signal) {
    const result = await this.run(this.ffmpegPath, ['-hide_banner', '-i', proxyPath, '-vf', `select='gt(scene,${this.config.sceneThreshold})',showinfo`, '-an', '-f', 'null', '-'], { timeoutMs: 0, signal });
    if (result.cancelled) throw new VisualModelError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
    return result.ok ? parseSceneCuts(result.stderr) : [];
  }
  async extractRaw(proxyPath, timestamp, outputPath, signal) {
    const result = await this.run(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', proxyPath, '-frames:v', '1', '-vf', `scale=${this.config.frameWidth}:${this.config.frameHeight}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', outputPath], { timeoutMs: 30000, signal });
    if (result.cancelled) throw new VisualModelError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
    if (!result.ok) throw new Error(`Frame extraction failed: ${result.error}`);
    return this.fs.readFileSync(outputPath);
  }
  async extractJpeg(proxyPath, timestamp, outputPath, signal) {
    const result = await this.run(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', proxyPath, '-frames:v', '1', '-vf', `scale=${this.config.frameWidth}:-2`, '-q:v', '4', '-y', outputPath], { timeoutMs: 30000, signal });
    if (result.cancelled) throw new VisualModelError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
    if (!result.ok) throw new Error(`Frame extraction failed: ${result.error}`);
  }
}

class VisualRiskService {
  constructor({ config = loadVisualRiskConfig(), sampler, provider, cache, textModel } = {}) {
    this.config = config; this.sampler = sampler; this.provider = provider || new OllamaVisualProvider(config);
    this.cache = cache || new VisualFindingCache({ maxEntries: config.cacheMaxEntries }); this.textModel = textModel;
  }
  async analyze(proxyPath, workDir, ingestion, textJudgments, { onStage = () => {}, signal } = {}) {
    const started = Date.now();
    const metrics = { framesSampled: 0, framesDeduplicated: 0, framesCheapScanned: 0, framesEscalated: 0, ocrCalls: 0, vlmCalls: 0, visualCacheHits: 0, visualAnalysisMs: 0 };
    onStage('visual_sampling');
    const cuts = await this.sampler.sceneCuts(proxyPath, signal);
    const representatives = [];
    const output = [];
    const seenText = new Set();
    let modelChecked = false;
    let modelAvailable = true;
    let unavailableCode = null;
    for (let segmentIndex = 0; segmentIndex < ingestion.transcriptSegments.length; segmentIndex++) {
      const segment = ingestion.transcriptSegments[segmentIndex];
      const timestamps = preferSceneCuts(samplePositions(segment), cuts, this.config.sceneWindowSeconds);
      const frameResults = [];
      for (let frameIndex = 0; frameIndex < timestamps.length; frameIndex++) {
        if (signal?.aborted) throw new VisualModelError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
        const timestamp = timestamps[frameIndex];
        metrics.framesSampled++;
        const rawPath = path.join(workDir, `frame-${segmentIndex}-${frameIndex}.rgb`);
        const bytes = await this.sampler.extractRaw(proxyPath, timestamp, rawPath, signal);
        this.sampler.fs.rmSync(rawPath, { force: true });
        const frameHash = perceptualHash(bytes, this.config.frameWidth, this.config.frameHeight);
        const duplicate = representatives.find(item => hammingDistance(item.frameHash, frameHash) <= this.config.dedupeHammingDistance);
        if (duplicate) {
          metrics.framesDeduplicated++;
          frameResults.push({ ...duplicate.result, timestamp, frameId: `${ingestion.metadata.videoId}-${timestamp.toFixed(3)}`, deduplicatedFrom: duplicate.result.frameId });
          continue;
        }
        const cheapSignals = cheapScan(bytes, this.config.frameWidth, this.config.frameHeight, this.config);
        metrics.framesCheapScanned++;
        const textJudgment = textJudgments[segmentIndex];
        const textNeedsVision = textJudgment?.requiresVisualReview || (textJudgment?.categories || []).some(category => ['weapons', 'graphic_content', 'shocking_content', 'nudity', 'sexual_content', 'violence', 'self_harm'].includes(category));
        const escalate = cheapSignals.escalate || textNeedsVision || frameIndex === Math.floor(timestamps.length / 2);
        const key = visualCacheKey({ videoId: ingestion.metadata.videoId, timestamp, frameHash, config: this.config });
        let cached = this.cache.get(key);
        let findings = [];
        let detectedText = '';
        let error = null;
        if (cached) {
          metrics.visualCacheHits++;
          ({ findings, detectedText, error } = cached);
        } else if (escalate) {
          metrics.framesEscalated++;
          if (!modelChecked) {
            modelChecked = true;
            const health = await this.provider.healthCheck({ signal });
            modelAvailable = health.ok;
            unavailableCode = health.code || null;
            if (modelAvailable) await this.provider.unload(this.textModel, { signal });
          }
          if (modelAvailable) {
            const jpegPath = path.join(workDir, `frame-${segmentIndex}-${frameIndex}.jpg`);
            await this.sampler.extractJpeg(proxyPath, timestamp, jpegPath, signal);
            try {
              metrics.vlmCalls++;
              if (cheapSignals.textHeavy) metrics.ocrCalls++;
              const inspected = await this.provider.inspectFrame(jpegPath, cheapSignals, { signal });
              findings = inspected.findings.filter(item => item.applies);
              detectedText = normalizeOcr(inspected.detectedText, seenText);
              if (detectedText && ocrRisk(detectedText) && !findings.some(item => item.category === 'on_screen_text_risk')) {
                findings.push({ category: 'on_screen_text_risk', applies: true, confidence: 0.75, severity: 'uncertain', detail: detectedText, requiresHumanReview: true });
              }
            } catch (providerError) {
              if (providerError.code === 'ANALYSIS_CANCELLED') throw providerError;
              error = providerError.code || 'VISUAL_MODEL_UNAVAILABLE';
              findings = [{ category: cheapSignals.possibleBlood ? 'blood' : cheapSignals.possibleNudity ? 'nudity' : 'shocking_content', applies: true, confidence: this.config.detectorConfidence, severity: 'uncertain', detail: 'Cheap detector signal could not be verified by the local visual model.', requiresHumanReview: true }];
            } finally { this.sampler.fs.rmSync(jpegPath, { force: true }); }
          } else {
            error = unavailableCode;
            findings = [{ category: cheapSignals.possibleBlood ? 'blood' : cheapSignals.possibleNudity ? 'nudity' : 'shocking_content', applies: true, confidence: this.config.detectorConfidence, severity: 'uncertain', detail: 'Local visual model is not installed or unavailable.', requiresHumanReview: true }];
          }
          if (!error) this.cache.set(key, { findings, detectedText, error: null });
        }
        const result = { timestamp, frameId: `${ingestion.metadata.videoId}-${timestamp.toFixed(3)}`, frameHash, findings, detectedText, cheapSignals, error };
        representatives.push({ frameHash, result });
        frameResults.push(result);
      }
      output.push(frameResults);
    }
    await this.provider.unload(this.config.model, { signal });
    metrics.visualAnalysisMs = Date.now() - started;
    return { visualStatus: modelChecked && !modelAvailable ? 'UNAVAILABLE' : 'AVAILABLE', visualError: unavailableCode, framesBySegment: output, metrics };
  }
}

module.exports = {
  VisualFindingCache, VisualMediaService, VisualRiskService, VisualSamplingService,
  cheapScan, hammingDistance, loadVisualRiskConfig, normalizeOcr, ocrRisk, parseSceneCuts,
  perceptualHash, preferSceneCuts, samplePositions, visualCacheKey
};
