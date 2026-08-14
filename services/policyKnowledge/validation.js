const OUTCOME_VALUES = Object.freeze(['ALLOW', 'RESTRICT', 'PROHIBIT', 'UNKNOWN']);
const SEVERITY_VALUES = Object.freeze(['low', 'medium', 'high', 'critical', 'unknown']);
const OFFICIAL_SOURCE_HOSTS = new Set(['www.tiktok.com', 'support.tiktok.com', 'newsroom.tiktok.com']);
const RECORD_FIELDS = Object.freeze([
  'id', 'domain', 'category', 'subcategory', 'title', 'summary', 'ruleText', 'outcome',
  'severity', 'contextualAllowances', 'exceptions', 'examplesAllowed', 'examplesRestricted',
  'examplesProhibited', 'keywords', 'source', 'version', 'synthetic', 'platformTreatment',
  'reviewStatus'
]);
const REQUIRED_RECORD_FIELDS = Object.freeze(RECORD_FIELDS.filter(field => !['platformTreatment', 'reviewStatus'].includes(field)));

class PolicyValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'PolicyValidationError';
    this.code = 'POLICY_VALIDATION_ERROR';
    this.details = details;
  }
}

function fail(message, details = []) {
  throw new PolicyValidationError(message, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
}

function validateDate(value, path) {
  if (value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(`${path} must be null or an ISO date (YYYY-MM-DD)`);
  }
}

function validateStringArray(value, path) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail(`${path} must be an array of strings`);
  if (new Set(value).size !== value.length) fail(`${path} must not contain duplicates`);
}

function validateManifest(manifest) {
  if (!isObject(manifest)) fail('Policy manifest must be an object');
  for (const field of ['provider', 'schemaVersion', 'policySetVersion']) requireString(manifest[field], `manifest.${field}`);
  if (!Array.isArray(manifest.availableVersions) || manifest.availableVersions.some(version => typeof version !== 'string' || !version)) {
    fail('manifest.availableVersions must be an array of version strings');
  }
  if (!Array.isArray(manifest.domains) || !manifest.domains.length) fail('manifest.domains must be a non-empty array');
  if (new Set(manifest.domains).size !== manifest.domains.length) fail('manifest.domains must not contain duplicates');
  if (!Array.isArray(manifest.sources)) fail('manifest.sources must be an array');
  if ('locale' in manifest) requireString(manifest.locale, 'manifest.locale');
  for (const [index, source] of manifest.sources.entries()) {
    if (!isObject(source)) fail(`manifest.sources[${index}] must be an object`);
    for (const field of ['id', 'title', 'url', 'locale', 'retrievedAt', 'policyRelease', 'versionMarker', 'checksumSha256']) {
      requireString(source[field], `manifest.sources[${index}].${field}`);
    }
    let sourceUrl;
    try { sourceUrl = new URL(source.url); } catch (_) { fail(`Invalid manifest source URL: ${source.url}`); }
    if (sourceUrl.protocol !== 'https:' || !OFFICIAL_SOURCE_HOSTS.has(sourceUrl.hostname)) fail(`Unapproved manifest source URL: ${source.url}`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(source.retrievedAt)) fail(`Invalid source retrieval timestamp: ${source.retrievedAt}`);
    if (!/^[a-f0-9]{64}$/.test(source.checksumSha256)) fail(`Invalid source checksum: ${source.checksumSha256}`);
    validateDate(source.effectiveDate, `manifest.sources[${index}].effectiveDate`);
  }
  if (!Number.isInteger(manifest.ruleCount) || manifest.ruleCount < 0) fail('manifest.ruleCount must be a non-negative integer');
  validateDate(manifest.effectiveDate, 'manifest.effectiveDate');
  validateDate(manifest.lastUpdated, 'manifest.lastUpdated');
  return manifest;
}

function validateTaxonomy(taxonomy) {
  if (!isObject(taxonomy)) fail('Policy taxonomy must be an object');
  requireString(taxonomy.version, 'taxonomy.version');
  if (!Array.isArray(taxonomy.categories) || !taxonomy.categories.length) fail('taxonomy.categories must be a non-empty array');
  const ids = new Set();
  for (const [index, category] of taxonomy.categories.entries()) {
    requireString(category?.id, `taxonomy.categories[${index}].id`);
    requireString(category?.label, `taxonomy.categories[${index}].label`);
    if (!/^[a-z][a-z0-9_]*$/.test(category.id)) fail(`Invalid category ID: ${category.id}`);
    if (ids.has(category.id)) fail(`Duplicate taxonomy category: ${category.id}`);
    ids.add(category.id);
  }
  return taxonomy;
}

function validatePolicyRecord(record, { domains, categories, allowSynthetic = false, supportedVersions, approvedSourceUrls, requireReviewed = false } = {}) {
  if (!isObject(record)) fail('Policy record must be an object');
  const missing = REQUIRED_RECORD_FIELDS.filter(field => !(field in record));
  if (missing.length) fail(`Policy record is missing required fields: ${missing.join(', ')}`, missing);
  const unknown = Object.keys(record).filter(field => !RECORD_FIELDS.includes(field));
  if (unknown.length) fail(`Policy record has unsupported fields: ${unknown.join(', ')}`, unknown);

  requireString(record.id, 'policy.id');
  if (!/^[A-Z0-9_]+$/.test(record.id)) fail(`Invalid policy ID: ${record.id}`);
  for (const field of ['domain', 'category', 'subcategory']) {
    requireString(record[field], `policy.${field}`);
    if (!/^[a-z][a-z0-9_]*$/.test(record[field])) fail(`Invalid policy ${field}: ${record[field]}`);
  }
  if (domains && !domains.has(record.domain)) fail(`Unsupported policy domain: ${record.domain}`);
  if (categories && !categories.has(record.category)) fail(`Unsupported policy category: ${record.category}`);
  for (const field of ['title', 'summary', 'ruleText', 'version']) requireString(record[field], `policy.${field}`);
  if (supportedVersions && !supportedVersions.has(record.version)) fail(`Unsupported policy version: ${record.version}`);

  if (!isObject(record.outcome)) fail('policy.outcome must be an object');
  const outcomeFields = ['postability', 'fypEligibility', 'monetization'];
  for (const field of outcomeFields) {
    if (!OUTCOME_VALUES.includes(record.outcome[field])) fail(`Invalid policy outcome ${field}: ${record.outcome[field]}`);
  }
  const unknownOutcomes = Object.keys(record.outcome).filter(field => !outcomeFields.includes(field));
  if (unknownOutcomes.length) fail(`Unsupported outcome fields: ${unknownOutcomes.join(', ')}`);
  if (!SEVERITY_VALUES.includes(record.severity)) fail(`Invalid policy severity: ${record.severity}`);
  if ('platformTreatment' in record) {
    if (!isObject(record.platformTreatment)) fail('policy.platformTreatment must be an object');
    const treatmentFields = ['ageRestricted', 'warningScreen', 'fyfEligible'];
    for (const field of treatmentFields) {
      if (record.platformTreatment[field] !== null && typeof record.platformTreatment[field] !== 'boolean') {
        fail(`policy.platformTreatment.${field} must be boolean or null`);
      }
    }
    const unknownTreatments = Object.keys(record.platformTreatment).filter(field => !treatmentFields.includes(field));
    if (unknownTreatments.length) fail(`Unsupported platform treatment fields: ${unknownTreatments.join(', ')}`);
  }
  if ('reviewStatus' in record && !['DRAFT', 'REVIEWED'].includes(record.reviewStatus)) fail(`Invalid review status: ${record.reviewStatus}`);
  if (requireReviewed && record.reviewStatus !== 'REVIEWED') fail(`Production policy is not reviewed: ${record.id}`);
  if (requireReviewed && record.synthetic !== false) fail(`Production policy must set synthetic=false: ${record.id}`);

  for (const field of ['contextualAllowances', 'exceptions', 'examplesAllowed', 'examplesRestricted', 'examplesProhibited', 'keywords']) {
    validateStringArray(record[field], `policy.${field}`);
  }

  if (!isObject(record.source)) fail('policy.source must be an object');
  const sourceFields = ['document', 'section', 'url', 'effectiveDate', 'retrievedDate', 'headingPath', 'sourceChecksum', 'locale', 'policyRelease'];
  for (const field of ['document', 'section']) requireString(record.source[field], `policy.source.${field}`);
  if (requireReviewed && /^unknown$/i.test(record.source.document.trim())) fail(`Production policy has an unknown source document: ${record.id}`);
  for (const field of ['document', 'section', 'url', 'effectiveDate', 'retrievedDate']) {
    if (!(field in record.source)) fail(`policy.source.${field} is required`);
  }
  const unknownSource = Object.keys(record.source).filter(field => !sourceFields.includes(field));
  if (unknownSource.length) fail(`Unsupported source fields: ${unknownSource.join(', ')}`);
  if (record.source.url !== null) {
    requireString(record.source.url, 'policy.source.url');
    try { new URL(record.source.url); } catch (_) { fail('policy.source.url must be null or a valid URL'); }
  }
  if (approvedSourceUrls && !approvedSourceUrls.has(record.source.url)) fail(`Policy source URL is not approved: ${record.source.url}`);
  if ('headingPath' in record.source) validateStringArray(record.source.headingPath, 'policy.source.headingPath');
  if ('sourceChecksum' in record.source && !/^[a-f0-9]{64}$/.test(record.source.sourceChecksum)) fail('policy.source.sourceChecksum must be SHA-256');
  for (const field of ['locale', 'policyRelease']) {
    if (field in record.source) requireString(record.source[field], `policy.source.${field}`);
  }
  validateDate(record.source.effectiveDate, 'policy.source.effectiveDate');
  validateDate(record.source.retrievedDate, 'policy.source.retrievedDate');

  if (typeof record.synthetic !== 'boolean') fail('policy.synthetic must be boolean');
  if (record.synthetic && !allowSynthetic) fail(`Synthetic policy record is isolated from production: ${record.id}`);
  return record;
}

function assertUniquePolicyIds(records) {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) fail(`Duplicate policy ID: ${record.id}`);
    ids.add(record.id);
  }
}

module.exports = {
  OUTCOME_VALUES,
  PolicyValidationError,
  assertUniquePolicyIds,
  validateManifest,
  validatePolicyRecord,
  validateTaxonomy
};
