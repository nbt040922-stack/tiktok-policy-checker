const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPolicySet } = require('../services/policyKnowledge');
const { mergeVisualFindings } = require('../services/policyJudge/decisionEngine');
const { PolicyJudgeService, loadPolicyJudgeConfig } = require('../services/policyJudge');
const {
  NEWS_SCENE_TYPES, RapidOcrProvider, VisualFindingCache, VisualMediaService, VisualRiskService,
  cheapScan, hammingDistance, loadVisualRiskConfig, normalizeOcr, normalizeOcrOutput,
  parseSceneCuts, perceptualHash, preferSceneCuts, refineTextScene, samplePositions,
  screenOcrRisk, shouldRunGemma, visualCacheKey
} = require('../services/visualRisk');
const { classifyNewsScene } = require('../services/visualRisk/news');
const { validateOutput, VisualModelError } = require('../services/visualRisk/provider');

const config = overrides => loadVisualRiskConfig({ frameWidth: 16, frameHeight: 8, ...overrides });
const segment = (start, end) => ({ startSeconds: start, endSeconds: end, text: 'fixture' });
const baseJudgment = overrides => ({
  id: 'segment-1', decision: 'KEEP', decisionSource: 'PRECHECK', confidence: 1,
  policyIds: [], categories: [], requiresVisualReview: false, contextType: 'neutral',
  mappingReason: 'NEUTRAL_PRECHECK', reason: 'neutral', ...overrides
});
const finding = overrides => ({
  category: 'weapon', applies: true, confidence: 0.9, severity: 'visible',
  detail: 'firearm-like object visible', requiresHumanReview: false, timestamp: 2, frameId: 'f1', ...overrides
});

test('frame sampling uses 2, 3, and 4 early/middle/late positions', () => {
  assert.equal(samplePositions(segment(0, 15)).length, 2);
  assert.deepEqual(samplePositions(segment(10, 30)), [13, 20, 27]);
  assert.equal(samplePositions(segment(0, 45)).length, 4);
});

test('aggressive frame sampling uses configured 3, 5, and 7 positions', () => {
  const profile = { short: 3, medium: 5, long: 7 };
  assert.equal(samplePositions(segment(0, 10), profile).length, 3);
  assert.equal(samplePositions(segment(0, 20), profile).length, 5);
  assert.equal(samplePositions(segment(0, 40), profile).length, 7);
});

test('scene cuts replace only nearby planned samples', () => {
  assert.deepEqual(preferSceneCuts([2, 10, 18], [1.5, 12, 18.2], 1), [1.5, 10, 18.2]);
  assert.deepEqual(parseSceneCuts('showinfo pts_time:1.25 x\nshowinfo pts_time:9.5 x'), [1.25, 9.5]);
});

test('perceptual hash deduplicates near-identical frames', () => {
  const bytes = Buffer.alloc(16 * 8 * 3, 120);
  const same = Buffer.from(bytes); same[0] = 121;
  const a = perceptualHash(bytes, 16, 8); const b = perceptualHash(same, 16, 8);
  assert.ok(hammingDistance(a, b) <= 1);
});

test('cheap thresholds escalate signals without claiming a violation', () => {
  const red = Buffer.alloc(16 * 8 * 3);
  for (let index = 0; index < red.length; index += 3) red[index] = 220;
  const result = cheapScan(red, 16, 8, config({ redRatioThreshold: 0.2 }));
  assert.equal(result.possibleBlood, true);
  assert.equal(Object.hasOwn(result, 'findings'), false);
});

test('OCR normalization deduplicates repeated captions', () => {
  const seen = new Set();
  assert.equal(normalizeOcr('  WEAPON   FOR SALE ', seen), 'WEAPON FOR SALE');
  assert.equal(normalizeOcr('weapon for sale', seen), '');
});

test('news scene classifier is conservative across anchor and B-roll transitions', () => {
  const cfg = config();
  const anchorSignals = { textHeavy: false, skinRatio: 0.06, complexObject: false };
  assert.equal(classifyNewsScene({ signals: anchorSignals, hashDistance: 4, overlayDistance: 2, sceneCut: false, config: cfg }), NEWS_SCENE_TYPES.ANCHOR);
  assert.equal(classifyNewsScene({ signals: anchorSignals, hashDistance: 30, overlayDistance: 12, sceneCut: false, config: cfg }), NEWS_SCENE_TYPES.B_ROLL);
  assert.equal(classifyNewsScene({ signals: anchorSignals, hashDistance: 3, overlayDistance: 1, sceneCut: false, config: cfg }), NEWS_SCENE_TYPES.ANCHOR);
  assert.equal(classifyNewsScene({ signals: { textHeavy: false, skinRatio: 0, complexObject: false }, hashDistance: null, overlayDistance: null, sceneCut: false, config: cfg }), NEWS_SCENE_TYPES.UNKNOWN);
});

test('text scenes distinguish documents, screenshots, and charts after OCR', () => {
  const ocr = text => ({ normalizedText: text, lines: text.split('|').map(value => ({ text: value })) });
  assert.equal(refineTextScene(NEWS_SCENE_TYPES.TEXT_HEAVY, ocr('Posted by @reporter|Breaking update|Source')), NEWS_SCENE_TYPES.SCREENSHOT);
  assert.equal(refineTextScene(NEWS_SCENE_TYPES.TEXT_HEAVY, ocr('one|two|three|four|five|six|seven')), NEWS_SCENE_TYPES.DOCUMENT);
  assert.equal(refineTextScene(NEWS_SCENE_TYPES.TEXT_HEAVY, ocr('Revenue $20|Growth 12%|2025 18|2026 22')), NEWS_SCENE_TYPES.CHART_GRAPHIC);
});

test('OCR schema normalization removes duplicate lines and repeated overlays', () => {
  const seen = new Set();
  const raw = { lines: [
    { text: ' BREAKING   NEWS ', confidence: 0.99, box: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    { text: 'breaking news', confidence: 0.98, box: [] },
    { text: 'x', confidence: 0.1, box: [] }
  ] };
  const first = normalizeOcrOutput(raw, 12.4, seen, 0.5);
  const second = normalizeOcrOutput(raw, 42.4, seen, 0.5);
  assert.equal(first.normalizedText, 'BREAKING NEWS'); assert.equal(first.lines.length, 1);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
});

test('OCR risk prefilter keeps neutral news topics and flags action or privacy evidence', () => {
  assert.equal(screenOcrRisk('SUICIDE PREVENTION PROGRAM EXPANDS').requiresJudge, false);
  assert.equal(screenOcrRisk('POLICE RECOVER FIREARMS').requiresJudge, false);
  assert.equal(screenOcrRisk('REPORT EXAMINES HATE SPEECH').requiresJudge, false);
  assert.equal(screenOcrRisk('I WILL KILL YOU').requiresJudge, true);
  const privacy = screenOcrRisk('Contact source@example.com or +1 202 555 0198');
  assert.equal(privacy.requiresJudge, true); assert.ok(privacy.categories.includes('personal_information'));
});

test('Gemma skip logic reuses anchors and escalates transitions, risky OCR, and UNKNOWN', () => {
  const cfg = config();
  const base = { cheapSignals: { possibleBlood: false, possibleNudity: false, escalate: false }, textNeedsVision: false, riskyOcr: false, ocrUnavailable: false, previousState: { lastSemanticReview: 10 }, timestamp: 20, sceneChanged: false, overlayChanged: false, middleFrame: false, config: cfg };
  assert.equal(shouldRunGemma({ ...base, sceneType: NEWS_SCENE_TYPES.ANCHOR }), null);
  assert.match(shouldRunGemma({ ...base, sceneType: NEWS_SCENE_TYPES.B_ROLL, sceneChanged: true }), /B-roll/);
  assert.match(shouldRunGemma({ ...base, sceneType: NEWS_SCENE_TYPES.ANCHOR, overlayChanged: true }), /invalidated/);
  assert.match(shouldRunGemma({ ...base, sceneType: NEWS_SCENE_TYPES.TEXT_HEAVY, riskyOcr: true }), /on-screen text/);
  assert.match(shouldRunGemma({ ...base, sceneType: NEWS_SCENE_TYPES.UNKNOWN, middleFrame: true }), /UNKNOWN/);
});

test('missing RapidOCR environment reports unavailable without touching Electron dependencies', async () => {
  const provider = new RapidOcrProvider({ pythonPath: path.join(os.tmpdir(), 'missing-python.exe'), usePackaged: false });
  assert.deepEqual(await provider.healthCheck(), { ok: false, code: 'OCR_UNAVAILABLE', message: 'RapidOCR worker environment is unavailable.' });
});

test('visual finding schema rejects verdicts, extras, and invalid categories', () => {
  const valid = { findings: [finding()], detectedText: '' };
  delete valid.findings[0].timestamp; delete valid.findings[0].frameId;
  assert.equal(validateOutput(valid).findings[0].category, 'weapon');
  assert.throws(() => validateOutput({ ...valid, decision: 'REMOVE' }), /invalid findings/);
  assert.throws(() => validateOutput({ findings: [{ ...valid.findings[0], category: 'face_identity' }], detectedText: '' }), /invalid findings/);
});

test('visual cache key versions detector, model, threshold, frame, and timestamp', () => {
  const one = visualCacheKey({ videoId: 'v', timestamp: 1, frameHash: '00', config: config() });
  const two = visualCacheKey({ videoId: 'v', timestamp: 2, frameHash: '00', config: config() });
  const three = visualCacheKey({ videoId: 'v', timestamp: 1, frameHash: '00', config: config({ thresholdVersion: 'v2' }) });
  assert.notEqual(one, two); assert.notEqual(one, three);
});

test('visual cache persists findings only under format v1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-cache-'));
  const file = path.join(dir, 'cache.json');
  try {
    new VisualFindingCache({ filePath: file }).set('a', { findings: [finding()] });
    assert.equal(new VisualFindingCache({ filePath: file }).get('a').findings.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(file)).version, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('temporary visual media is deleted after success and failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-media-'));
  const media = new VisualMediaService({ tempRoot: root, downloadProxy: async (_url, dir) => { const file = path.join(dir, 'proxy.mp4'); fs.writeFileSync(file, 'x'); return file; } });
  try {
    await media.withProxy({ metadata: { url: 'x' } }, {}, async file => assert.equal(fs.existsSync(file), true));
    assert.equal(fs.readdirSync(root).length, 0);
    await assert.rejects(media.withProxy({ metadata: { url: 'x' } }, {}, async () => { throw new Error('fail'); }), /fail/);
    assert.equal(fs.readdirSync(root).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('startup cleanup removes stale analysis directories only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-stale-'));
  fs.mkdirSync(path.join(root, 'analysis-old')); fs.mkdirSync(path.join(root, 'keep-me'));
  try {
    new VisualMediaService({ tempRoot: root, downloadProxy: async () => '' }).cleanupStale();
    assert.equal(fs.existsSync(path.join(root, 'analysis-old')), false);
    assert.equal(fs.existsSync(path.join(root, 'keep-me')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('weapon, graphic injury, nudity, and uncertainty map deterministically', () => {
  const repository = loadPolicySet(); const cfg = config();
  const weapon = mergeVisualFindings(baseJudgment(), [{ timestamp: 2, frameId: 'f', findings: [finding()] }], repository, cfg);
  assert.equal(weapon.decision, 'REVIEW'); assert.equal(weapon.decisionSource, 'MULTIMODAL_POLICY_ENGINE');
  const graphic = mergeVisualFindings(baseJudgment(), [{ timestamp: 2, frameId: 'f', findings: [finding({ category: 'graphic_injury', severity: 'severe' })] }], repository, cfg);
  assert.equal(graphic.decision, 'REMOVE');
  const nudity = mergeVisualFindings(baseJudgment(), [{ timestamp: 2, frameId: 'f', findings: [finding({ category: 'nudity', severity: 'uncertain', requiresHumanReview: true })] }], repository, cfg);
  assert.equal(nudity.decision, 'REVIEW');
});

test('news context prevents visual weapon or graphic evidence from automatic removal', () => {
  const judgment = baseJudgment({ contextType: 'news_reporting' });
  const merged = mergeVisualFindings(judgment, [{ timestamp: 2, frameId: 'f', findings: [finding({ category: 'graphic_injury', severity: 'severe' })] }], loadPolicySet(), config());
  assert.equal(merged.decision, 'REVIEW');
  assert.deepEqual(merged.evidence.visual[0].category, 'graphic_injury');
});

test('available clear frames resolve text-only visual uncertainty', () => {
  const judgment = baseJudgment({ decision: 'REVIEW', requiresVisualReview: true, mappingReason: 'VISUAL_REVIEW_REQUIRED' });
  const merged = mergeVisualFindings(judgment, [{ timestamp: 2, frameId: 'f', findings: [] }], loadPolicySet(), config());
  assert.equal(merged.decision, 'KEEP'); assert.equal(merged.mappingReason, 'VISUAL_SAMPLE_CLEAR');
});

test('visual failure preserves text result and unresolved visual checks REVIEW', () => {
  const keep = mergeVisualFindings(baseJudgment(), [], loadPolicySet(), config(), 'UNAVAILABLE');
  const review = mergeVisualFindings(baseJudgment({ requiresVisualReview: true }), [], loadPolicySet(), config(), 'UNAVAILABLE');
  assert.equal(keep.decision, 'KEEP'); assert.equal(review.decision, 'REVIEW'); assert.equal(review.visualStatus, 'UNAVAILABLE');
});

test('service deduplicates frames, escalates once, and reuses cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-service-'));
  const cfg = config({ redRatioThreshold: 0.1 });
  const red = Buffer.alloc(cfg.frameWidth * cfg.frameHeight * 3);
  for (let index = 0; index < red.length; index += 3) red[index] = 220;
  const sampler = {
    fs, sceneCuts: async () => [], extractRaw: async (_proxy, _time, file) => { fs.writeFileSync(file, red); return red; },
    extractJpeg: async (_proxy, _time, file) => fs.writeFileSync(file, 'jpg')
  };
  let calls = 0;
  const provider = {
    healthCheck: async () => ({ ok: true }), unload: async () => {},
    inspectFrame: async () => { calls++; return { findings: [], detectedText: '' }; }
  };
  const cache = new VisualFindingCache();
  const service = new VisualRiskService({ config: cfg, sampler, provider, cache, textModel: 'qwen' });
  const ingestion = { metadata: { videoId: 'v' }, transcriptSegments: [segment(0, 10), segment(10, 20)] };
  try {
    const first = await service.analyze('proxy', dir, ingestion, [baseJudgment(), baseJudgment()]);
    assert.equal(first.metrics.framesSampled, 4); assert.equal(first.metrics.framesDeduplicated, 3); assert.equal(calls, 1);
    const second = await service.analyze('proxy', dir, ingestion, [baseJudgment(), baseJudgment()]);
    assert.ok(second.metrics.visualCacheHits >= 1); assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('benign OCR text does not become an on-screen risk finding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-ocr-'));
  const cfg = config({ edgeDensityThreshold: 0 });
  const bytes = Buffer.alloc(cfg.frameWidth * cfg.frameHeight * 3, 80);
  const sampler = {
    fs, sceneCuts: async () => [], extractRaw: async (_proxy, _time, file) => { fs.writeFileSync(file, bytes); return bytes; },
    extractJpeg: async (_proxy, _time, file) => fs.writeFileSync(file, 'jpg')
  };
  const provider = {
    healthCheck: async () => ({ ok: true }), unload: async () => {},
    inspectFrame: async () => ({ findings: [finding({ category: 'on_screen_text_risk', detail: 'NASA' })], detectedText: 'NASA' })
  };
  try {
    const result = await new VisualRiskService({ config: cfg, sampler, provider, cache: new VisualFindingCache() })
      .analyze('proxy', dir, { metadata: { videoId: 'ocr' }, transcriptSegments: [segment(0, 10)] }, [baseJudgment()]);
    assert.deepEqual(result.framesBySegment[0][0].findings, []);
    assert.equal(result.framesBySegment[0][0].detectedText, 'NASA');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stable anchor state reuses semantic review and cuts Gemma calls by at least 60 percent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-anchor-'));
  const cfg = config();
  const bytes = Buffer.alloc(cfg.frameWidth * cfg.frameHeight * 3, 80);
  for (let pixel = 0; pixel < 8; pixel++) bytes.set([200, 150, 120], pixel * 3);
  const sampler = {
    fs, sceneCuts: async () => [], extractRaw: async (_proxy, _time, file) => { fs.writeFileSync(file, bytes); return bytes; },
    extractJpeg: async (_proxy, _time, file) => fs.writeFileSync(file, 'jpg')
  };
  let calls = 0;
  const provider = { healthCheck: async () => ({ ok: true }), unload: async () => {}, inspectFrame: async () => { calls++; return { findings: [], detectedText: '' }; } };
  const ocrProvider = { healthCheck: async () => ({ ok: false, code: 'OCR_UNAVAILABLE' }), close: () => {} };
  try {
    const result = await new VisualRiskService({ config: cfg, sampler, provider, ocrProvider, cache: new VisualFindingCache() })
      .analyze('proxy', dir, { metadata: { videoId: 'anchor' }, transcriptSegments: [segment(0, 30)] }, [baseJudgment({ requiresVisualReview: true })]);
    assert.equal(result.metrics.framesSampled, 3); assert.equal(calls, 1);
    assert.ok(result.metrics.gemmaCallsSkippedByAnchorReuse >= 2);
    assert.ok(1 - calls / result.metrics.framesSampled >= 0.6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing OCR marks material text for REVIEW while visual analysis continues', () => {
  const merged = mergeVisualFindings(baseJudgment(), [{
    timestamp: 2, frameId: 'text-frame', findings: [], ocrRequiredUnavailable: true
  }], loadPolicySet(), config());
  assert.equal(merged.decision, 'REVIEW'); assert.equal(merged.mappingReason, 'OCR_REQUIRED_UNAVAILABLE');
});

test('risky OCR enters policy retrieval without changing spoken transcript', () => {
  const repository = loadPolicySet();
  const service = new PolicyJudgeService({ repository, config: loadPolicyJudgeConfig(), provider: {} });
  const judgment = { ...baseJudgment(), startSeconds: 0, endSeconds: 10, startLabel: '0:00', endLabel: '0:10', transcript: 'Neutral spoken report.' };
  const textResult = {
    segmentJudgments: [judgment], metrics: {}, transcriptSegments: [segment(0, 10)],
    overallDecision: 'KEEP', segments: [judgment], recommendedClips: []
  };
  const ocr = { normalizedText: 'I WILL KILL YOU', duplicate: false, risk: screenOcrRisk('I WILL KILL YOU') };
  const result = service.applyVisualAnalysis(textResult, {
    visualStatus: 'AVAILABLE', ocrStatus: 'AVAILABLE', framesBySegment: [[{ timestamp: 2, frameId: 'ocr-frame', findings: [], ocr }]], metrics: {}
  }, config());
  assert.equal(result.segmentJudgments[0].transcript, 'Neutral spoken report.');
  assert.equal(result.segmentJudgments[0].decision, 'REVIEW');
  assert.ok(result.segmentJudgments[0].evidence.onScreenText[0].policyIds.length > 0);
});

test('cancellation terminates OCR work and closes the worker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-ocr-cancel-'));
  const cfg = config({ textEdgeThreshold: 0 });
  const bytes = Buffer.alloc(cfg.frameWidth * cfg.frameHeight * 3, 80);
  const sampler = {
    fs, sceneCuts: async () => [], extractRaw: async (_proxy, _time, file) => { fs.writeFileSync(file, bytes); return bytes; },
    extractJpeg: async (_proxy, _time, file) => fs.writeFileSync(file, 'jpg')
  };
  let closed = false;
  const ocrProvider = {
    healthCheck: async () => ({ ok: true }), close: () => { closed = true; },
    inspectFrame: async (_file, _timestamp, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true }))
  };
  const controller = new AbortController();
  const service = new VisualRiskService({ config: cfg, sampler, ocrProvider, provider: { unload: async () => {} }, cache: new VisualFindingCache() });
  const promise = service.analyze('proxy', dir, { metadata: { videoId: 'cancel' }, transcriptSegments: [segment(0, 10)] }, [baseJudgment()], { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(promise, error => error.code === 'ANALYSIS_CANCELLED'); assert.equal(closed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation stops before detector/model work', async () => {
  const controller = new AbortController(); controller.abort();
  const service = new VisualRiskService({
    config: config(), sampler: { fs, sceneCuts: async () => [], extractRaw: async () => { throw new Error('must not run'); } },
    provider: { unload: async () => {} }, cache: new VisualFindingCache()
  });
  await assert.rejects(service.analyze('proxy', os.tmpdir(), { metadata: { videoId: 'v' }, transcriptSegments: [segment(0, 10)] }, [baseJudgment()], { signal: controller.signal }), error => error instanceof VisualModelError && error.code === 'ANALYSIS_CANCELLED');
});

test('renderer exposes visual stages, indicators, and existing request guard', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /visual_proxy/); assert.match(renderer, /visual_sampling/);
  assert.match(renderer, /Visual Risk/); assert.match(renderer, /requestGuard\.isCurrent/);
});
