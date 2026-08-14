const fs = require('node:fs');

const VISUAL_CATEGORIES = Object.freeze([
  'weapon', 'blood', 'graphic_injury', 'nudity', 'sexual_content', 'violent_act',
  'self_harm_visual', 'drug_or_regulated_goods', 'personal_information',
  'shocking_content', 'on_screen_text_risk'
]);
const SEVERITIES = Object.freeze(['none', 'minor', 'visible', 'severe', 'extreme', 'uncertain']);

class VisualModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VisualModelError';
    this.code = code;
  }
}

function loopback(url) {
  try { return ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname); } catch (_) { return false; }
}

function validateOutput(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'detectedText,findings' || !Array.isArray(value.findings) || typeof value.detectedText !== 'string') {
    throw new VisualModelError('VISUAL_MODEL_INVALID_OUTPUT', 'Visual model returned invalid findings.');
  }
  const findings = value.findings.map(finding => {
    const keys = Object.keys(finding || {}).sort().join(',');
    if (keys !== 'applies,category,confidence,detail,requiresHumanReview,severity'
      || !VISUAL_CATEGORIES.includes(finding.category)
      || !SEVERITIES.includes(finding.severity)
      || typeof finding.applies !== 'boolean'
      || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1
      || typeof finding.detail !== 'string' || typeof finding.requiresHumanReview !== 'boolean') {
      throw new VisualModelError('VISUAL_MODEL_INVALID_OUTPUT', 'Visual model returned invalid findings.');
    }
    return { ...finding, detail: finding.detail.slice(0, 180) };
  });
  return { findings, detectedText: value.detectedText.trim().replace(/\s+/g, ' ').slice(0, 500) };
}

class OllamaVisualProvider {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    if (!loopback(config.baseUrl)) throw new VisualModelError('VISUAL_CONFIG_INVALID', 'Visual model host must be local.');
    this.config = config;
    this.fetch = fetchImpl;
  }

  async healthCheck({ signal } = {}) {
    try {
      const response = await this.fetch(`${this.config.baseUrl}/api/tags`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const installed = (body.models || []).some(item => item.name === this.config.model || item.model === this.config.model);
      return installed
        ? { ok: true, model: this.config.model }
        : { ok: false, code: 'VISUAL_MODEL_NOT_INSTALLED', message: `Install manually: ollama pull ${this.config.model}` };
    } catch (error) {
      if (signal?.aborted) throw new VisualModelError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
      return { ok: false, code: 'VISUAL_MODEL_UNAVAILABLE', message: 'Local visual model service is unavailable.' };
    }
  }

  async unload(model, { signal } = {}) {
    if (!model) return;
    try {
      await this.fetch(`${this.config.baseUrl}/api/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 })
      });
    } catch (_) {}
  }

  async inspectFrame(framePath, cheapSignals, { signal } = {}) {
    const health = await this.healthCheck({ signal });
    if (!health.ok) throw new VisualModelError(health.code, health.message);
    const image = fs.readFileSync(framePath).toString('base64');
    const prompt = [
      'Inspect only visible evidence in this image. Return findings, never a moderation verdict.',
      `Allowed categories: ${VISUAL_CATEGORIES.join(', ')}.`,
      'applies means visual evidence is present, not that it violates policy. Record visible weapons or blood even in news, museum, medical, or theatrical context and state that context in detail.',
      'Topic, red color, skin, tools, phones, costumes, and news imagery are not violations by themselves.',
      'Use applies=false when the category is not visibly established. Ambiguity requiresHumanReview=true.',
      'Return only applied or genuinely ambiguous findings; omit every clearly absent category.',
      'Severity must be none, minor, visible, severe, extreme, or uncertain.',
      'Extract meaningful on-screen risk text only; otherwise detectedText is empty.',
      `Cheap signals are escalation hints only and may be false: ${JSON.stringify(cheapSignals)}.`
    ].join('\n');
    const schema = {
      type: 'object', additionalProperties: false, required: ['findings', 'detectedText'],
      properties: {
        findings: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['category', 'applies', 'confidence', 'severity', 'detail', 'requiresHumanReview'],
          properties: {
            category: { type: 'string', enum: VISUAL_CATEGORIES }, applies: { type: 'boolean' },
            confidence: { type: 'number', minimum: 0, maximum: 1 }, severity: { type: 'string', enum: SEVERITIES },
            detail: { type: 'string' }, requiresHumanReview: { type: 'boolean' }
          }
        } },
        detectedText: { type: 'string' }
      }
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.config.timeoutMs);
    try {
      const response = await this.fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model, stream: false, think: false, format: schema, keep_alive: '5m',
          messages: [{ role: 'user', content: prompt, images: [image] }],
          options: { temperature: 0, top_p: 0.9, num_predict: 500 }
        })
      });
      if (!response.ok) throw new VisualModelError('VISUAL_MODEL_UNAVAILABLE', `Visual model HTTP ${response.status}.`);
      const body = await response.json();
      let parsed;
      try { parsed = validateOutput(JSON.parse(body.message?.content || '')); }
      catch (error) { error.rawOutput = String(body.message?.content || '').slice(0, 2000); throw error; }
      return { ...parsed, usage: { promptTokens: body.prompt_eval_count || 0, generatedTokens: body.eval_count || 0 } };
    } catch (error) {
      if (signal?.aborted) throw new VisualModelError('ANALYSIS_CANCELLED', 'Analysis was cancelled.');
      if (controller.signal.aborted) throw new VisualModelError('VISUAL_MODEL_TIMEOUT', 'Visual model timed out.');
      if (error instanceof VisualModelError) throw error;
      const wrapped = new VisualModelError('VISUAL_MODEL_INVALID_OUTPUT', 'Visual model returned invalid findings.');
      wrapped.rawOutput = error.rawOutput || null;
      throw wrapped;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

module.exports = { OllamaVisualProvider, SEVERITIES, VISUAL_CATEGORIES, VisualModelError, validateOutput };
