const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PolicyRepository,
  PolicyValidationError,
  loadPolicySet,
  loadSyntheticFixtures
} = require('../services/policyKnowledge');
const {
  normalizeSourceDocument,
  parseSourceDocument,
  preparePolicyImport
} = require('../scripts/import-policy');

const root = path.join(__dirname, '..');
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

function fixtureParts() {
  const taxonomy = json('policies/taxonomy.json');
  const records = [
    json('policies/fixtures/synthetic_self_harm.json'),
    json('policies/fixtures/synthetic_harassment.json')
  ];
  const manifest = {
    ...json('policies/manifest.json'),
    policySetVersion: 'fixture-1',
    availableVersions: ['fixture-1'],
    ruleCount: records.length
  };
  return { manifest, taxonomy, records };
}

test('schema requires independent outcome and traceability fields', () => {
  const schema = json('policies/schema/policy-record.schema.json');
  assert.deepEqual(schema.properties.outcome.required, ['postability', 'fypEligibility', 'monetization']);
  assert.deepEqual(schema.properties.source.required, ['document', 'section', 'url', 'effectiveDate', 'retrievedDate']);
  assert.ok(schema.required.includes('synthetic'));
});

test('production loader starts empty and excludes synthetic fixtures', () => {
  const repository = loadPolicySet();
  const packageJson = json('package.json');
  assert.equal(repository.getManifest().provider, 'TikTok');
  assert.equal(repository.getManifest().ruleCount, 0);
  assert.deepEqual(repository.records, []);
  assert.equal(repository.getPolicyById('SYNTH_SELF_HARM_001'), null);
  assert.ok(packageJson.build.files.includes('!policies/fixtures{,/**/*}'));
});

test('synthetic fixtures are explicitly isolated and traceable', () => {
  const repository = loadSyntheticFixtures();
  assert.equal(repository.records.length, 2);
  for (const record of repository.records) {
    assert.equal(record.synthetic, true);
    assert.match(record.source.document, /Synthetic test fixture/);
    assert.match(record.summary, /Not TikTok policy/);
  }
});

test('repository supports ID, category, domain, and text lookup', () => {
  const repository = loadSyntheticFixtures();
  assert.equal(repository.getPolicyById('SYNTH_SELF_HARM_001').category, 'self_harm');
  assert.equal(repository.getPoliciesByCategory('harassment').length, 1);
  assert.equal(repository.getPoliciesByDomain('community_guidelines').length, 2);
  assert.equal(repository.searchPolicies('recovery')[0].id, 'SYNTH_SELF_HARM_001');
});

test('candidate retrieval is deterministic metadata matching, not a decision', () => {
  const repository = loadSyntheticFixtures();
  const candidates = repository.getCandidatePolicies({ text: 'recovery and injury', categories: ['self_harm'], maxResults: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'SYNTH_SELF_HARM_001');
  assert.ok(candidates[0].matchScore > 0);
  assert.deepEqual(candidates[0].matchedKeywords, ['injury', 'recovery']);
  assert.equal('decision' in candidates[0], false);
});

test('three policy outcomes stay independent', () => {
  const record = loadSyntheticFixtures().getPolicyById('SYNTH_SELF_HARM_001');
  assert.deepEqual(record.outcome, {
    postability: 'PROHIBIT',
    fypEligibility: 'RESTRICT',
    monetization: 'RESTRICT'
  });
});

test('invalid records fail fast for missing IDs, outcomes, sources, duplicates, and versions', () => {
  const base = fixtureParts();
  const makeRepository = records => new PolicyRepository({ ...base, records, allowSynthetic: true });

  const missingId = clone(base.records[0]);
  delete missingId.id;
  assert.throws(() => makeRepository([missingId]), PolicyValidationError);

  const invalidOutcome = clone(base.records[0]);
  invalidOutcome.outcome.monetization = 'MAYBE';
  assert.throws(() => makeRepository([invalidOutcome]), /Invalid policy outcome monetization/);

  const missingSource = clone(base.records[0]);
  delete missingSource.source.section;
  assert.throws(() => makeRepository([missingSource]), /source.section/);

  assert.throws(() => makeRepository([base.records[0], clone(base.records[0])]), /Duplicate policy ID/);

  const unsupportedVersion = clone(base.records[0]);
  unsupportedVersion.version = 'fixture-99';
  assert.throws(() => makeRepository([unsupportedVersion]), /Unsupported policy version/);
});

test('candidate API validates categories and result limits', () => {
  const repository = loadSyntheticFixtures();
  assert.throws(() => repository.getCandidatePolicies({ categories: ['not_real'] }), /Unsupported policy category/);
  assert.throws(() => repository.getCandidatePolicies({ maxResults: 0 }), /maxResults/);
});

test('import boundary normalizes supported inputs and refuses unreviewed parsing', () => {
  const source = normalizeSourceDocument({
    sourceId: 'source-1',
    document: 'Reviewed policy document',
    format: 'Markdown',
    content: '# Policy'
  });
  assert.equal(source.format, 'markdown');
  assert.throws(() => parseSourceDocument(source), /No markdown policy parser is implemented/);
  assert.throws(() => normalizeSourceDocument({ ...source, format: 'docx' }), /Unsupported source format/);
});

test('import preparation accepts only validated, non-synthetic records', () => {
  const parts = fixtureParts();
  const record = clone(parts.records[0]);
  record.synthetic = false;
  const prepared = preparePolicyImport({
    source: { sourceId: 'source-1', document: 'Reviewed source', format: 'txt', content: 'preserved source text' },
    records: [record],
    manifest: parts.manifest,
    taxonomy: parts.taxonomy
  });
  assert.equal(prepared.records[0].id, record.id);
  assert.throws(() => preparePolicyImport({
    source: prepared.source,
    records: parts.records,
    manifest: parts.manifest,
    taxonomy: parts.taxonomy
  }), /Synthetic policy record is isolated from production/);
});
