const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPolicySet } = require('../services/policyKnowledge');
const { decideFromFindings } = require('../services/policyJudge/decisionEngine');
const { rawRisk, screenTranscript } = require('../services/policyJudge/riskScreen');
const {
  ModelFindingCache, POLICY_JUDGE_PROMPT_VERSION, PolicyJudgeService,
  buildSegmentInput, cacheKey, loadPolicyJudgeConfig, mergeAdjacentDecisions
} = require('../services/policyJudge');
const {
  FINDINGS_SCHEMA, LocalQwenProvider, SYSTEM_PROMPT, validateFindings
} = require('../services/policyJudge/provider');

const repository = loadPolicySet();
const config = overrides => loadPolicyJudgeConfig({ timeoutMs: 50, maxRetries: 1, ...overrides });
const policy = id => repository.getPolicyById(id);
const violentThreat = policy('TT25_CG_VIOLENCE_001');

function findingFor(record, overrides = {}) {
  return {
    policyId: record.id, applies: true, applicabilityConfidence: 0.91,
    treatment: record.outcome, context: 'targeted_attack', exceptionApplies: false,
    requiresVisualReview: false, reason: 'The described conduct matches the supplied rule.', ...overrides
  };
}

function validFindings(record = violentThreat, overrides = {}) {
  return {
    findings: [findingFor(record)], overallContext: 'targeted_attack', contextConfidence: 0.9,
    requiresVisualReview: false, insufficientEvidence: false, ...overrides
  };
}

function chatResponse(content = validFindings()) {
  return new Response(JSON.stringify({
    message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
    prompt_eval_count: 42, eval_count: 20
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Qwen provider health requires the configured local model', async () => {
  const provider = new LocalQwenProvider(config(), { fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] })) });
  assert.equal((await provider.healthCheck()).ok, true);
  const missing = new LocalQwenProvider(config(), { fetchImpl: async () => new Response(JSON.stringify({ models: [] })) });
  assert.equal((await missing.healthCheck()).code, 'MODEL_NOT_INSTALLED');
  assert.throws(() => new LocalQwenProvider(config({ baseUrl: 'http://0.0.0.0:11434' })), /127\.0\.0\.1/);
});

test('Qwen returns findings only in non-thinking grounded mode', async () => {
  let request;
  const provider = new LocalQwenProvider(config(), { fetchImpl: async (url, options) => { request = JSON.parse(options.body); return chatResponse(); } });
  const result = await provider.judgeSegment({ policySet: repository.version, segment: { text: 'threat' }, context: {}, candidatePolicies: [violentThreat] });
  assert.equal(result.findings[0].policyId, violentThreat.id);
  assert.equal('decision' in result, false);
  assert.equal(request.think, false);
  assert.deepEqual(request.format, FINDINGS_SCHEMA);
  assert.match(SYSTEM_PROMPT, /topic mention is not a policy violation/i);
  assert.match(SYSTEM_PROMPT, /do not make KEEP, REVIEW, or REMOVE/i);
});

test('finding schema rejects extras and unknown IDs while grounding outcomes and exceptions', () => {
  assert.throws(() => validateFindings({ ...validFindings(), decision: 'REMOVE' }, { candidatePolicies: [violentThreat] }), /schema mismatch/);
  assert.throws(() => validateFindings(validFindings(violentThreat, { findings: [findingFor(violentThreat, { policyId: 'INVENTED' })] }), { candidatePolicies: [violentThreat] }), /unknown policy ID/);
  const grounded = validateFindings(validFindings(violentThreat, { findings: [findingFor(violentThreat, { treatment: { ...violentThreat.outcome, postability: 'ALLOW' }, exceptionApplies: true })] }), { candidatePolicies: [violentThreat] });
  assert.equal(grounded.findings[0].treatment.postability, 'PROHIBIT');
  assert.equal(grounded.findings[0].exceptionApplies, false);
});

test('invalid JSON retries once and timeout never loops', async () => {
  let calls = 0;
  const retrying = new LocalQwenProvider(config(), { fetchImpl: async () => ++calls === 1 ? chatResponse('not json') : chatResponse() });
  await retrying.judgeSegment({ policySet: 'v', segment: {}, context: {}, candidatePolicies: [violentThreat] });
  assert.equal(calls, 2);

  calls = 0;
  const timingOut = new LocalQwenProvider(config({ timeoutMs: 10 }), {
    fetchImpl: async (url, options) => {
      calls++;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
  });
  await assert.rejects(() => timingOut.judgeSegment({ policySet: 'v', segment: {}, context: {}, candidatePolicies: [violentThreat] }), error => error.code === 'MODEL_TIMEOUT');
  assert.equal(calls, 1);
});

test('prompt v2 invalidates old cache and keys model, policy, context, and candidates', () => {
  const input = { policySet: 'v1', segment: { text: 'x' }, context: { previous: '', next: '' }, candidatePolicies: [{ id: violentThreat.id }] };
  const model = { modelId: 'qwen', quantization: 'Q4' };
  const first = cacheKey(input, model, config());
  assert.equal(POLICY_JUDGE_PROMPT_VERSION, 'qwen-policy-findings-v2');
  assert.notEqual(first, cacheKey({ ...input, policySet: 'v2' }, model, config()));
  assert.notEqual(first, cacheKey({ ...input, context: { previous: 'new', next: '' } }, model, config()));
  assert.notEqual(first, cacheKey(input, { ...model, modelId: 'qwen-new' }, config()));
});

test('risk screen bypasses neutral speech and discounts generic tokens', () => {
  assert.deepEqual(rawRisk('We resize the player and configure keyboard controls').matchedCategories, []);
  assert.equal(rawRisk('The service has a kill switch for stuck processes').requiresJudge, false);
  assert.equal(rawRisk('I will kill you tomorrow').riskSignal, 'MEDIUM');
  assert.equal(rawRisk('Suicide prevention resources help people seek care').requiresJudge, true);
  assert.equal(rawRisk('Students can seek help and talk to someone').requiresJudge, true);
});

test('medium and high neighbor context prevents a neutral bypass', () => {
  const screened = screenTranscript([
    { text: 'Ordinary introduction to the program.' },
    { text: 'I will kill you tomorrow.' },
    { text: 'The closing credits appear.' }
  ]);
  assert.equal(screened[0].neighborRisk, true);
  assert.equal(screened[2].requiresJudge, true);
});

test('retrieval boosts phrases, applies a threshold, and limits category duplication', () => {
  assert.equal(repository.getCandidatePolicies({ text: 'ordinary weather explanation', minScore: 5 }).length, 0);
  const candidates = repository.getCandidatePolicies({ text: 'direct violent threat of physical harm', categories: ['violence'], minScore: 5, maxResults: 5 });
  assert.equal(candidates[0].id, 'TT25_CG_VIOLENCE_001');
  assert.ok(!candidates.some(item => item.id === 'TT25_CG_PUBLIC_INTEREST_001'));
  assert.ok(candidates[0].matchScore > repository.getCandidatePolicies({ text: 'kill switch', minScore: 1, maxResults: 5 })[0].matchScore);
  assert.ok(Math.max(...Object.values(candidates.reduce((counts, item) => ({ ...counts, [item.category]: (counts[item.category] || 0) + 1 }), {}))) <= 2);
});

test('benign sensitive context retrieves an applicable contextual rule and public interest evidence', () => {
  const candidates = repository.getCandidatePolicies({
    text: 'A documentary explains weapon history without facilitating use.', categories: ['weapons'], minScore: 5, maxResults: 5
  });
  assert.ok(candidates.some(item => item.id === 'TT25_CG_WEAPONS_001'));
  assert.ok(candidates.some(item => item.id === 'TT25_CG_PUBLIC_INTEREST_001'));
  assert.ok(candidates.length < 5);
});

test('candidate retrieval uses current text while neighbors only enter model context', () => {
  const segments = [
    { startSeconds: 0, endSeconds: 10, text: 'A violent threat appears in a quoted report.' },
    { startSeconds: 10, endSeconds: 20, text: 'The presenter configures an embedded player.' },
    { startSeconds: 20, endSeconds: 30, text: 'The interview returns to weather.' }
  ];
  const built = buildSegmentInput(segments, 1, repository, config(), rawRisk(segments[1].text));
  assert.equal(built.candidates.length, 0);
  assert.match(built.input.context.previous, /violent threat/);
  assert.match(built.input.context.next, /weather/);
});

test('deterministic engine removes only a confident applicable prohibited policy', () => {
  assert.equal(decideFromFindings(validFindings(), [violentThreat], config()).decision, 'REMOVE');
  assert.equal(decideFromFindings(validFindings(violentThreat, { findings: [findingFor(violentThreat, { applicabilityConfidence: 0.7 })] }), [violentThreat], config()).decision, 'REVIEW');
});

test('FYF and monetization UNKNOWN do not force REVIEW', () => {
  const allowed = policy('TT25_CG_SELF_HARM_002');
  const decision = decideFromFindings(validFindings(allowed, {
    findings: [findingFor(allowed, { context: 'prevention' })], overallContext: 'prevention'
  }), [allowed], config());
  assert.equal(decision.decision, 'KEEP');
  assert.equal(decision.monetization, 'UNKNOWN');
  assert.equal(decision.fypEligibility, 'UNKNOWN');
});

test('FYF prohibition, age restriction, and visual uncertainty force REVIEW', () => {
  const restricted = policy('TT25_CG_SELF_HARM_001');
  assert.equal(decideFromFindings(validFindings(restricted), [restricted], config()).decision, 'REVIEW');
  assert.equal(decideFromFindings(validFindings(restricted), [restricted], config()).ageRestricted, true);
  assert.equal(decideFromFindings(validFindings(violentThreat, { requiresVisualReview: true }), [violentThreat], config()).mappingReason, 'VISUAL_REVIEW_REQUIRED');
});

test('clear empty findings KEEP while public-interest ambiguity REVIEWs', () => {
  const empty = validFindings(violentThreat, { findings: [], overallContext: 'discussion', contextConfidence: 0.9 });
  assert.equal(decideFromFindings(empty, [violentThreat], config()).decision, 'KEEP');
  assert.equal(decideFromFindings({ ...empty, insufficientEvidence: true }, [violentThreat], config()).decision, 'REVIEW');
  const weapon = policy('TT25_CG_WEAPONS_001');
  const documentary = validFindings(weapon, {
    findings: [findingFor(weapon, { context: 'documentary', exceptionApplies: true })], overallContext: 'documentary'
  });
  assert.equal(decideFromFindings(documentary, [weapon], config()).mappingReason, 'POSTABILITY_UNRESOLVED');
  const graphic = { ...policy('TT25_CG_GRAPHIC_001'), matchScore: 8 };
  assert.equal(decideFromFindings(empty, [graphic], config()).mappingReason, 'VISUAL_REVIEW_REQUIRED');
  const publicInterest = policy('TT25_CG_PUBLIC_INTEREST_001');
  const quotation = validFindings(violentThreat, {
    findings: [findingFor(violentThreat, { context: 'quotation' })], overallContext: 'quotation'
  });
  assert.equal(decideFromFindings(quotation, [violentThreat, publicInterest], config()).decision, 'KEEP');
});

test('model cache stores findings and recalculates decisions under new thresholds', async () => {
  const allowed = policy('TT25_CG_SELF_HARM_002');
  let calls = 0;
  const provider = {
    healthCheck: async () => ({ ok: true }),
    getModelInfo: async () => ({ provider: 'local-qwen', model: 'Qwen3-14B', modelId: 'qwen3:14b', quantization: 'Q4_K_M' }),
    judgeSegment: async () => {
      calls++;
      return validFindings(allowed, { findings: [findingFor(allowed, { context: 'prevention', applicabilityConfidence: 0.9 })], overallContext: 'prevention' });
    }
  };
  const cache = new ModelFindingCache();
  const ingestion = {
    metadata: { videoId: 'cache', url: 'benchmark:cache', title: 'Cache', durationSeconds: 20, channelName: '', thumbnailUrl: '' },
    transcriptSegments: [{ startSeconds: 0, endSeconds: 20, text: 'Suicide prevention warning signs and recovery support.' }],
    transcriptLanguage: 'en', transcriptSource: 'manual'
  };
  const first = await new PolicyJudgeService({ provider, cache, repository, config: config({ keepConfidence: 0.8 }) }).analyzeIngestion(ingestion);
  const second = await new PolicyJudgeService({ provider, cache, repository, config: config({ keepConfidence: 0.95 }) }).analyzeIngestion(ingestion);
  assert.equal(first.segmentJudgments[0].decision, 'KEEP');
  assert.equal(second.segmentJudgments[0].decision, 'REVIEW');
  assert.equal(second.metrics.cacheHits, 1);
  assert.equal(calls, 1);
});

test('pipeline prechecks neutral text and records deterministic provenance', async () => {
  let calls = 0;
  const provider = {
    healthCheck: async () => ({ ok: true }),
    getModelInfo: async () => ({ provider: 'local-qwen', model: 'Qwen3-14B', modelId: 'qwen3:14b', quantization: 'Q4_K_M' }),
    judgeSegment: async input => {
      calls++;
      const selected = input.candidatePolicies.find(item => item.id === violentThreat.id) || input.candidatePolicies[0];
      return validFindings(selected, { findings: [findingFor(selected)] });
    }
  };
  const service = new PolicyJudgeService({ provider, config: config(), cache: new ModelFindingCache(), repository });
  const ingestion = {
    metadata: { videoId: 'test', url: 'benchmark:test', title: 'Test', durationSeconds: 60, channelName: '', thumbnailUrl: '' },
    transcriptSegments: [
      { startSeconds: 0, endSeconds: 20, text: 'We configure the player controls.' },
      { startSeconds: 20, endSeconds: 40, text: 'The presenter explains the settings panel.' },
      { startSeconds: 40, endSeconds: 60, text: 'I will kill you tomorrow.' }
    ], transcriptLanguage: 'en', transcriptSource: 'manual'
  };
  const result = await service.analyzeIngestion(ingestion);
  assert.equal(result.metrics.segmentsPrefiltered, 1);
  assert.equal(result.metrics.segmentsSentToQwen, 1);
  assert.equal(result.segmentJudgments[0].decisionSource, 'PRECHECK');
  assert.equal(result.segmentJudgments[2].decisionSource, 'DETERMINISTIC_POLICY_ENGINE');
  assert.equal(calls, 1);
});

test('adjacent merge requires compatible decision context and risk', () => {
  const base = { decision: 'KEEP', categories: [], requiresVisualReview: false, policyIds: [], confidence: 0.9, transcript: 'a', reason: '', contextType: 'neutral', startLabel: '00:00', endLabel: '00:10' };
  const merged = mergeAdjacentDecisions([
    { ...base, id: 'a', startSeconds: 0, endSeconds: 10 },
    { ...base, id: 'b', startSeconds: 11, endSeconds: 20, transcript: 'b', endLabel: '00:20' },
    { ...base, id: 'c', startSeconds: 20, endSeconds: 30, decision: 'REVIEW', transcript: 'c', endLabel: '00:30' }
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].underlyingSegmentIds, ['a', 'b']);
});

test('calibration fixture has four balanced groups and no official-outcome claim', () => {
  const fixtures = require('./fixtures/policy-judge-benchmark.json');
  assert.equal(fixtures.length, 40);
  const groups = fixtures.reduce((counts, item) => ({ ...counts, [item.group]: (counts[item.group] || 0) + 1 }), {});
  assert.deepEqual(groups, { neutral: 10, violation: 10, contextual: 10, restricted: 10 });
  assert.ok(fixtures.every(item => ['KEEP', 'REVIEW', 'REMOVE'].includes(item.expectedDecision) && Array.isArray(item.expectedCategories)));
});
