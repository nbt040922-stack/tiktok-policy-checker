# Phase 5.1 Failure Analysis

## Outcome

Phase 5.1 is **FAIL — MODEL_GAP** against the product acceptance target. The stress harness and cleanup/calibration work pass, but reviewed weapon recall does not.

The raw evidence is in `docs/evidence/phase5-1-real-world-results.json`. Counts below are deliberately raw because the manually reviewed set is small and not prevalence-weighted.

## Failure taxonomy

| Source | Count | Interpretation |
| --- | ---: | --- |
| SAMPLING | 0 reviewed windows | Actual scene-aware 2/3/4 timestamps hit all 20 target windows and all 6 brief windows. |
| DEDUPE | 11 label-transition collisions before; 5 after | Hamming 7 could copy an earlier representative across a differently labeled review window. Hamming 4 reduces, but does not eliminate, this conservative collision indicator. |
| ESCALATION | 598 labeled-frame signal misses | Mostly frames inside broad text/bodycam/swimwear review windows where cheap RGB/text signals did not fire. This is not 598 end-to-end misses because mandatory representatives still escalate and many labels are challenge markers, not prohibited objects. |
| VLM | 2 weapon false negatives | Direct frames at bodycam/news 660s and GLOCK 113s returned no weapon finding. |
| OCR | 5/12 selected text frames | Software UI, firearm title, handheld overlay, and small/multilingual text were missed. |
| POLICY_MAPPING | 1 before; 0 after | Benign NASA watermark was emitted as `on_screen_text_risk`; deterministic OCR-risk filtering now prevents it from changing a verdict. |

## False positives

Final applied visual findings had:

| Category | Before | After calibration |
| --- | ---: | ---: |
| Weapon | 0 | 0 |
| Blood | 0 | 0 |
| Graphic injury | 0 | 0 |
| Nudity/sexual content | 0 | 0 |
| Text risk | 1 | 0 |

The text false positive was a NASA watermark (`CHEMIN PRODUCTION NASA`) on clean low-light footage. Gemma incorrectly emitted `on_screen_text_risk`; the service now ignores model text-risk categories unless the normalized OCR string matches deterministic risky-language rules.

Cheap signals are not findings, but one GLOCK frame crossed `possibleNudity` because skin occupied 58.6% of the image. Gemma did not turn that hint into a nudity finding, so it caused routing cost rather than a moderation false positive.

The minor first-aid cut was correctly classified as a minor `graphic_injury` with medical context. It is visible-evidence success, not a false graphic label or an automatic policy violation.

## False negatives

### Bodycam/news weapon — 650–670s

- Human label: `WEAPON_VISIBLE`; small suspected handgun is circled in evidence footage.
- Sampling: review window hit.
- Cheap signal at 660s: no escalation signal.
- Dedupe: difficult-frame direct test bypassed dedupe.
- Gemma 360p: no finding.
- Gemma 480p: no finding.
- Primary taxonomy: **VLM**. Secondary risk: **ESCALATION** when the timestamp is not the mandatory representative.
- Policy result risk: text KEEP/news context can remain KEEP because no visual evidence reaches mapping.

### GLOCK firearm demonstration — 111–115s

- Human label: `WEAPON_VISIBLE`; handgun is clear and handled at a table.
- Sampling: scene preference hit the window.
- Cheap signal at 113s: escalated for `possibleNudity`, not weapon evidence.
- Dedupe: difficult-frame direct test bypassed dedupe.
- Gemma 360p: no finding.
- Primary taxonomy: **VLM**.
- Policy result risk: a clear weapon in instructional context is absent from visual evidence, so deterministic context handling cannot run.

These are recurrent missed weapon events longer than two seconds, so Phase 5.1 cannot PASS.

## Brief-event results

The human review set has six brief windows: one `<1s`, two `1–2s`, and three `2–5s`. Current scene-aware sampling and aggressive sampling both hit 6/6. Regular interval-only 2/3/4 sampling would have missed the first GLOCK event; scene preference recovered it.

Hitting a window is not detection. Both sampled weapon frames were still missed by Gemma. This distinction prevents a sampling success from hiding a VLM failure.

## Dedupe tradeoff

| Threshold | Removed | Collision indicators | VLM candidates | Long-video runtime |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 158 | 5 | 200 | 141.8s |
| 7 | 257 | 11 | 164 | 105.9s |
| 10 | 337 | 14 | 137 | Not run end-to-end |

Hamming 4 is selected. It halves the incremental collision count versus threshold 7 and still clears the 180-second target. It does not solve the direct VLM weapon misses.

## OCR quality

Seven of twelve selected text-bearing frames returned text. Large English overlays and captions were generally readable. Small UI text, some fast overlays, and the Japanese/small-font sample were missed. 480p did not recover the selected OBS sample, so globally raising resolution is unsupported.

Non-English status: **POOR** for the single reviewed Japanese-font sample. The sample count is too small for a language-level accuracy rate.

## Context and deterministic merge

Gemma's schema remains evidence-only and contains no verdict. The deterministic mapper still owns KEEP/REVIEW/REMOVE and keeps news, documentary, educational, medical, prevention, and recovery context from becoming automatic REMOVE.

Observed modality cases:

- Text-compatible KEEP + visible minor medical injury → deterministic REVIEW, never silent REMOVE.
- Text KEEP + weapon present but VLM empty → incorrect KEEP risk; the failure is explicit in evidence.
- Text KEEP + benign OCR → remains KEEP after calibration.
- A real text REVIEW + visual-clean resolution was not established in the selected corpus; only the existing deterministic regression test covers that branch.

## Cancellation and cleanup failure

The first real cancel run revealed a Windows file-release race: `runProcess` reported cancellation before the zero-byte FFmpeg output handle was always released, and immediate recursive deletion raised `EPERM`. The correction retries only `EPERM`/`EBUSY` cleanup for a bounded interval. A complete rerun validated:

- FFmpeg process cancellation: PASS.
- Gemma request cancellation: `ANALYSIS_CANCELLED`.
- Cancel directory removal: PASS.
- Whole stress work directory removal: PASS.
- No orphan FFmpeg/Node process: PASS.
- No stale `phase5-1-stress-*` directory: PASS.

## Remaining gaps and Phase 5.2 boundary

The current architecture cannot repair a visual model that misses a weapon after receiving the correct frame at both tested resolutions. Phase 5.2 should begin with a focused weapon/small-object detector evaluation and a focused OCR evaluation, measured against the same manifest. It must not weaken deterministic policy mapping or treat object presence as a violation.

No Phase 5.2 dependency or model is added here.
