const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('../../config/visual-risk.json').visualRisk;
const { OllamaVisualProvider, VisualModelError } = require('./provider');
const { RapidOcrProvider } = require('./rapidOcr');
const {
  NEWS_SCENE_TYPES, classifyNewsScene, hashText, normalizeOcrOutput, refineTextScene,
  screenOcrRisk, shouldRunGemma
} = require('./news');

function loadVisualRiskConfig(overrides = {}) {
  const config = {
    ...defaults, ...overrides,
    baseUrl: process.env.VISUAL_MODEL_SERVER_URL || overrides.baseUrl || defaults.baseUrl,
    model: process.env.VISUAL_MODEL || overrides.model || defaults.model
  };
  if (!Number.isInteger(config.proxyHeight) || config.proxyHeight < 240 || config.proxyHeight > 720) throw new TypeError('proxyHeight must be from 240 to 720.');
  if (!Number.isInteger(config.frameWidth) || !Number.isInteger(config.frameHeight)) throw new TypeError('Frame dimensions must be integers.');
  if (!Number.isFinite(config.newsAnchorRefreshSeconds) || config.newsAnchorRefreshSeconds < 15) throw new TypeError('newsAnchorRefreshSeconds must be at least 15.');
  if (!Number.isFinite(config.ocrMinimumConfidence) || config.ocrMinimumConfidence < 0 || config.ocrMinimumConfidence > 1) throw new TypeError('ocrMinimumConfidence must be from 0 to 1.');
  return Object.freeze(config);
}

function samplePositions(segment, profile = null) {
  const start = Number(segment.startSeconds);
  const duration = Math.max(0.1, Number(segment.endSeconds) - start);
  const count = profile && (duration <= 15 ? profile.short : duration <= 30 ? profile.medium : profile.long);
  const fractions = count
    ? Array.from({ length: count }, (_, index) => (index + 1) / (count + 1))
    : duration <= 15 ? [0.25, 0.75] : duration <= 30 ? [0.15, 0.5, 0.85] : [0.1, 0.37, 0.63, 0.9];
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

function overlayHash(bytes, width, height) {
  const startRow = Math.floor(height * 0.62);
  return perceptualHash(bytes.subarray(startRow * width * 3), width, height - startRow);
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
  constructor({ config = loadVisualRiskConfig(), sampler, provider, ocrProvider, cache, textModel } = {}) {
    this.config = config; this.sampler = sampler; this.provider = provider || new OllamaVisualProvider(config);
    this.ocrProvider = ocrProvider || new RapidOcrProvider();
    this.cache = cache || new VisualFindingCache({ maxEntries: config.cacheMaxEntries }); this.textModel = textModel;
  }
  async analyze(proxyPath, workDir, ingestion, textJudgments, { onStage = () => {}, signal } = {}) {
    const started = Date.now();
    const sceneTypeCounts = Object.fromEntries(Object.values(NEWS_SCENE_TYPES).map(type => [type, 0]));
    const metrics = {
      framesSampled: 0, framesDeduplicated: 0, framesCheapScanned: 0, framesEscalated: 0,
      ocrCalls: 0, ocrFrames: 0, ocrUsefulFrames: 0, ocrDuplicateSkips: 0,
      vlmCalls: 0, gemmaCalls: 0, gemmaCallsSkippedByAnchorReuse: 0,
      visualCacheHits: 0, visualAnalysisMs: 0, newsVisualMs: 0, sceneTypeCounts,
      anchorSegments: 0, brollSegments: 0, documentSegments: 0, textHeavySegments: 0
    };
    onStage('visual_sampling');
    const cuts = await this.sampler.sceneCuts(proxyPath, signal);
    const representatives = [];
    const output = [];
    const seenText = new Set();
    const seenOcr = new Set();
    let sceneState = null;
    let modelChecked = false;
    let modelAvailable = true;
    let unavailableCode = null;
    let ocrChecked = false;
    let ocrAvailable = Boolean(this.config.ocrEnabled);
    let ocrUnavailableCode = this.config.ocrEnabled ? null : 'OCR_DISABLED';
    try {
      for (let segmentIndex = 0; segmentIndex < ingestion.transcriptSegments.length; segmentIndex++) {
        const segment = ingestion.transcriptSegments[segmentIndex];
        const timestamps = preferSceneCuts(samplePositions(segment), cuts, this.config.sceneWindowSeconds);
        const frameResults = [];
        const segmentTypes = new Set();
        for (let frameIndex = 0; frameIndex < timestamps.length; frameIndex++) {
          if (signal?.aborted) throw new VisualModelError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
          const timestamp = timestamps[frameIndex];
          metrics.framesSampled++;
          const rawPath = path.join(workDir, `frame-${segmentIndex}-${frameIndex}.rgb`);
          const bytes = await this.sampler.extractRaw(proxyPath, timestamp, rawPath, signal);
          this.sampler.fs.rmSync(rawPath, { force: true });
          const frameHash = perceptualHash(bytes, this.config.frameWidth, this.config.frameHeight);
          const currentOverlayHash = overlayHash(bytes, this.config.frameWidth, this.config.frameHeight);
          const cheapSignals = cheapScan(bytes, this.config.frameWidth, this.config.frameHeight, this.config);
          metrics.framesCheapScanned++;
          const hashDistance = sceneState ? hammingDistance(sceneState.representativeHash, frameHash) : null;
          const overlayDistance = sceneState ? hammingDistance(sceneState.overlayHash, currentOverlayHash) : null;
          const nearCut = cuts.some(cut => Math.abs(cut - timestamp) <= this.config.sceneWindowSeconds);
          const sceneChanged = nearCut || (hashDistance !== null && hashDistance > this.config.newsStateHashDistance);
          const overlayChanged = overlayDistance !== null && overlayDistance > this.config.newsOverlayHashDistance;
          let sceneType = this.config.newsOptimizationEnabled
            ? classifyNewsScene({ signals: cheapSignals, hashDistance, overlayDistance, sceneCut: nearCut, config: this.config })
            : NEWS_SCENE_TYPES.UNKNOWN;
          const duplicate = !sceneChanged && !overlayChanged
            ? representatives.find(item => hammingDistance(item.frameHash, frameHash) <= this.config.dedupeHammingDistance)
            : null;
          if (duplicate) {
            metrics.framesDeduplicated++;
            if ([NEWS_SCENE_TYPES.ANCHOR, NEWS_SCENE_TYPES.INTERVIEW].includes(sceneType)) metrics.gemmaCallsSkippedByAnchorReuse++;
            sceneTypeCounts[sceneType]++;
            segmentTypes.add(sceneType);
            const result = {
              ...duplicate.result, timestamp, frameId: `${ingestion.metadata.videoId}-${timestamp.toFixed(3)}`,
              sceneType, sceneStateId: sceneState?.sceneStateId || duplicate.result.sceneStateId,
              deduplicatedFrom: duplicate.result.frameId, whyGemmaSkipped: 'perceptual duplicate'
            };
            frameResults.push(result);
            sceneState = { ...sceneState, representativeHash: frameHash, overlayHash: currentOverlayHash, timestamp };
            continue;
          }

          const textJudgment = textJudgments[segmentIndex];
          const textNeedsVision = textJudgment?.requiresVisualReview || (textJudgment?.categories || []).some(category => ['weapons', 'graphic_content', 'shocking_content', 'nudity', 'sexual_content', 'violence', 'self_harm'].includes(category));
          let jpegPath = null;
          const ensureJpeg = async () => {
            if (!jpegPath) {
              jpegPath = path.join(workDir, `frame-${segmentIndex}-${frameIndex}.jpg`);
              await this.sampler.extractJpeg(proxyPath, timestamp, jpegPath, signal);
            }
            return jpegPath;
          };
          let ocr = null;
          let whyOcrCalled = null;
          let stablePresenter = [NEWS_SCENE_TYPES.ANCHOR, NEWS_SCENE_TYPES.INTERVIEW].includes(sceneType);
          const shouldOcr = this.config.ocrEnabled && cheapSignals.textHeavy
            && (!stablePresenter || overlayChanged || !sceneState?.ocrHash);
          if (shouldOcr) {
            whyOcrCalled = sceneChanged || overlayChanged ? 'new text or overlay' : 'text-heavy frame';
            if (!ocrChecked) {
              ocrChecked = true;
              const health = await this.ocrProvider.healthCheck({ signal });
              ocrAvailable = health.ok;
              ocrUnavailableCode = health.code || null;
            }
            if (ocrAvailable) {
              try {
                metrics.ocrCalls++; metrics.ocrFrames++;
                const rawOcr = await this.ocrProvider.inspectFrame(await ensureJpeg(), timestamp, { signal });
                ocr = normalizeOcrOutput(rawOcr, timestamp, seenOcr, this.config.ocrMinimumConfidence);
                if (ocr.normalizedText) metrics.ocrUsefulFrames++;
                if (ocr.duplicate) metrics.ocrDuplicateSkips++;
                ocr.risk = ocr.duplicate ? { requiresJudge: false, categories: [], duplicate: true } : screenOcrRisk(ocr.normalizedText);
                sceneType = refineTextScene(sceneType, ocr, cheapSignals);
                stablePresenter = [NEWS_SCENE_TYPES.ANCHOR, NEWS_SCENE_TYPES.INTERVIEW].includes(sceneType);
              } catch (ocrError) {
                if (ocrError.code === 'ANALYSIS_CANCELLED') throw new VisualModelError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
                ocrAvailable = false; ocrUnavailableCode = ocrError.code || 'OCR_UNAVAILABLE';
              }
            }
          }
          sceneTypeCounts[sceneType]++;
          segmentTypes.add(sceneType);
          const ocrRequiredUnavailable = cheapSignals.textHeavy && !ocrAvailable;
          const presenterContinues = stablePresenter && [NEWS_SCENE_TYPES.ANCHOR, NEWS_SCENE_TYPES.INTERVIEW].includes(sceneState?.sceneType);
          const semanticSceneChanged = presenterContinues ? false : sceneChanged;
          // Presenter captions are handled by OCR; changing neutral text must not wake Gemma.
          const semanticOverlayChanged = presenterContinues ? false : overlayChanged;
          const gemmaReason = shouldRunGemma({
            sceneType, cheapSignals, textNeedsVision, riskyOcr: Boolean(ocr?.risk?.requiresJudge),
            ocrUnavailable: ocrRequiredUnavailable, previousState: semanticSceneChanged ? null : sceneState,
            timestamp, sceneChanged: semanticSceneChanged, overlayChanged: semanticOverlayChanged,
            middleFrame: frameIndex === Math.floor(timestamps.length / 2), config: this.config
          });
          if (!gemmaReason && stablePresenter) metrics.gemmaCallsSkippedByAnchorReuse++;
          const key = visualCacheKey({ videoId: ingestion.metadata.videoId, timestamp, frameHash, config: this.config });
          const cached = this.cache.get(key);
          let findings = [];
          let detectedText = ocr?.normalizedText || '';
          let error = null;
          let semanticReviewed = false;
          let whyGemmaSkipped = gemmaReason ? null : stablePresenter ? 'stable anchor state' : 'OCR-primary or low-value frame';
          if (cached && gemmaReason) {
            metrics.visualCacheHits++;
            ({ findings, error } = cached);
            detectedText ||= cached.detectedText || '';
            semanticReviewed = true;
            whyGemmaSkipped = 'visual finding cache hit';
          } else if (gemmaReason) {
            metrics.framesEscalated++;
            if (!modelChecked) {
              modelChecked = true;
              const health = await this.provider.healthCheck({ signal });
              modelAvailable = health.ok;
              unavailableCode = health.code || null;
              if (modelAvailable) await this.provider.unload(this.textModel, { signal });
            }
            if (modelAvailable) {
              try {
                metrics.vlmCalls++; metrics.gemmaCalls++;
                const inspected = await this.provider.inspectFrame(await ensureJpeg(), cheapSignals, { signal });
                findings = inspected.findings.filter(item => item.applies && item.category !== 'on_screen_text_risk');
                detectedText ||= normalizeOcr(inspected.detectedText, seenText);
                semanticReviewed = true;
              } catch (providerError) {
                if (providerError.code === 'ANALYSIS_CANCELLED') throw providerError;
                error = providerError.code || 'VISUAL_MODEL_UNAVAILABLE';
                findings = [{ category: cheapSignals.possibleBlood ? 'blood' : cheapSignals.possibleNudity ? 'nudity' : 'shocking_content', applies: true, confidence: this.config.detectorConfidence, severity: 'uncertain', detail: 'Cheap detector signal could not be verified by the local visual model.', requiresHumanReview: true }];
              }
            } else {
              error = unavailableCode;
              findings = [{ category: cheapSignals.possibleBlood ? 'blood' : cheapSignals.possibleNudity ? 'nudity' : 'shocking_content', applies: true, confidence: this.config.detectorConfidence, severity: 'uncertain', detail: 'Local visual model is not installed or unavailable.', requiresHumanReview: true }];
            }
            if (!error) this.cache.set(key, { findings, detectedText, error: null });
          }
          if (jpegPath) this.sampler.fs.rmSync(jpegPath, { force: true });
          const ocrHash = ocr?.hash || (!overlayChanged ? sceneState?.ocrHash : null);
          const sceneStateId = hashText(`${sceneType}:${frameHash}:${ocrHash || ''}`).slice(0, 16);
          const result = {
            timestamp, frameId: `${ingestion.metadata.videoId}-${timestamp.toFixed(3)}`, frameHash, findings,
            detectedText, onScreenText: ocr?.normalizedText || '', ocr, ocrRequiredUnavailable,
            sceneType, sceneStateId, cheapSignals, error, whyGemmaCalled: gemmaReason,
            whyGemmaSkipped, whyOcrCalled
          };
          representatives.push({ frameHash, result });
          frameResults.push(result);
          sceneState = {
            sceneStateId, sceneType, representativeHash: frameHash, overlayHash: currentOverlayHash,
            ocrHash, lastSemanticReview: semanticReviewed ? timestamp : (semanticSceneChanged ? null : sceneState?.lastSemanticReview), timestamp
          };
        }
        if ([...segmentTypes].some(type => [NEWS_SCENE_TYPES.ANCHOR, NEWS_SCENE_TYPES.INTERVIEW].includes(type))) metrics.anchorSegments++;
        if (segmentTypes.has(NEWS_SCENE_TYPES.B_ROLL)) metrics.brollSegments++;
        if ([...segmentTypes].some(type => [NEWS_SCENE_TYPES.DOCUMENT, NEWS_SCENE_TYPES.SCREENSHOT].includes(type))) metrics.documentSegments++;
        if ([...segmentTypes].some(type => [NEWS_SCENE_TYPES.TEXT_HEAVY, NEWS_SCENE_TYPES.CHART_GRAPHIC].includes(type))) metrics.textHeavySegments++;
        output.push(frameResults);
      }
    } finally {
      await this.provider.unload(this.config.model).catch(() => {});
      this.ocrProvider.close?.();
    }
    metrics.visualAnalysisMs = Date.now() - started;
    metrics.newsVisualMs = metrics.visualAnalysisMs;
    return {
      visualStatus: modelChecked && !modelAvailable ? 'UNAVAILABLE' : 'AVAILABLE', visualError: unavailableCode,
      ocrStatus: ocrChecked ? (ocrAvailable ? 'AVAILABLE' : 'UNAVAILABLE') : (this.config.ocrEnabled ? 'NOT_USED' : 'DISABLED'),
      ocrError: ocrUnavailableCode, framesBySegment: output, metrics
    };
  }
}

module.exports = {
  NEWS_SCENE_TYPES, RapidOcrProvider, VisualFindingCache, VisualMediaService, VisualRiskService, VisualSamplingService,
  cheapScan, classifyNewsScene, hammingDistance, loadVisualRiskConfig, normalizeOcr, ocrRisk, parseSceneCuts,
  normalizeOcrOutput, overlayHash, perceptualHash, preferSceneCuts, refineTextScene, samplePositions,
  screenOcrRisk, shouldRunGemma, visualCacheKey
};
