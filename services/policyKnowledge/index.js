const fs = require('node:fs');
const path = require('node:path');
const {
  PolicyValidationError,
  assertUniquePolicyIds,
  validateManifest,
  validatePolicyRecord,
  validateTaxonomy
} = require('./validation');

const DEFAULT_POLICY_ROOT = path.join(__dirname, '..', '..', 'policies');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new PolicyValidationError(`Unable to load JSON ${filePath}: ${error.message}`);
  }
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return jsonFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : [];
  });
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class PolicyRepository {
  constructor({ manifest, taxonomy, records, version, allowSynthetic = false, requireReviewed = false }) {
    validateManifest(manifest);
    validateTaxonomy(taxonomy);
    const supportedVersions = new Set([manifest.policySetVersion, ...manifest.availableVersions]);
    this.version = version || manifest.policySetVersion;
    if (!supportedVersions.has(this.version)) throw new PolicyValidationError(`Unsupported policy version: ${this.version}`);
    const domains = new Set(manifest.domains);
    const categories = new Set(taxonomy.categories.map(category => category.id));
    const approvedSourceUrls = new Set(manifest.sources.map(source => source.url));
    records.forEach(record => validatePolicyRecord(record, {
      domains,
      categories,
      allowSynthetic,
      supportedVersions,
      approvedSourceUrls: requireReviewed ? approvedSourceUrls : undefined,
      requireReviewed
    }));
    for (const supportedVersion of supportedVersions) {
      assertUniquePolicyIds(records.filter(record => record.version === supportedVersion));
    }
    const selected = records.filter(record => record.version === this.version);
    this.manifest = Object.freeze(clone(manifest));
    this.taxonomy = Object.freeze(clone(taxonomy));
    this.records = Object.freeze(selected.map(record => Object.freeze(clone(record))));
    this.byId = new Map(this.records.map(record => [record.id, record]));
  }

  getManifest() {
    return clone({ ...this.manifest, selectedVersion: this.version });
  }

  getPolicyById(id) {
    const record = this.byId.get(id);
    return record ? clone(record) : null;
  }

  getPoliciesByCategory(category) {
    return this.records.filter(record => record.category === category).map(clone);
  }

  getPoliciesByDomain(domain) {
    return this.records.filter(record => record.domain === domain).map(clone);
  }

  searchPolicies(query) {
    const terms = normalizeText(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    return this.records
      .map(record => {
        const haystack = normalizeText([record.title, record.summary, record.ruleText, record.category, record.subcategory, ...record.keywords].join(' '));
        return { record, score: terms.filter(term => haystack.includes(term)).length };
      })
      .filter(match => match.score > 0)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .map(match => clone(match.record));
  }

  getCandidatePolicies({ text = '', categories = [], maxResults = 10 } = {}) {
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new PolicyValidationError('maxResults must be an integer from 1 to 100');
    }
    const knownCategories = new Set(this.taxonomy.categories.map(category => category.id));
    for (const category of categories) {
      if (!knownCategories.has(category)) throw new PolicyValidationError(`Unsupported policy category: ${category}`);
    }
    const normalizedInput = normalizeText(text);
    const inputTerms = new Set(normalizedInput.split(' ').filter(Boolean));
    const requestedCategories = new Set(categories);
    return this.records
      .map(record => {
        const matchedKeywords = record.keywords.filter(keyword => normalizedInput.includes(normalizeText(keyword)));
        const metadataTerms = normalizeText(`${record.title} ${record.summary} ${record.subcategory}`).split(' ');
        const metadataMatches = metadataTerms.filter(term => inputTerms.has(term)).length;
        const score = matchedKeywords.length * 4 + metadataMatches + (requestedCategories.has(record.category) ? 10 : 0);
        return { policy: record, score, matchedKeywords };
      })
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.policy.id.localeCompare(b.policy.id))
      .slice(0, maxResults)
      .map(candidate => ({ ...clone(candidate.policy), matchScore: candidate.score, matchedKeywords: candidate.matchedKeywords }));
  }
}

function loadRecords(rootDir, domains) {
  return domains.flatMap(domain => jsonFiles(path.join(rootDir, domain)).flatMap(file => {
    const value = readJson(file);
    return Array.isArray(value) ? value : [value];
  }));
}

function loadPolicySet({ rootDir = DEFAULT_POLICY_ROOT, version } = {}) {
  const manifest = readJson(path.join(rootDir, 'manifest.json'));
  const taxonomy = readJson(path.join(rootDir, 'taxonomy.json'));
  const records = loadRecords(rootDir, manifest.domains || []);
  const repository = new PolicyRepository({ manifest, taxonomy, records, version, allowSynthetic: false, requireReviewed: true });
  if (repository.version === manifest.policySetVersion && repository.records.length !== manifest.ruleCount) {
    throw new PolicyValidationError(`Manifest ruleCount ${manifest.ruleCount} does not match loaded rules ${repository.records.length}`);
  }
  activeRepository = repository;
  return repository;
}

function loadSyntheticFixtures({ rootDir = DEFAULT_POLICY_ROOT } = {}) {
  const baseManifest = readJson(path.join(rootDir, 'manifest.json'));
  const taxonomy = readJson(path.join(rootDir, 'taxonomy.json'));
  const records = jsonFiles(path.join(rootDir, 'fixtures')).map(readJson);
  const versions = [...new Set(records.map(record => record.version))];
  if (versions.length !== 1) throw new PolicyValidationError('Synthetic fixtures must use exactly one fixture version');
  const manifest = { ...baseManifest, policySetVersion: versions[0], availableVersions: versions, ruleCount: records.length };
  return new PolicyRepository({ manifest, taxonomy, records, version: versions[0], allowSynthetic: true });
}

let activeRepository = null;
function active() {
  if (!activeRepository) throw new PolicyValidationError('Policy set is not loaded');
  return activeRepository;
}

module.exports = {
  DEFAULT_POLICY_ROOT,
  PolicyRepository,
  PolicyValidationError,
  getCandidatePolicies: options => active().getCandidatePolicies(options),
  getManifest: () => active().getManifest(),
  getPoliciesByCategory: category => active().getPoliciesByCategory(category),
  getPoliciesByDomain: domain => active().getPoliciesByDomain(domain),
  getPolicyById: id => active().getPolicyById(id),
  loadPolicySet,
  loadSyntheticFixtures,
  normalizeText,
  searchPolicies: query => active().searchPolicies(query)
};
