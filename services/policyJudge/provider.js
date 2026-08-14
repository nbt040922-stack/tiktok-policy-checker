const POLICY_JUDGE_PROMPT_VERSION = 'qwen-policy-judge-v1';
const DECISIONS = Object.freeze(['KEEP', 'REVIEW', 'REMOVE']);
const OUTCOMES = Object.freeze(['ALLOW', 'RESTRICT', 'PROHIBIT', 'UNKNOWN']);

const JUDGMENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'confidence', 'postability', 'fypEligibility', 'monetization', 'ageRestricted', 'categories', 'policyIds', 'reason', 'contextType', 'requiresVisualReview'],
  properties: {
    decision: { enum: DECISIONS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    postability: { enum: OUTCOMES },
    fypEligibility: { enum: OUTCOMES },
    monetization: { enum: OUTCOMES },
    ageRestricted: { type: ['boolean', 'null'] },
    categories: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    policyIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    reason: { type: 'string', minLength: 1 },
    contextType: { type: 'string', minLength: 1 },
    requiresVisualReview: { type: 'boolean' }
  }
});

const SYSTEM_PROMPT = `/no_think
You are a transcript-only TikTok policy judge. Use only the supplied candidate policy records.
You are not allowed to rely on remembered TikTok policy.
If supplied policies do not support a conclusion, return REVIEW.
Do not invent policy IDs or exceptions.
Do not infer monetization restrictions unless supplied policy evidence supports them.
Distinguish reporting, quotation, prevention, condemnation, documentary, educational, and artistic context from promotion or instruction.
Do not claim visual evidence from transcript text. If visual evidence is needed, return REVIEW with requiresVisualReview=true.
Return exactly one concise JSON object matching the supplied schema. Do not output reasoning or prose outside JSON.`;

class PolicyJudgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyJudgeError';
    this.code = code;
  }
}

class PolicyJudgeProvider {
  async judgeSegment() { throw new Error('judgeSegment must be implemented'); }
  async healthCheck() { throw new Error('healthCheck must be implemented'); }
  async getModelInfo() { throw new Error('getModelInfo must be implemented'); }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Qwen did not return a JSON object.');
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {
    throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Qwen returned invalid JSON.');
  }
}

function validateJudgment(value, { candidatePolicyIds = [], knownCategories = [] } = {}) {
  const judgment = parseJsonObject(value);
  const allowedFields = Object.keys(JUDGMENT_SCHEMA.properties);
  const missing = JUDGMENT_SCHEMA.required.filter(field => !(field in judgment));
  const extra = Object.keys(judgment).filter(field => !allowedFields.includes(field));
  if (missing.length || extra.length) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', `Judgment schema mismatch: ${[...missing, ...extra].join(', ')}`);
  if (!DECISIONS.includes(judgment.decision)) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid decision.');
  if (!Number.isFinite(judgment.confidence) || judgment.confidence < 0 || judgment.confidence > 1) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid confidence.');
  for (const field of ['postability', 'fypEligibility', 'monetization']) {
    if (!OUTCOMES.includes(judgment[field])) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', `Invalid ${field}.`);
  }
  if (judgment.ageRestricted !== null && typeof judgment.ageRestricted !== 'boolean') throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid ageRestricted.');
  if (typeof judgment.requiresVisualReview !== 'boolean' || typeof judgment.reason !== 'string' || !judgment.reason.trim() || typeof judgment.contextType !== 'string' || !judgment.contextType.trim()) {
    throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid judgment details.');
  }
  for (const field of ['categories', 'policyIds']) {
    if (!Array.isArray(judgment[field]) || judgment[field].some(item => typeof item !== 'string') || new Set(judgment[field]).size !== judgment[field].length) {
      throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', `Invalid ${field}.`);
    }
  }
  const allowedIds = new Set(candidatePolicyIds);
  const allowedCategories = new Set(knownCategories);
  if (judgment.policyIds.some(id => !allowedIds.has(id))) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Qwen returned an unknown policy ID.');
  if (judgment.categories.some(category => !allowedCategories.has(category))) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Qwen returned an unknown category.');
  return judgment;
}

function buildPrompt(input) {
  return JSON.stringify({
    policySet: input.policySet,
    segment: input.segment,
    context: input.context,
    candidatePolicies: input.candidatePolicies,
    decisionSemantics: {
      REMOVE: 'Clear prohibited postability supported by supplied policy.',
      REVIEW: 'Ambiguous, restricted, FYF-ineligible, low-confidence, conflicting, incomplete, or needs visual review.',
      KEEP: 'Clearly allowed, no strong FYF restriction, no unresolved high-risk policy.'
    }
  });
}

function linkedSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new PolicyJudgeError('MODEL_TIMEOUT', 'Local Qwen judgment timed out.')), timeoutMs);
  const abort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); } };
}

class LocalQwenProvider extends PolicyJudgeProvider {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    super();
    this.config = config;
    this.fetch = fetchImpl;
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new PolicyJudgeError('MODEL_CONFIG_INVALID', 'Qwen server must use http://127.0.0.1.');
    this.baseUrl = url.href.replace(/\/$/, '');
  }

  async healthCheck({ signal } = {}) {
    const linked = linkedSignal(signal, Math.min(this.config.timeoutMs, 5000));
    try {
      const response = await this.fetch(`${this.baseUrl}/api/tags`, { signal: linked.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const loaded = (data.models || []).find(item => item.name === this.config.model || item.model === this.config.model);
      this.detectedModel = loaded || null;
      return loaded
        ? { ok: true, provider: 'local-qwen', model: this.config.model }
        : { ok: false, code: 'MODEL_NOT_INSTALLED', message: `Local model ${this.config.model} is not installed.` };
    } catch (error) {
      return { ok: false, code: 'MODEL_UNAVAILABLE', message: 'Qwen Policy Judge is not running.', detail: error.message };
    } finally {
      linked.cleanup();
    }
  }

  async getModelInfo() {
    return {
      provider: 'local-qwen',
      model: this.config.modelDisplayName || this.config.model,
      modelId: this.config.model,
      quantization: this.detectedModel?.details?.quantization_level || this.config.quantization
    };
  }

  async judgeSegment(input, { signal } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const linked = linkedSignal(signal, this.config.timeoutMs);
      try {
        const response = await this.fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST', signal: linked.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.config.model,
            stream: false,
            think: false,
            format: JUDGMENT_SCHEMA,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildPrompt(input) }],
            options: { temperature: this.config.temperature, top_p: this.config.topP, num_predict: this.config.maxOutputTokens }
          })
        });
        if (!response.ok) throw new PolicyJudgeError(response.status >= 500 ? 'MODEL_HTTP_TEMPORARY' : 'MODEL_HTTP_ERROR', `Local Qwen returned HTTP ${response.status}.`);
        const payload = await response.json();
        const judgment = validateJudgment(payload.message?.content, {
          candidatePolicyIds: input.candidatePolicies.map(policy => policy.id),
          knownCategories: input.knownCategories
        });
        return { ...judgment, usage: { promptTokens: payload.prompt_eval_count ?? null, generatedTokens: payload.eval_count ?? null } };
      } catch (error) {
        if (linked.signal.aborted) {
          if (signal?.aborted) throw new PolicyJudgeError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
          throw new PolicyJudgeError('MODEL_TIMEOUT', 'Local Qwen judgment timed out.');
        }
        lastError = error instanceof PolicyJudgeError ? error : new PolicyJudgeError('MODEL_UNAVAILABLE', 'Qwen Policy Judge is not running.');
        if (!['MODEL_OUTPUT_INVALID', 'MODEL_HTTP_TEMPORARY', 'MODEL_UNAVAILABLE'].includes(lastError.code) || attempt === this.config.maxRetries) throw lastError;
      } finally {
        linked.cleanup();
      }
    }
    throw lastError;
  }
}

module.exports = {
  JUDGMENT_SCHEMA,
  LocalQwenProvider,
  OUTCOMES,
  POLICY_JUDGE_PROMPT_VERSION,
  PolicyJudgeError,
  PolicyJudgeProvider,
  SYSTEM_PROMPT,
  buildPrompt,
  parseJsonObject,
  validateJudgment
};
