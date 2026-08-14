const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPolicySet } = require('../services/policyKnowledge');
const { mergeVisualFindings } = require('../services/policyJudge/decisionEngine');
const {
  VisualFindingCache, VisualMediaService, VisualRiskService, cheapScan, hammingDistance,
  loadVisualRiskConfig, normalizeOcr, parseSceneCuts, perceptualHash, preferSceneCuts,
  samplePositions, visualCacheKey
} = require('../services/visualRisk');
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
