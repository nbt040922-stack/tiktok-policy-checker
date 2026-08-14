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
  APPROVED_SOURCES,
  fetchApprovedSource,
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
  assert.deepEqual(schema.properties.platformTreatment.required, ['ageRestricted', 'warningScreen', 'fyfEligible']);
});

test('production loader loads the reviewed official set and excludes synthetic fixtures', () => {
  const repository = loadPolicySet();
  const packageJson = json('package.json');
  assert.equal(repository.getManifest().provider, 'TikTok');
  assert.equal(repository.getManifest().policySetVersion, 'tiktok-global-2025-h2');
  assert.equal(repository.records.length, repository.getManifest().ruleCount);
  assert.equal(repository.records.length, 54);
  assert.equal(repository.getPolicyById('SYNTH_SELF_HARM_001'), null);
  assert.ok(packageJson.build.files.includes('!policies/fixtures{,/**/*}'));
  for (const record of repository.records) {
    assert.equal(record.synthetic, false);
    assert.equal(record.reviewStatus, 'REVIEWED');
    assert.equal(record.version, repository.version);
    assert.ok(record.source.section);
  }
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

test('official source allowlist contains only explicit static TikTok policy URLs', () => {
  assert.equal(APPROVED_SOURCES.length, 11);
  const allowedHosts = new Set(['www.tiktok.com', 'support.tiktok.com', 'newsroom.tiktok.com']);
  for (const source of APPROVED_SOURCES) {
    const url = new URL(source.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(allowedHosts.has(url.hostname));
    assert.equal(url.searchParams.get('cgversion'), '2025H2update');
  }
});

test('official source fetch captures metadata and normalized content checksum', async () => {
  const page = { title: 'Overview', realSlug: 'overview', version: '2025H2update', contents: [] };
  const context = { state: { loaderData: { 'routes/safety/$lang/$l1/$l2': { cgData: { postValue: page } } } } };
  const html = `<script type="application/json" data-ttark="__remixContext">${encodeURIComponent(JSON.stringify(context))}</script>`;
  const source = await fetchApprovedSource('overview', {
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-length': String(Buffer.byteLength(html)) } }),
    now: () => new Date('2026-08-14T15:16:41Z')
  });
  assert.equal(source.title, 'Overview');
  assert.equal(source.retrievedAt, '2026-08-14T15:16:41Z');
  assert.match(source.checksumSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(source.normalizedContent).realSlug, 'overview');
});

test('production source URLs, checksums, age treatments, and review boundary validate', () => {
  const repository = loadPolicySet();
  const approved = new Set(repository.getManifest().sources.map(source => source.url));
  for (const record of repository.records) {
    assert.ok(approved.has(record.source.url));
    assert.match(record.source.sourceChecksum, /^[a-f0-9]{64}$/);
  }
  assert.equal(repository.getPolicyById('TT25_CG_SELF_HARM_001').platformTreatment.ageRestricted, true);
  assert.equal(repository.getPolicyById('TT25_CG_GRAPHIC_002').platformTreatment.ageRestricted, null);

  const draft = clone(repository.records[0]);
  draft.reviewStatus = 'DRAFT';
  assert.throws(() => new PolicyRepository({
    manifest: repository.getManifest(), taxonomy: repository.taxonomy, records: [draft], requireReviewed: true
  }), /not reviewed/);
});

test('public-interest exception preserves conditional treatment and independent outcomes', () => {
  const record = loadPolicySet().getPolicyById('TT25_CG_PUBLIC_INTEREST_001');
  assert.ok(record.contextualAllowances.includes('documentary'));
  assert.ok(record.contextualAllowances.includes('counterspeech'));
  assert.deepEqual(record.outcome, { postability: 'ALLOW', fypEligibility: 'UNKNOWN', monetization: 'UNKNOWN' });
  assert.equal(record.platformTreatment.warningScreen, null);
});

test('synthetic transcript retrieval returns relevant official policy IDs without verdicts', () => {
  const repository = loadPolicySet();
  const cases = [
    ['discussion of suicide recovery', 'self_harm', 'TT25_CG_SELF_HARM_002'],
    ['direct targeted insult', 'harassment', 'TT25_CG_HARASSMENT_001'],
    ['graphic injury description', 'graphic_content', 'TT25_CG_GRAPHIC_001'],
    ['violent threat', 'violence', 'TT25_CG_VIOLENCE_001'],
    ['professional stunt documentary reports danger without promotion', 'dangerous_activities', 'TT25_CG_DANGEROUS_003'],
    ['explicit sexual activity and sexual service', 'sexual_content', 'TT25_CG_SEXUAL_001'],
    ['weapon discussion in news context', 'weapons', 'TT25_CG_WEAPONS_001']
  ];
  for (const [text, category, expectedId] of cases) {
    const [candidate] = repository.getCandidatePolicies({ text, categories: [category], maxResults: 1 });
    assert.equal(candidate.id, expectedId);
    assert.equal('decision' in candidate, false);
  }
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
