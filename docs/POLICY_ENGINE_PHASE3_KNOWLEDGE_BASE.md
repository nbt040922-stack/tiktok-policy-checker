# Phase 3 — Policy Knowledge Base

## Scope and safety boundary

Phase 3 adds a validated, versioned policy repository and deterministic candidate retrieval. It does not add an LLM, a classifier, policy decisions, or new user-interface behavior. Existing YouTube ingestion, analysis UI, downloader, authentication, and bridge code remain unchanged.

The repository currently contains **zero official TikTok policy rules**. No policy text was scraped, inferred, paraphrased, or fabricated. The two records under `policies/fixtures/` are synthetic test data and are never loaded by the production loader.

## Architecture

```text
policies/
  manifest.json                  policy-set metadata and supported domains
  taxonomy.json                  stable internal category IDs
  schema/policy-record.schema.json
  community_guidelines/          sourced records added later
  fyp_eligibility/               sourced records added later
  monetization/                  sourced records added later
  fixtures/                      synthetic tests only

services/policyKnowledge/
  validation.js                  fail-fast contract validation
  index.js                       versioned repository and retrieval API

scripts/import-policy/
  index.js                       reviewed-import boundary; no parser yet
```

`loadPolicySet()` reads only the domain directories declared in the manifest. It does not walk the fixture directory. `loadSyntheticFixtures()` is a separate, explicit test-only entry point.

## Policy record contract

Every record has a stable ID, domain, category/subcategory, title, summary, rule text, severity, contextual allowances, exceptions, examples, keywords, source metadata, policy-set version, and a `synthetic` marker. Unknown fields and missing required fields are rejected.

The outcome model deliberately keeps three questions independent:

- `postability`: whether a post may be allowed on the platform.
- `fypEligibility`: whether it may be eligible for recommendation.
- `monetization`: whether it may be eligible for monetization.

Each value is one of `ALLOW`, `RESTRICT`, `PROHIBIT`, or `UNKNOWN`. The repository never collapses these into a single verdict.

## Taxonomy

`policies/taxonomy.json` provides stable internal categories for retrieval and future classification. These identifiers are application taxonomy only and do not claim to match official TikTok section names. A future source-backed import may map an official section to one category while preserving the original document and section in `source`.

## Versioning and traceability

The manifest declares the active policy-set version, available versions, dates, sources, rule count, and domains. Every record declares its version. Unsupported versions and duplicate IDs within the same version fail at load time.

Every record must preserve:

- source document name;
- exact section reference;
- source URL when available;
- effective date when known;
- retrieval date when known.

Null dates and URLs mean unknown or unavailable; they must not be guessed. The initial manifest uses `uninitialized`, empty sources, and a rule count of zero until reviewed policy documents are supplied.

## Repository APIs

- `loadPolicySet({ rootDir, version })`
- `getPolicyById(id)`
- `getPoliciesByCategory(category)`
- `getPoliciesByDomain(domain)`
- `searchPolicies(query)`
- `getManifest()`
- `getCandidatePolicies({ text, categories, maxResults })`

The module exports both repository instance methods and a facade backed by the latest production `loadPolicySet()` call.

## Segment-to-policy boundary

`getCandidatePolicies()` is the Phase 4 integration boundary. It accepts segment text plus optional category tags and returns ranked policy candidates. Ranking uses deterministic normalized text, keyword overlap, metadata overlap, and category matches. The result includes `matchScore` and `matchedKeywords`; it does not return or imply a policy decision.

## Import strategy

The import boundary recognizes HTML, PDF, Markdown, text, and JSON source envelopes. It validates source identity and content, then validates normalized records against the manifest and taxonomy. Parsing is intentionally not implemented without real source documents and review rules: `parseSourceDocument()` fails explicitly and instructs callers to preserve the source. Unsupported input is never silently dropped.

A later reviewed importer should:

1. store an immutable copy or checksum of the supplied source;
2. extract sections without rewriting their meaning;
3. map each normalized record back to a source section;
4. require human review for outcomes, exceptions, and examples;
5. validate the complete policy set before atomically publishing a new version;
6. update manifest sources, dates, version, and rule count together.

## Validation and tests

Load and import fail fast for malformed manifests/taxonomies, missing IDs, invalid domains or categories, unsupported versions, invalid outcome values, incomplete source metadata, unexpected fields, duplicate IDs, or synthetic records entering the production path.

Tests cover schema shape, empty production loading, fixture isolation, lookup APIs, deterministic candidate retrieval, independent outcomes, validation failures, and the import boundary.

## Current limitations

- No official TikTok policy documents or rules have been ingested.
- No source parser, OCR, or policy-diff tool exists yet.
- Retrieval is deterministic lexical matching, not semantic reasoning.
- Candidate retrieval is not connected to the Phase 2 analysis pipeline yet.
- There is no classifier, adjudication logic, confidence calibration, or LLM.

## Inputs needed before Phase 4

Provide authoritative, version-identifiable source documents for:

- TikTok Community Guidelines;
- For You feed eligibility standards;
- monetization or creator-rewards eligibility rules relevant to the target program and region.

For each source, provide the canonical URL or original file, locale, publication/effective date, retrieval date, and target region/program where applicable. Phase 4 should begin only after the normalized records and outcome mappings have been reviewed against those sources.
