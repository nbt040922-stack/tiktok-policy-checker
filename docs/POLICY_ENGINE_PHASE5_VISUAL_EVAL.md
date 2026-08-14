# Phase 5 Visual Evaluation

## Environment

- Windows 11
- NVIDIA RTX 5060 Ti 16GB
- Ollama localhost
- Gemma 4 12B visual model
- Qwen3-14B Q4_K_M text model unloaded before visual inference
- FFmpeg 8.1.2

## Synthetic benchmark

The repository stores safe generated fixtures only. There is no real gore, explicit nudity, or self-harm act. Run with `npm run benchmark:visual`.

| Case | Expected behavior | Result |
| --- | --- | --- |
| Clean talking head | No risk finding | PASS |
| Weapon-like training prop | Weapon evidence with context | PASS |
| News footage with weapon | Weapon evidence, not automatic REMOVE | PASS |
| Minor bandaged injury | No graphic finding | PASS |
| Tomato/red shirt | No blood/graphic false positive | PASS |
| Clothed beach adult | No nudity/sexual false positive | PASS |
| `WEAPON FOR SALE` overlay | OCR and on-screen risk | PASS |
| Prevention counseling, no act | No self-harm visual finding | PASS |
| Theatrical makeup context | No graphic false positive | PASS |
| Partial-nudity risk, non-explicit | Nudity-risk finding | PASS |
| Minor visible nosebleed | Blood finding, not graphic injury | PASS |

Final result: 11/11, with zero false weapon, false blood, false nudity, and false graphic-content findings.

The cheap-signal escalation rate on the diverse 11-image suite was 18.2%. All images were deliberately sent to Gemma for ground-truth capability measurement; production still uses escalation and deduplication. Mean warm/cold mixed VLM latency was 4,643 ms per image.

## 20-minute E2E performance

A generated clean talking-head proxy was looped to exactly 1,200 seconds and split into sixty 20-second transcript segments.

| Metric | Result |
| --- | ---: |
| Visual runtime | 16,658 ms |
| Target | <= 180,000 ms |
| Frames sampled | 180 |
| Frames deduplicated | 179 |
| Frames cheap-scanned | 1 |
| Frames escalated | 1 (0.56%) |
| OCR calls | 0 |
| VLM calls | 1 |
| Peak GPU memory | 10,922 MiB |
| OOM | No |

Proxy download time is excluded as specified. Temporary benchmark media was deleted after the run.

## Calibration notes

The initial 320x180 frame size lost small blood detail, so inspection was raised to the proxy's full 640x360 resolution. A 1% red threshold escalated 70% of the diverse fixture set and was rejected; the final 10% red signal stays escalation-only. A dedicated minor visible-blood fixture verifies coverage while tomato/red clothing remains a negative control.

Gemma initially interpreted `applies` as policy violation rather than visual presence. The final prompt explicitly defines it as visible evidence and prohibits model verdicts. This preserves weapon/news/theatrical context for the deterministic policy engine.

## Limitations

This is a small synthetic safety regression set, not a prevalence-weighted real-world dataset. A static loop strongly favors perceptual deduplication and is therefore a throughput best case.

## Phase 5.1 real-world evaluation

Phase 5.1 separately evaluated 14 public real-world sources totaling 117.2 minutes. Full details are in `POLICY_ENGINE_PHASE5_1_REAL_WORLD_STRESS.md`, failure attribution is in `POLICY_ENGINE_PHASE5_1_FAILURE_ANALYSIS.md`, and machine-readable measurements are in `evidence/phase5-1-real-world-results.json`.

| Metric | Real-world result |
| --- | ---: |
| Scene cuts detected | 501 |
| Baseline sampled frames | 1,065 |
| Aggressive planned frames | 1,771 |
| Cheap-signal escalation | 269/1,065 (25.3%) |
| Reviewed target/brief windows hit | 20/20 and 6/6 |
| Hamming 7 collision indicators | 11 |
| Hamming 4 collision indicators | 5 |
| Selected VLM cases | 19 |
| Weapon false negatives | 2 |
| OCR misses | 5/12 selected text frames |
| Peak VRAM | 11,108 MiB |
| Calibrated 17.9-minute visual pass | 141,805 ms |

The evidence supports Hamming 4, while keeping 2/3/4 sampling, scene threshold 0.32, and 360p. Benign model-generated text-risk findings are now confirmed by deterministic OCR-risk matching before they can affect policy mapping.

Phase 5.1 status is **FAIL — MODEL_GAP** because Gemma missed two reviewed weapon events longer than two seconds even when the correct frames were sent directly. The synthetic 11/11 score remains a regression result and must not be represented as real-world acceptance.
