const {
  PolicyValidationError,
  validateManifest,
  validatePolicyRecord,
  validateTaxonomy
} = require('../../services/policyKnowledge/validation');

const SUPPORTED_SOURCE_FORMATS = Object.freeze(['html', 'pdf', 'markdown', 'txt', 'json']);

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PolicyValidationError(`${field} must be a non-empty string`);
  }
}

function normalizeSourceDocument(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new PolicyValidationError('Import source must be an object');
  }
  for (const field of ['sourceId', 'document', 'format', 'content']) requireText(source[field], `source.${field}`);
  const format = source.format.toLowerCase();
  if (!SUPPORTED_SOURCE_FORMATS.includes(format)) {
    throw new PolicyValidationError(`Unsupported source format: ${source.format}`);
  }
  return Object.freeze({
    sourceId: source.sourceId.trim(),
    document: source.document.trim(),
    format,
    content: source.content,
    url: source.url || null,
    effectiveDate: source.effectiveDate || null,
    retrievedDate: source.retrievedDate || null
  });
}

function preparePolicyImport({ source, records, manifest, taxonomy }) {
  const normalizedSource = normalizeSourceDocument(source);
  validateManifest(manifest);
  validateTaxonomy(taxonomy);
  if (!Array.isArray(records) || !records.length) {
    throw new PolicyValidationError('Import records must be a non-empty array');
  }
  const domains = new Set(manifest.domains);
  const categories = new Set(taxonomy.categories.map(category => category.id));
  const supportedVersions = new Set([manifest.policySetVersion, ...manifest.availableVersions]);
  records.forEach(record => validatePolicyRecord(record, {
    domains,
    categories,
    allowSynthetic: false,
    supportedVersions
  }));
  return Object.freeze({
    source: normalizedSource,
    records: Object.freeze(records.map(record => Object.freeze(structuredClone(record))))
  });
}

function parseSourceDocument(source) {
  const normalizedSource = normalizeSourceDocument(source);
  throw new PolicyValidationError(
    `No ${normalizedSource.format} policy parser is implemented. Preserve this source and add a reviewed parser before import.`
  );
}

module.exports = {
  SUPPORTED_SOURCE_FORMATS,
  normalizeSourceDocument,
  parseSourceDocument,
  preparePolicyImport
};
