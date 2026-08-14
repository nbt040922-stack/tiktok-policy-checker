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

const GENERIC_TERMS = new Set(['allow', 'content', 'context', 'discussion', 'harm', 'information', 'policy', 'show', 'use', 'video']);
const BENIGN_CONTEXT_TERMS = ['documentary', 'educational', 'education', 'medical', 'news', 'report', 'discuss', 'explain', 'quote', 'prevention', 'recovery', 'criticism', 'condemn', 'debunk', 'counterspeech', 'satire', 'history', 'historical', 'public interest'];

function scorePolicy(record, { text = '', categories = [] } = {}) {
  const normalizedInput = normalizeText(text);
  const contains = phrase => ` ${normalizedInput} `.includes(` ${normalizeText(phrase)} `);
  const inputTerms = new Set(normalizedInput.split(' ').filter(Boolean));
  const requestedCategories = new Set(categories);
  const matchedKeywords = record.keywords.filter(contains);
  const benignContext = BENIGN_CONTEXT_TERMS.some(term => normalizedInput.includes(term));
  if (record.id === 'TT25_CG_PUBLIC_INTEREST_001' && !benignContext) {
    return { score: 0, matchedKeywords: [], metadataMatches: [], benignContext, contextual: false };
  }
  let score = matchedKeywords.reduce((total, keyword) => {
    const normalized = normalizeText(keyword);
    return total + (normalized.includes(' ') ? 8 : GENERIC_TERMS.has(normalized) ? 1 : 4);
  }, 0);
  const subcategory = normalizeText(record.subcategory.replace(/_/g, ' '));
  if (subcategory.includes(' ') && contains(subcategory)) score += 6;
  const category = normalizeText(record.category.replace(/_/g, ' '));
  if (contains(category)) score += 5;
  if (requestedCategories.has(record.category)) score += 6;

  const categoryTerms = new Set(category.split(' '));
  const metadataTerms = normalizeText(`${record.title} ${record.summary}`)
    .split(' ')
    .filter(term => term.length > 3 && !GENERIC_TERMS.has(term) && !categoryTerms.has(term));
  const metadataMatches = [...new Set(metadataTerms.filter(term => inputTerms.has(term)))];
  const matchedAllowances = record.contextualAllowances.filter(contains);
  const recoveryContext = /recovery|prevention/.test(record.subcategory)
    && ['seek help', 'warning signs', 'prevention', 'recovery'].some(contains);
  const contextual = benignContext && requestedCategories.has(record.category)
    && (matchedKeywords.length || matchedAllowances.length || recoveryContext || normalizedInput.includes(subcategory))
    && (record.contextualAllowances.length || /context|recovery|prevention/.test(record.subcategory));
  if (contextual) score += 6;
  if (benignContext && record.outcome.postability === 'PROHIBIT') score = Math.max(0, score - 2);
  if (record.id === 'TT25_CG_PUBLIC_INTEREST_001' && benignContext && requestedCategories.size) score += 7;
  return { score, matchedKeywords, metadataMatches, benignContext, contextual };
}

function diverseCandidates(candidates, maxResults) {
  const selected = [];
  const categoryCounts = new Map();
  for (const candidate of candidates) {
    const count = categoryCounts.get(candidate.policy.category) || 0;
    if (count >= 2 && candidate.policy.id !== 'TT25_CG_PUBLIC_INTEREST_001') continue;
    if (count >= 1 && !candidate.matchedKeywords.length && !candidate.contextual && candidate.policy.id !== 'TT25_CG_PUBLIC_INTEREST_001') continue;
    selected.push(candidate);
    categoryCounts.set(candidate.policy.category, count + 1);
    if (selected.length === maxResults) break;
  }
  return selected;
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

  getCandidatePolicies({ text = '', categories = [], maxResults = 10, minScore = 1 } = {}) {
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new PolicyValidationError('maxResults must be an integer from 1 to 100');
    }
    const knownCategories = new Set(this.taxonomy.categories.map(category => category.id));
    for (const category of categories) {
      if (!knownCategories.has(category)) throw new PolicyValidationError(`Unsupported policy category: ${category}`);
    }
    if (!Number.isFinite(minScore) || minScore < 0) throw new PolicyValidationError('minScore must be a non-negative number');
    const ranked = this.records
      .map(record => {
        const scored = scorePolicy(record, { text, categories });
        return { policy: record, ...scored };
      })
      .filter(candidate => candidate.score >= minScore)
      .sort((a, b) => b.score - a.score || Number(b.contextual) - Number(a.contextual) || a.policy.id.localeCompare(b.policy.id));
    return diverseCandidates(ranked, maxResults)
      .map(candidate => ({ ...clone(candidate.policy), matchScore: candidate.score, matchedKeywords: candidate.matchedKeywords, matchReasons: { metadata: candidate.metadataMatches, benignContext: candidate.benignContext, contextual: candidate.contextual } }));
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
  scorePolicy,
  searchPolicies: query => active().searchPolicies(query)
};
