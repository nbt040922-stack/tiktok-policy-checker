const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('../../config/policy-judge.json').policyJudge;
const { findSafeWindows, formatTimestamp } = require('../policyAnalysis');
const { loadPolicySet } = require('../policyKnowledge');
const { decideFromFindings, mergeVisualFindings } = require('./decisionEngine');
const { screenTranscript } = require('./riskScreen');
const { LocalQwenProvider, POLICY_JUDGE_PROMPT_VERSION, PolicyJudgeError } = require('./provider');

function loadPolicyJudgeConfig(overrides = {}) {
  const config = {
    ...defaults, ...overrides,
    baseUrl: process.env.QWEN_SERVER_URL || overrides.baseUrl || defaults.baseUrl,
    model: process.env.QWEN_MODEL || overrides.model || defaults.model,
    quantization: process.env.QWEN_QUANTIZATION || overrides.quantization || defaults.quantization
  };
  if (!Number.isInteger(config.candidatePolicies) || config.candidatePolicies < 3 || config.candidatePolicies > 8) throw new PolicyJudgeError('MODEL_CONFIG_INVALID', 'candidatePolicies must be from 3 to 8.');
  if (!Number.isFinite(config.candidateMinScore) || config.candidateMinScore < 1) throw new PolicyJudgeError('MODEL_CONFIG_INVALID', 'candidateMinScore must be positive.');
  if (!Number.isInteger(config.contextSegments) || config.contextSegments < 0 || config.contextSegments > 3) throw new PolicyJudgeError('MODEL_CONFIG_INVALID', 'contextSegments must be from 0 to 3.');
  if (![1, 2].includes(config.concurrency)) throw new PolicyJudgeError('MODEL_CONFIG_INVALID', 'concurrency must be 1 or 2.');
  return Object.freeze(config);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

class ModelFindingCache {
  constructor({ filePath = null, maxEntries = 10000, fileSystem = fs } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.fs = fileSystem;
    this.entries = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !this.fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (parsed.version !== 2) return;
      for (const [key, value] of Object.entries(parsed.entries || {})) this.entries.set(key, value);
    } catch (_) {
      this.entries.clear();
      try { this.fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`); } catch (_) {}
    }
  }

  get(key) { return this.entries.get(key) || null; }

  set(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    if (!this.filePath) return;
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    this.fs.writeFileSync(tempPath, JSON.stringify({ version: 2, entries: Object.fromEntries(this.entries) }), 'utf8');
    this.fs.renameSync(tempPath, this.filePath);
  }
}

function candidatePayload(policy) {
  return {
    id: policy.id, officialTitle: policy.source.document, category: policy.category,
    summary: policy.summary, ruleText: policy.ruleText, outcome: policy.outcome,
    contextualAllowances: policy.contextualAllowances, exceptions: policy.exceptions,
    platformTreatment: policy.platformTreatment || null, sourceSection: policy.source.section
  };
}

function buildSegmentInput(segments, index, repository, config, risk = { matchedCategories: [] }) {
  const current = segments[index];
  const contextText = range => range.map(segment => segment.text).join(' ').slice(0, 2000);
  const previous = segments.slice(Math.max(0, index - config.contextSegments), index);
  const next = segments.slice(index + 1, index + 1 + config.contextSegments);
  const candidates = repository.getCandidatePolicies({
    text: current.text,
    categories: (risk.requiresJudge || risk.benignContext) ? risk.matchedCategories : [],
    maxResults: config.candidatePolicies,
    minScore: config.candidateMinScore
  });
  return {
    candidates,
    input: {
      segment: { start: current.startSeconds, end: current.endSeconds, text: current.text },
      context: { previous: contextText(previous), next: contextText(next) },
      policySet: repository.version,
      candidatePolicies: candidates.map(candidatePayload)
    }
  };
}

function cacheKey(input, modelInfo, config) {
  return stableHash({
    policyVersion: input.policySet, promptVersion: POLICY_JUDGE_PROMPT_VERSION,
    model: modelInfo.modelId || modelInfo.model, quantization: modelInfo.quantization,
    settings: { temperature: config.temperature, topP: config.topP, maxOutputTokens: config.maxOutputTokens },
    segment: input.segment, context: input.context,
    candidatePolicyIds: input.candidatePolicies.map(policy => policy.id)
  });
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function mergeAdjacentDecisions(segments, { maxGapSeconds = 2.5 } = {}) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const compatible = previous
      && previous.decision === segment.decision
      && previous.requiresVisualReview === segment.requiresVisualReview
      && previous.contextType === segment.contextType
      && JSON.stringify([...previous.categories].sort()) === JSON.stringify([...segment.categories].sort())
      && segment.startSeconds - previous.endSeconds <= maxGapSeconds;
    if (!compatible) {
      merged.push({ ...segment, underlyingSegmentIds: [segment.id] });
      continue;
    }
    previous.endSeconds = segment.endSeconds;
    previous.endLabel = segment.endLabel;
    previous.transcript = `${previous.transcript} ${segment.transcript}`;
    previous.policyIds = [...new Set([...previous.policyIds, ...segment.policyIds])];
    previous.underlyingSegmentIds.push(segment.id);
    previous.confidence = Math.min(previous.confidence, segment.confidence);
  }
  return merged;
}

async function mapLimit(items, limit, operation) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function baseResult(segment, index) {
  return {
    id: `segment-${index + 1}`, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds,
    startLabel: formatTimestamp(segment.startSeconds), endLabel: formatTimestamp(segment.endSeconds), transcript: segment.text
  };
}

function precheckResult(base, repository, risk) {
  return {
    ...base, decision: 'KEEP', decisionSource: 'PRECHECK', confidence: 1,
    postability: 'UNKNOWN', fypEligibility: 'UNKNOWN', monetization: 'UNKNOWN', ageRestricted: null,
    categories: [], policyIds: [], appliedPolicies: [], findings: [],
    reason: 'No meaningful policy risk signal or relevant policy candidate.', mappingReason: 'NEUTRAL_PRECHECK',
    contextType: 'neutral', requiresVisualReview: false, riskScreen: risk,
    promptVersion: POLICY_JUDGE_PROMPT_VERSION, policyVersion: repository.version,
    judge: { provider: 'deterministic-prefilter', model: null, quantization: null, promptVersion: POLICY_JUDGE_PROMPT_VERSION },
    judgedAt: new Date().toISOString(), error: null, cacheHit: false
  };
}

function fallbackResult(base, repository, modelInfo, risk, candidates, error, latency) {
  return {
    ...base, decision: 'REVIEW', decisionSource: 'MODEL_FAILURE_FALLBACK', confidence: 0,
    postability: 'UNKNOWN', fypEligibility: 'UNKNOWN', monetization: 'UNKNOWN', ageRestricted: null,
    categories: [...new Set(candidates.map(item => item.category))], policyIds: candidates.map(item => item.id),
    appliedPolicies: [], findings: [], mappingReason: error.code || 'MODEL_ERROR',
    reason: error.code === 'MODEL_TIMEOUT' ? 'Local model timed out.' : 'Local model findings could not be validated.',
    contextType: 'unclear', requiresVisualReview: false, riskScreen: risk,
    promptVersion: POLICY_JUDGE_PROMPT_VERSION, policyVersion: repository.version,
    judge: { ...modelInfo, promptVersion: POLICY_JUDGE_PROMPT_VERSION }, judgedAt: new Date().toISOString(),
    latencyMs: latency, error: error.code || 'MODEL_ERROR', cacheHit: false
  };
}

class PolicyJudgeService {
  constructor({ repository = loadPolicySet(), config = loadPolicyJudgeConfig(), provider, cache } = {}) {
    this.repository = repository;
    this.config = config;
    this.provider = provider || new LocalQwenProvider(config);
    this.cache = cache || new ModelFindingCache({ maxEntries: config.cacheMaxEntries });
  }

  async healthCheck(options) {
    if (!this.repository.records.length) return { ok: false, code: 'POLICY_SET_UNAVAILABLE', message: 'TikTok policy set is not loaded.' };
    return this.provider.healthCheck(options);
  }

  async analyzeIngestion(ingestion, { onStage = () => {}, signal, skipHealthCheck = false, deferCompletion = false } = {}) {
    const startedAt = Date.now();
    if (!skipHealthCheck) {
      const health = await this.healthCheck({ signal });
      if (!health.ok) throw new PolicyJudgeError(health.code, health.message);
    }
    const modelInfo = await this.provider.getModelInfo();
    const latencies = [];
    const metrics = {
      segmentsTotal: ingestion.transcriptSegments.length, segmentsPrefiltered: 0, segmentsSentToQwen: 0,
      cacheHits: 0, promptTokens: 0, generatedTokens: 0,
      routes: { PRECHECK_KEEP: 0, QWEN_JUDGED: 0, MODEL_FAILURE_REVIEW: 0, VISUAL_REVIEW: 0, POLICY_REVIEW: 0, REMOVE: 0 }
    };
    onStage('policy');
    const risks = screenTranscript(ingestion.transcriptSegments);

    const judgments = await mapLimit(ingestion.transcriptSegments, this.config.concurrency, async (segment, index) => {
      if (signal?.aborted) throw new PolicyJudgeError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
      const risk = risks[index];
      const { candidates, input } = buildSegmentInput(ingestion.transcriptSegments, index, this.repository, this.config, risk);
      const base = baseResult(segment, index);
      if (!risk.requiresJudge && !candidates.length) {
        metrics.segmentsPrefiltered++;
        metrics.routes.PRECHECK_KEEP++;
        return precheckResult(base, this.repository, risk);
      }
      if (!candidates.length) {
        metrics.routes.POLICY_REVIEW++;
        return {
          ...fallbackResult(base, this.repository, modelInfo, risk, [], { code: 'NO_RELEVANT_POLICY' }, 0),
          decisionSource: 'DETERMINISTIC_POLICY_ENGINE', mappingReason: 'NO_RELEVANT_POLICY_FOR_RISK', error: null
        };
      }

      const key = cacheKey(input, modelInfo, this.config);
      let findings = this.cache.get(key);
      let cacheHit = Boolean(findings);
      let latency = 0;
      if (cacheHit) {
        metrics.cacheHits++;
      } else {
        metrics.segmentsSentToQwen++;
        const requestStarted = Date.now();
        try {
          findings = await this.provider.judgeSegment(input, { signal });
        } catch (error) {
          if (error.code === 'ANALYSIS_CANCELLED') throw error;
          latency = Date.now() - requestStarted;
          latencies.push(latency);
          metrics.routes.MODEL_FAILURE_REVIEW++;
          return fallbackResult(base, this.repository, modelInfo, risk, candidates, error, latency);
        }
        latency = Date.now() - requestStarted;
        latencies.push(latency);
        metrics.promptTokens += findings.usage?.promptTokens || 0;
        metrics.generatedTokens += findings.usage?.generatedTokens || 0;
        const { usage, ...cacheableFindings } = findings;
        findings = cacheableFindings;
        this.cache.set(key, findings);
      }

      const mapped = decideFromFindings(findings, candidates, this.config);
      metrics.routes.QWEN_JUDGED++;
      if (mapped.decision === 'REMOVE') metrics.routes.REMOVE++;
      else if (mapped.requiresVisualReview) metrics.routes.VISUAL_REVIEW++;
      else if (mapped.decision === 'REVIEW') metrics.routes.POLICY_REVIEW++;
      const firstReason = findings.findings.find(item => item.applies)?.reason;
      return {
        ...base, ...mapped, findings: findings.findings, riskScreen: risk,
        reason: [mapped.mappingReason.replace(/_/g, ' '), firstReason].filter(Boolean).join(': ').slice(0, 280),
        promptVersion: POLICY_JUDGE_PROMPT_VERSION, policyVersion: this.repository.version,
        judge: { ...modelInfo, promptVersion: POLICY_JUDGE_PROMPT_VERSION }, judgedAt: new Date().toISOString(),
        latencyMs: latency, error: null, cacheHit
      };
    });

    if (!deferCompletion) onStage('safe_windows');
    const segments = mergeAdjacentDecisions(judgments, { maxGapSeconds: this.config.mergeGapSeconds });
    const removeCount = judgments.filter(item => item.decision === 'REMOVE').length;
    const reviewCount = judgments.filter(item => item.decision === 'REVIEW').length;
    metrics.averageLatencyMs = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0;
    metrics.p50LatencyMs = percentile(latencies, 0.5);
    metrics.p95LatencyMs = percentile(latencies, 0.95);
    metrics.totalAnalysisMs = Date.now() - startedAt;
    if (!deferCompletion) onStage('complete');
    return {
      analysisVersion: 'local-qwen-v2', videoId: ingestion.metadata.videoId, url: ingestion.metadata.url,
      title: ingestion.metadata.title, durationSeconds: ingestion.metadata.durationSeconds,
      overallDecision: removeCount ? 'REMOVE' : reviewCount ? 'REVIEW' : 'KEEP',
      segments, segmentJudgments: judgments, recommendedClips: findSafeWindows(judgments),
      transcriptSegments: ingestion.transcriptSegments, transcriptLanguage: ingestion.transcriptLanguage,
      transcriptSource: ingestion.transcriptSource, channelName: ingestion.metadata.channelName,
      thumbnailUrl: ingestion.metadata.thumbnailUrl, policyVersion: this.repository.version,
      judge: { ...modelInfo, promptVersion: POLICY_JUDGE_PROMPT_VERSION }, analyzedAt: new Date().toISOString(), metrics
    };
  }

  applyVisualAnalysis(textResult, visualResult, visualConfig, { onStage = () => {} } = {}) {
    const framesBySegment = visualResult.framesBySegment.map(frames => frames.map(frame => {
      if (!frame.ocr?.risk?.requiresJudge || frame.ocr.duplicate) return frame;
      const candidates = this.repository.getCandidatePolicies({
        text: frame.ocr.normalizedText,
        categories: frame.ocr.risk.categories,
        maxResults: this.config.candidatePolicies,
        minScore: this.config.candidateMinScore
      });
      return { ...frame, ocr: { ...frame.ocr, policyCandidates: candidates.map(candidatePayload) } };
    }));
    const judgments = textResult.segmentJudgments.map((judgment, index) =>
      mergeVisualFindings(judgment, framesBySegment[index] || [], this.repository, visualConfig, visualResult.visualStatus)
    );
    onStage('safe_windows');
    const segments = mergeAdjacentDecisions(judgments, { maxGapSeconds: this.config.mergeGapSeconds });
    const overallDecision = judgments.some(item => item.decision === 'REMOVE') ? 'REMOVE'
      : judgments.some(item => item.decision === 'REVIEW') ? 'REVIEW' : 'KEEP';
    onStage('complete');
    return {
      ...textResult, analysisVersion: 'local-qwen-visual-v3', overallDecision, segments,
      segmentJudgments: judgments, recommendedClips: findSafeWindows(judgments),
      visualStatus: visualResult.visualStatus, visualError: visualResult.visualError,
      ocrStatus: visualResult.ocrStatus, ocrError: visualResult.ocrError,
      visual: { model: visualConfig.model, detectorVersion: visualConfig.detectorVersion, thresholdVersion: visualConfig.thresholdVersion },
      metrics: { ...textResult.metrics, visual: visualResult.metrics }
    };
  }
}

module.exports = {
  JudgmentCache: ModelFindingCache,
  ModelFindingCache,
  POLICY_JUDGE_PROMPT_VERSION,
  PolicyJudgeService,
  buildSegmentInput,
  cacheKey,
  candidatePayload,
  loadPolicyJudgeConfig,
  mapLimit,
  mergeAdjacentDecisions,
  percentile
};
