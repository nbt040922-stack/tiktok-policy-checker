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

This is a small synthetic safety regression set, not a prevalence-weighted real-world dataset. A static loop strongly favors perceptual deduplication and is therefore a throughput best case. Real videos with frequent cuts will make more VLM calls. Graphic severity, brief visual events, stylized imagery, small OCR, and non-English text need broader calibration before production moderation use.
