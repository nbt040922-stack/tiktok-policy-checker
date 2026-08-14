# Phase 4.1 Retrieval and Decision Calibration

## Result

PASS. The local Qwen3-14B Q4_K_M architecture is retained, while retrieval noise, neutral bypass, model authority, cache coupling, and deterministic decision mapping are corrected.

## Calibrated pipeline

1. A deterministic risk screen assigns NONE, LOW, MEDIUM, or HIGH from the current transcript segment and its immediate neighbors.
2. Policy retrieval uses exact/specific phrase weighting, a minimum score of five, and at most two candidates from one category.
3. Neutral segments with no qualifying candidate use `PRECHECK_KEEP` without Qwen.
4. Other segments send up to five grounded candidates to Qwen, which returns findings only.
5. A pure deterministic engine maps findings and canonical policy metadata to KEEP, REVIEW, or REMOVE.
6. Cache v2 stores findings; current thresholds are reapplied on cache hits.

## Retrieval controls

- Multiword policy phrases score more than specific single words; generic terms have low weight.
- Broad category/title metadata overlap does not create a candidate.
- Contextual-allowance boosts require real keyword, allowance, or recovery/prevention evidence.
- Public-interest policy is retrieved only for supported reporting, documentary, educational, quotation, or debunking context.
- Diversity is capped at two candidates per category.

## Decision controls

- Qwen cannot choose the final verdict or invent policy treatment.
- Prohibited postability at confidence 0.85 or greater maps to REMOVE unless a supported exception applies.
- Visual dependency, incomplete/conflicting evidence, FYF prohibition, age restriction, and unknown/restricted postability map to REVIEW.
- UNKNOWN monetization alone does not force REVIEW.
- Public-interest override requires the corresponding retrieved policy plus a controlled benign context.

## Measured result

| Check | Result |
| --- | ---: |
| Balanced benchmark | 40/40 (100%) |
| False KEEP / REMOVE / REVIEW | 0 / 0 / 0 |
| Neutral bypass | 10/10 (100%) |
| Qwen calls on balanced suite | 30/40 (25% reduction) |
| Clean E2E Qwen calls | 0/84 (100% reduction) |
| Clean E2E REVIEW rate | 0% |
| Political/news E2E | 11 KEEP, 3 REVIEW, 0 REMOVE |
| WHO prevention E2E | 2 KEEP, 0 REVIEW/REMOVE |
| Safe clips | 8 clean, 1 political; all 120-180 seconds |

## Known limits

The screen is transcript-only and mainly tuned for English. Visual-only evidence remains REVIEW. The balanced synthetic suite measures regression behavior, not real-world class prevalence.
