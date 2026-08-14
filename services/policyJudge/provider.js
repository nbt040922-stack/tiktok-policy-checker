const POLICY_JUDGE_PROMPT_VERSION = 'qwen-policy-findings-v2';
const OUTCOMES = Object.freeze(['ALLOW', 'RESTRICT', 'PROHIBIT', 'UNKNOWN']);
const CONTEXT_LABELS = Object.freeze([
  'neutral', 'discussion', 'news_reporting', 'documentary', 'educational', 'medical', 'prevention', 'recovery',
  'quotation', 'criticism', 'counterspeech', 'satire', 'artistic', 'promotion', 'instruction', 'glorification',
  'targeted_attack', 'unclear'
]);

const TREATMENT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['postability', 'fypEligibility', 'monetization'],
  properties: {
    postability: { enum: OUTCOMES }, fypEligibility: { enum: OUTCOMES }, monetization: { enum: OUTCOMES }
  }
});

const FINDINGS_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['findings', 'overallContext', 'contextConfidence', 'requiresVisualReview', 'insufficientEvidence'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['policyId', 'applies', 'applicabilityConfidence', 'treatment', 'context', 'exceptionApplies', 'requiresVisualReview', 'reason'],
        properties: {
          policyId: { type: 'string' }, applies: { type: 'boolean' },
          applicabilityConfidence: { type: 'number', minimum: 0, maximum: 1 },
          treatment: TREATMENT_SCHEMA, context: { enum: CONTEXT_LABELS },
          exceptionApplies: { type: 'boolean' }, requiresVisualReview: { type: 'boolean' },
          reason: { type: 'string', minLength: 1 }
        }
      }
    },
    overallContext: { enum: CONTEXT_LABELS },
    contextConfidence: { type: 'number', minimum: 0, maximum: 1 },
    requiresVisualReview: { type: 'boolean' }, insufficientEvidence: { type: 'boolean' }
  }
});

const SYSTEM_PROMPT = `/no_think
You identify policy findings from transcript text. You do not make KEEP, REVIEW, or REMOVE decisions.
Use only the supplied candidate policy records. Never rely on remembered TikTok policy.
A topic mention is not a policy violation. Set applies=true only when the described behavior matches the supplied rule.
Reporting, quotation, prevention, recovery, criticism, counterspeech, documentary, educational, medical, satire, and artistic context are not promotion or instruction.
For misinformation, hate, threat, or harassment rules, set applies=false when the transcript only reports, quotes, condemns, or debunks the claim or conduct instead of endorsing it.
If the context is clear and no supplied policy applies, return an empty findings array with insufficientEvidence=false.
Do not use insufficientEvidence merely because no rule applies.
Copy treatment exactly from the matching supplied policy. Do not invent policy IDs, outcomes, or exceptions.
Set exceptionApplies=true only when a supplied allowance or exception clearly matches the transcript context.
Do not claim visual evidence. Set requiresVisualReview=true only when policy applicability materially depends on unseen imagery.
Return exactly one concise JSON object matching the schema. No final verdict, hidden reasoning, or prose outside JSON.`;

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

function exactFields(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', `Invalid ${label}.`);
  const missing = required.filter(field => !(field in value));
  const extra = Object.keys(value).filter(field => !required.includes(field));
  if (missing.length || extra.length) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', `${label} schema mismatch: ${[...missing, ...extra].join(', ')}`);
}

function validateFindings(value, { candidatePolicies = [] } = {}) {
  const output = parseJsonObject(value);
  const topFields = FINDINGS_SCHEMA.required;
  exactFields(output, topFields, 'Findings');
  if (!Array.isArray(output.findings)) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid findings.');
  if (!CONTEXT_LABELS.includes(output.overallContext) || !Number.isFinite(output.contextConfidence) || output.contextConfidence < 0 || output.contextConfidence > 1) {
    throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid overall context.');
  }
  if (typeof output.requiresVisualReview !== 'boolean' || typeof output.insufficientEvidence !== 'boolean') throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid findings flags.');
  const policies = new Map(candidatePolicies.map(policy => [policy.id, policy]));
  const seen = new Set();
  const findingFields = FINDINGS_SCHEMA.properties.findings.items.required;
  for (const finding of output.findings) {
    exactFields(finding, findingFields, 'Finding');
    const policy = policies.get(finding.policyId);
    if (!policy) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Qwen returned an unknown policy ID.');
    if (seen.has(finding.policyId)) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Qwen returned a duplicate policy ID.');
    seen.add(finding.policyId);
    if (typeof finding.applies !== 'boolean' || !Number.isFinite(finding.applicabilityConfidence) || finding.applicabilityConfidence < 0 || finding.applicabilityConfidence > 1) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid finding applicability.');
    if (!CONTEXT_LABELS.includes(finding.context) || typeof finding.exceptionApplies !== 'boolean' || typeof finding.requiresVisualReview !== 'boolean' || typeof finding.reason !== 'string' || !finding.reason.trim()) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid finding details.');
    exactFields(finding.treatment, TREATMENT_SCHEMA.required, 'Treatment');
    for (const field of TREATMENT_SCHEMA.required) {
      if (!OUTCOMES.includes(finding.treatment[field])) throw new PolicyJudgeError('MODEL_OUTPUT_INVALID', 'Invalid finding treatment.');
      finding.treatment[field] = policy.outcome[field];
    }
    if (finding.exceptionApplies && !(policy.contextualAllowances?.length || policy.exceptions?.length)) finding.exceptionApplies = false;
  }
  return output;
}

function buildPrompt(input) {
  return JSON.stringify({
    policySet: input.policySet,
    segment: input.segment,
    context: input.context,
    candidatePolicies: input.candidatePolicies
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
      provider: 'local-qwen', model: this.config.modelDisplayName || this.config.model,
      modelId: this.config.model, quantization: this.detectedModel?.details?.quantization_level || this.config.quantization
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
            model: this.config.model, stream: false, think: false, format: FINDINGS_SCHEMA,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildPrompt(input) }],
            options: { temperature: this.config.temperature, top_p: this.config.topP, num_predict: this.config.maxOutputTokens }
          })
        });
        if (!response.ok) throw new PolicyJudgeError(response.status >= 500 ? 'MODEL_HTTP_TEMPORARY' : 'MODEL_HTTP_ERROR', `Local Qwen returned HTTP ${response.status}.`);
        const payload = await response.json();
        const findings = validateFindings(payload.message?.content, { candidatePolicies: input.candidatePolicies });
        return { ...findings, usage: { promptTokens: payload.prompt_eval_count ?? null, generatedTokens: payload.eval_count ?? null } };
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
  CONTEXT_LABELS, FINDINGS_SCHEMA, LocalQwenProvider, OUTCOMES, POLICY_JUDGE_PROMPT_VERSION,
  PolicyJudgeError, PolicyJudgeProvider, SYSTEM_PROMPT, buildPrompt, parseJsonObject, validateFindings
};
