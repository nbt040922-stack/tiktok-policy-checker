# Phase 3.5 — Official TikTok Global Policy Ingestion

## Result

Phase 3.5 ingests a reviewed, production policy set derived only from official TikTok Global English Community Guidelines pages. The active set is `tiktok-global-2025-h2`, released 2025-08-14 and effective 2025-09-13. Direct retrieval on 2026-08-14 showed the same `2025H2update` marker as TikTok's current version; no newer Community Guidelines version was found.

The old `/community-guidelines/en/...` routes now redirect to `/safety/en/policies-and-engagement/...`. Records use the new official URLs while preserving the explicit `cgversion=2025H2update` query.

## Source capture

The allowlist contains eleven explicit `https://www.tiktok.com/` policy URLs. The importer:

- performs static HTML requests without executing JavaScript;
- uses a 15-second timeout and 4 MiB response limit;
- rejects redirects, non-HTTPS URLs, unlisted IDs, unexpected slugs, and unexpected version markers;
- extracts TikTok's embedded Remix `postValue` policy payload;
- hashes normalized JSON with SHA-256.

Full page bodies are not vendored. The source manifest preserves canonical URLs, titles, locale, retrieval timestamp, release/effective dates, version markers, normalized content sizes, and checksums. This avoids copying large official pages while retaining a reproducible capture fingerprint.

## Production set

- Rules: 54
- Internal categories covered: 27 of 27
- Domains: community guidelines, FYF eligibility, monetization
- Production markers: every rule has `synthetic: false` and `reviewStatus: REVIEWED`
- Fixtures: retained only under `policies/fixtures/`, excluded by the production loader and release package

Rules are atomic policy concepts rather than webpage copies. Text is a short normalization of the source treatment block. Official page title and exact heading path remain separate from the internal category.

## Outcome mapping

- `NOT ALLOWED` maps to `postability: PROHIBIT`.
- `FYF INELIGIBLE` maps to `postability: ALLOW`, `fypEligibility: PROHIBIT` only where the source distinguishes remaining on TikTok from recommendation eligibility.
- `ALLOWED` maps to `postability: ALLOW`; FYF and monetization remain `UNKNOWN` unless separately stated.
- `AGE-RESTRICTED` sets `platformTreatment.ageRestricted: true`; it is not represented as `postability: RESTRICT`.
- Conditional terms such as “may” and region-specific treatment remain `UNKNOWN` rather than being promoted to a global result.
- Monetization remains `UNKNOWN` unless the Accounts and Features source directly establishes a monetization restriction.

## Schema migration

Schema version `1.1.0` adds two optional, backward-compatible fields:

```json
{
  "platformTreatment": {
    "ageRestricted": true,
    "warningScreen": null,
    "fyfEligible": false
  },
  "reviewStatus": "REVIEWED"
}
```

Source records may also preserve `headingPath`, `sourceChecksum`, `locale`, and `policyRelease`. Phase 3 fixtures remain valid without the new optional fields. Production loading is stricter: it requires reviewed, non-synthetic records and approved source URLs.

## Public-interest treatment

The Enforcement source identifies documentary, educational, medical or scientific, counterspeech, satirical, and artistic exceptions. A qualifying exception can allow content to remain, but TikTok may still exclude it from the FYF or apply a warning or context label. Therefore the normalized exception has `postability: ALLOW`, while FYF and monetization remain `UNKNOWN`; possible treatments are documented rather than guessed.

## Human-review boundary

The importer can fetch and normalize allowlisted sources, but it does not automatically publish policy rules. Extracted content must be converted into atomic drafts, reviewed against the official heading, marked `REVIEWED`, and then loaded. The production loader rejects `DRAFT`, unapproved URLs, wrong versions, synthetic records, duplicate IDs, missing sections, and manifest count mismatches.

## Phase boundaries

No LLM, embeddings, vector database, classifier, originality detector, or KEEP/REVIEW/REMOVE adjudication was added. Phase 2 YouTube ingestion and its temporary classifier remain unchanged. `getCandidatePolicies()` continues to return deterministic retrieval candidates only.

## Verification sample

The normalized records for self-harm, graphic content, harassment, hate speech, dangerous activity, misinformation, unoriginal content, and public-interest exceptions were compared to the corresponding official 2025-H2 treatment blocks. Region-dependent weapon treatment and conditional monetization language remain explicitly unresolved rather than globally inferred.
