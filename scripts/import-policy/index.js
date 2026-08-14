const crypto = require('node:crypto');
const APPROVED_SOURCES = require('./sources.json');
const {
  PolicyValidationError,
  validateManifest,
  validatePolicyRecord,
  validateTaxonomy
} = require('../../services/policyKnowledge/validation');

const SUPPORTED_SOURCE_FORMATS = Object.freeze(['html', 'pdf', 'markdown', 'txt', 'json']);
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const OFFICIAL_SOURCE_HOSTS = new Set(['www.tiktok.com', 'support.tiktok.com', 'newsroom.tiktok.com']);

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new PolicyValidationError(`${field} must be a non-empty string`);
}

function normalizeSourceDocument(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new PolicyValidationError('Import source must be an object');
  for (const field of ['sourceId', 'document', 'format', 'content']) requireText(source[field], `source.${field}`);
  const format = source.format.toLowerCase();
  if (!SUPPORTED_SOURCE_FORMATS.includes(format)) throw new PolicyValidationError(`Unsupported source format: ${source.format}`);
  return Object.freeze({
    sourceId: source.sourceId.trim(), document: source.document.trim(), format, content: source.content,
    url: source.url || null, effectiveDate: source.effectiveDate || null, retrievedDate: source.retrievedDate || null
  });
}

function extractTikTokPolicyPage(html) {
  requireText(html, 'source.content');
  const encoded = html.match(/<script[^>]*data-ttark="__remixContext"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!encoded) throw new PolicyValidationError('Official TikTok policy payload was not found');
  try {
    const context = JSON.parse(decodeURIComponent(encoded));
    const page = context.state.loaderData['routes/safety/$lang/$l1/$l2'].cgData.postValue;
    if (!page?.realSlug || !page?.version || !Array.isArray(page.contents)) throw new Error('incomplete policy payload');
    return page;
  } catch (error) {
    throw new PolicyValidationError(`Unable to normalize official TikTok policy payload: ${error.message}`);
  }
}

async function readLimitedBody(response, maxBytes = MAX_SOURCE_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new PolicyValidationError(`Policy source exceeds ${maxBytes} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new PolicyValidationError(`Policy source exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchApprovedSource(sourceId, { fetchImpl = fetch, timeoutMs = 15000, now = () => new Date() } = {}) {
  const source = APPROVED_SOURCES.find(item => item.id === sourceId);
  if (!source) throw new PolicyValidationError(`Source is not allowlisted: ${sourceId}`);
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || !OFFICIAL_SOURCE_HOSTS.has(url.hostname)) throw new PolicyValidationError(`Unapproved source URL: ${source.url}`);
  const response = await fetchImpl(source.url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'TikTokPolicyChecker/1.0 source-capture', 'accept-language': 'en' }
  });
  if (response.status >= 300 && response.status < 400) throw new PolicyValidationError(`Redirect rejected for approved source: ${source.id}`);
  if (!response.ok) throw new PolicyValidationError(`Official source returned HTTP ${response.status}: ${source.id}`);
  const html = await readLimitedBody(response);
  const page = extractTikTokPolicyPage(html);
  if (page.realSlug !== source.slug || page.version !== source.versionMarker) {
    throw new PolicyValidationError(`Official source identity/version mismatch: ${source.id}`);
  }
  const normalizedContent = JSON.stringify(page);
  return Object.freeze({
    ...source,
    title: page.title,
    retrievedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    checksumSha256: crypto.createHash('sha256').update(normalizedContent).digest('hex'),
    normalizedContent
  });
}

function preparePolicyImport({ source, records, manifest, taxonomy }) {
  const normalizedSource = normalizeSourceDocument(source);
  validateManifest(manifest);
  validateTaxonomy(taxonomy);
  if (!Array.isArray(records) || !records.length) throw new PolicyValidationError('Import records must be a non-empty array');
  const domains = new Set(manifest.domains);
  const categories = new Set(taxonomy.categories.map(category => category.id));
  const supportedVersions = new Set([manifest.policySetVersion, ...manifest.availableVersions]);
  records.forEach(record => validatePolicyRecord(record, { domains, categories, allowSynthetic: false, supportedVersions }));
  return Object.freeze({ source: normalizedSource, records: Object.freeze(records.map(record => Object.freeze(structuredClone(record)))) });
}

function parseSourceDocument(source) {
  const normalizedSource = normalizeSourceDocument(source);
  if (normalizedSource.format !== 'html') {
    throw new PolicyValidationError(`No ${normalizedSource.format} policy parser is implemented. Preserve this source and add a reviewed parser before import.`);
  }
  return extractTikTokPolicyPage(normalizedSource.content);
}

module.exports = {
  APPROVED_SOURCES,
  MAX_SOURCE_BYTES,
  SUPPORTED_SOURCE_FORMATS,
  extractTikTokPolicyPage,
  fetchApprovedSource,
  normalizeSourceDocument,
  parseSourceDocument,
  preparePolicyImport,
  readLimitedBody
};
