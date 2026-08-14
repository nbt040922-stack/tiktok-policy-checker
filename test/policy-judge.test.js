const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPolicySet } = require('../services/policyKnowledge');
const {
  JudgmentCache,
  POLICY_JUDGE_PROMPT_VERSION,
  PolicyJudgeService,
  applyDecisionSemantics,
  buildSegmentInput,
  cacheKey,
  loadPolicyJudgeConfig,
  mergeAdjacentDecisions
} = require('../services/policyJudge');
const {
  JUDGMENT_SCHEMA,
  LocalQwenProvider,
  PolicyJudgeError,
  SYSTEM_PROMPT,
  validateJudgment
} = require('../services/policyJudge/provider');

const config = overrides => loadPolicyJudgeConfig({ timeoutMs: 50, maxRetries: 1, ...overrides });
const candidate = { id: 'TT25_CG_VIOLENCE_001', category: 'violence' };

function validJudgment(overrides = {}) {
  return {
    decision: 'REMOVE', confidence: 0.91, postability: 'PROHIBIT', fypEligibility: 'UNKNOWN', monetization: 'UNKNOWN',
    ageRestricted: null, categories: ['violence'], policyIds: [candidate.id], reason: 'A supplied policy prohibits the threat.',
    contextType: 'direct', requiresVisualReview: false, ...overrides
  };
}

function chatResponse(content = validJudgment(), extra = {}) {
  return new Response(JSON.stringify({ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, prompt_eval_count: 42, eval_count: 20, ...extra }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
}

test('Qwen provider health requires the configured local model', async () => {
  const provider = new LocalQwenProvider(config(), { fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] })) });
  assert.equal((await provider.healthCheck()).ok, true);
  const missing = new LocalQwenProvider(config(), { fetchImpl: async () => new Response(JSON.stringify({ models: [] })) });
  assert.equal((await missing.healthCheck()).code, 'MODEL_NOT_INSTALLED');
  assert.throws(() => new LocalQwenProvider(config({ baseUrl: 'http://0.0.0.0:11434' })), /127\.0\.0\.1/);
});

test('Qwen request disables thinking, uses strict schema, and grounds the prompt', async () => {
  let request;
  const provider = new LocalQwenProvider(config(), { fetchImpl: async (url, options) => { request = { url, body: JSON.parse(options.body) }; return chatResponse(); } });
  const result = await provider.judgeSegment({ policySet: 'tiktok-global-2025-h2', segment: { text: 'threat' }, context: {}, candidatePolicies: [candidate], knownCategories: ['violence'] });
  assert.equal(result.decision, 'REMOVE');
  assert.equal(request.body.think, false);
  assert.deepEqual(request.body.format, JUDGMENT_SCHEMA);
  assert.match(SYSTEM_PROMPT, /Use only the supplied candidate policy records/);
  assert.match(SYSTEM_PROMPT, /Do not invent policy IDs/);
});

test('strict judgment validation rejects extra fields and unknown policy IDs', () => {
  assert.throws(() => validateJudgment({ ...validJudgment(), prose: 'extra' }, { candidatePolicyIds: [candidate.id], knownCategories: ['violence'] }), /schema mismatch/);
  assert.throws(() => validateJudgment({ ...validJudgment(), policyIds: ['INVENTED'] }, { candidatePolicyIds: [candidate.id], knownCategories: ['violence'] }), /unknown policy ID/);
});

test('invalid JSON retries once then accepts valid JSON', async () => {
  let calls = 0;
  const provider = new LocalQwenProvider(config(), { fetchImpl: async () => ++calls === 1 ? chatResponse('not json') : chatResponse() });
  const result = await provider.judgeSegment({ policySet: 'v', segment: {}, context: {}, candidatePolicies: [candidate], knownCategories: ['violence'] });
  assert.equal(result.decision, 'REMOVE');
  assert.equal(calls, 2);
});

test('timeout returns MODEL_TIMEOUT without infinite retry', async () => {
  let calls = 0;
  const provider = new LocalQwenProvider(config({ timeoutMs: 10 }), {
    fetchImpl: async (url, options) => {
      calls++;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
  });
  await assert.rejects(() => provider.judgeSegment({ policySet: 'v', segment: {}, context: {}, candidatePolicies: [candidate], knownCategories: ['violence'] }), error => error.code === 'MODEL_TIMEOUT');
  assert.equal(calls, 1);
});

test('cache key invalidates on model, policy, prompt inputs, and settings', () => {
  const input = { policySet: 'v1', segment: { text: 'x' }, context: {}, candidatePolicies: [candidate] };
  const model = { modelId: 'qwen', quantization: 'Q4' };
  const first = cacheKey(input, model, config());
  assert.notEqual(first, cacheKey({ ...input, policySet: 'v2' }, model, config()));
  assert.notEqual(first, cacheKey(input, { ...model, modelId: 'qwen-new' }, config()));
  assert.notEqual(first, cacheKey(input, model, config({ temperature: 0.2 })));
  assert.equal(POLICY_JUDGE_PROMPT_VERSION, 'qwen-policy-judge-v1');
});

test('candidate input honors top-five limit and one-segment context', () => {
  const repository = loadPolicySet();
  const segments = [
    { startSeconds: 0, endSeconds: 10, text: 'previous context' },
    { startSeconds: 10, endSeconds: 20, text: 'violent threat and physical harm' },
    { startSeconds: 20, endSeconds: 30, text: 'next context' }
  ];
  const built = buildSegmentInput(segments, 1, repository, config());
  assert.ok(built.candidates.length <= 5);
  assert.equal(built.input.context.previous, 'previous context');
  assert.equal(built.input.context.next, 'next context');
  assert.equal(built.input.policySet, 'tiktok-global-2025-h2');
});

test('confidence and policy treatment map conservatively', () => {
  const cfg = config();
  assert.equal(applyDecisionSemantics(validJudgment(), cfg), 'REMOVE');
  assert.equal(applyDecisionSemantics(validJudgment({ confidence: 0.5 }), cfg), 'REVIEW');
  assert.equal(applyDecisionSemantics(validJudgment({ decision: 'KEEP', confidence: 0.9, postability: 'ALLOW' }), cfg), 'KEEP');
  assert.equal(applyDecisionSemantics(validJudgment({ decision: 'KEEP', confidence: 0.9, postability: 'ALLOW', fypEligibility: 'PROHIBIT' }), cfg), 'REVIEW');
  assert.equal(applyDecisionSemantics(validJudgment({ decision: 'KEEP', confidence: 0.9, postability: 'ALLOW', requiresVisualReview: true }), cfg), 'REVIEW');
});

test('adjacent merge requires same decision, risk context, and small gap', () => {
  const base = { decision: 'KEEP', categories: [], requiresVisualReview: false, policyIds: [], confidence: 0.9, transcript: 'a', reason: '', startLabel: '00:00', endLabel: '00:10' };
  const merged = mergeAdjacentDecisions([
    { ...base, id: 'a', startSeconds: 0, endSeconds: 10 },
    { ...base, id: 'b', startSeconds: 11, endSeconds: 20, transcript: 'b', endLabel: '00:20' },
    { ...base, id: 'c', startSeconds: 20, endSeconds: 30, decision: 'REVIEW', transcript: 'c', endLabel: '00:30' }
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].underlyingSegmentIds, ['a', 'b']);
});

test('pipeline prefilters neutral text, calls Qwen for risk, and reuses cache', async () => {
  let calls = 0;
  const provider = {
    healthCheck: async () => ({ ok: true }),
    getModelInfo: async () => ({ provider: 'local-qwen', model: 'Qwen3-14B', modelId: 'qwen3:14b', quantization: 'Q4_K_M' }),
    judgeSegment: async input => {
      calls++;
      const policy = input.candidatePolicies[0];
      return validJudgment({ categories: [policy.category], policyIds: [policy.id] });
    }
  };
  const service = new PolicyJudgeService({ provider, config: config(), cache: new JudgmentCache(), repository: loadPolicySet() });
  const ingestion = {
    metadata: { videoId: 'test', url: 'https://youtube.com/watch?v=test123', title: 'Test', durationSeconds: 40, channelName: '', thumbnailUrl: '' },
    transcriptSegments: [
      { startSeconds: 0, endSeconds: 20, text: 'quasar topology arithmetic' },
      { startSeconds: 20, endSeconds: 40, text: 'violent threat to cause physical harm' }
    ], transcriptLanguage: 'en', transcriptSource: 'manual'
  };
  const first = await service.analyzeIngestion(ingestion);
  assert.equal(first.metrics.segmentsPrefiltered, 1);
  assert.equal(first.metrics.segmentsSentToQwen, 1);
  assert.equal(first.segmentJudgments[1].decision, 'REMOVE');
  assert.equal(first.judge.promptVersion, POLICY_JUDGE_PROMPT_VERSION);
  const second = await service.analyzeIngestion(ingestion);
  assert.equal(second.metrics.cacheHits, 1);
  assert.equal(calls, 1);
});

test('benchmark fixture contains human expectations without official-verdict claims', () => {
  const fixtures = require('./fixtures/policy-judge-benchmark.json');
  assert.equal(fixtures.length, 12);
  assert.ok(fixtures.every(item => ['KEEP', 'REVIEW', 'REMOVE'].includes(item.expectedDecision) && item.expectedCategories.length));
});
