# Phase 5.3 Evaluation

## Decision

`NO_VIABLE_FIREARM_DETECTOR`

Both eligible specialized checkpoints fail the mandatory accuracy gate. Runtime is acceptable after warm-up, but speed cannot compensate for missing the two exact known positives.

## Result matrix

| Candidate | License | Bodycam 660 | GLOCK 113 | False positives at 0.20 | Warm ms/frame | Peak allocated VRAM | Gate |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| DETR 1 epoch | Apache-2.0 | MISS | MISS | Microphone | 48.36 | 4,368.71 MiB | FAIL |
| DETR 5 epochs | Apache-2.0 | MISS | MISS | None | 43.76 | 4,368.71 MiB | FAIL |

## Full-frame positive results at 720p

The table reports the highest correctly localized firearm score. A dash means no valid localized box even at the 0.01 diagnostic floor.

| Candidate | Bodycam 650 | 655 | **660 gate** | 665 | GLOCK 112 | **113 gate** | 114 | 122 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DETR 1 epoch | 0.1145 | 0.1140 | — | — | — | — | — | 0.1291 |
| DETR 5 epochs | 0.0469 | 0.0107 | — | — | — | 0.0210 | 0.0401 | 0.0710 |

Neither exact pair can pass threshold 0.20. Lowering below the required sweep is not justified: confidence is extremely low, localization is unstable, and the 1-epoch model assigns a microphone `rifle` score of 0.2185.

## Threshold sweep

| Threshold | DETR 1 epoch | DETR 5 epochs |
| ---: | --- | --- |
| 0.20 | Both gate positives miss; microphone false positive | Both gate positives miss |
| 0.30 | Both gate positives miss | Both gate positives miss |
| 0.40 | Both gate positives miss | Both gate positives miss |
| 0.50 | Both gate positives miss | Both gate positives miss |
| 0.60 | Both gate positives miss | Both gate positives miss |

There is no best production threshold. For reporting, 0.20 is the most sensitive reviewed threshold and still fails.

## Negative controls

| Control | DETR 1 epoch top score | DETR 5 epochs top score |
| --- | ---: | ---: |
| Press-conference microphone | 0.2185 rifle | 0.1053 pistol |
| Phone | 0.1795 rifle | 0.0832 rifle |
| Clean Seattle bodycam | 0.1045 rifle | 0.0112 rifle |
| Swimming | 0.1538 rifle | 0.0924 rifle |
| Clean GLOCK interview | 0.1704 rifle | 0.0996 rifle |
| NASA action camera | 0.1505 rifle | 0.1393 rifle |
| Crowd | 0.1882 rifle | 0.0744 pistol |

The 1-epoch microphone result is catastrophic at 0.20. The 5-epoch model avoids reviewed negative hits at 0.20 only because all of its positive scores are also below 0.20.

## Runtime and VRAM

Measured on NVIDIA GeForce RTX 5060 Ti 16 GB with PyTorch 2.11.0+cu128 and 15-frame batches.

| Metric | DETR 1 epoch | DETR 5 epochs |
| --- | ---: | ---: |
| Load | 2,833 ms | 2,737 ms |
| Cold single frame | 506 ms | 479 ms |
| Warm single median | 48.36 ms | 43.76 ms |
| 15-frame batch | 602.02 ms | 584.26 ms |
| Batch mean | 40.13 ms/frame | 38.95 ms/frame |
| Projected 119 frames | 4.78 s | 4.64 s |
| Projected 200 frames | 8.03 s | 7.79 s |
| System baseline | 2,525 MiB | 2,525 MiB |
| System after model load | 2,816 MiB | 2,816 MiB |
| System after batch | 9,914 MiB | 9,914 MiB |
| PyTorch max allocated | 4,368.71 MiB | 4,368.71 MiB |
| PyTorch max reserved | 7,240 MiB | 7,240 MiB |
| System after unload | 2,744 MiB | 2,744 MiB |

The 1-epoch cold single result exceeds the preferred 500 ms by 6 ms; both are comfortably below 500 ms after warm-up. System VRAM includes other desktop processes and the CUDA context, while PyTorch values isolate allocator peaks. Post-unload remains 219 MiB above baseline because the process retains its CUDA context until exit; weights and allocator reservations were released.

## Resolution effect

Resolution did not rescue the mandatory gate. DETR preprocessing normalizes inputs to its configured inference size, so source detail changed while runtime stayed about 45–53 ms.

| Candidate | 360p exact pair | 480p exact pair | 720p exact pair |
| --- | --- | --- | --- |
| DETR 1 epoch | Both invalid/missed | Both invalid/missed | Both invalid/missed |
| DETR 5 epochs | Bodycam miss; GLOCK 0.0189 | Bodycam miss; GLOCK 0.0194 | Bodycam miss; GLOCK 0.0210 |

## Tiling effect

Uniform tiling improves some diagnostic scores but none reaches 0.20 on both exact positives.

| Candidate | Grid | Bodycam 660 | GLOCK 113 | Runtime per full frame |
| --- | --- | ---: | ---: | ---: |
| DETR 1 epoch | 2×2 | — | 0.1306 | 186–188 ms |
| DETR 1 epoch | 3×3 | 0.1459 | 0.1655 | 425–433 ms |
| DETR 5 epochs | 2×2 | 0.0160 | 0.0213 | 191–196 ms |
| DETR 5 epochs | 3×3 | 0.1073 | 0.0808 | 418 ms |

Tiling multiplies inference cost by roughly 4× or 9× and still fails the gate, so it is not justified for these detectors.

## Adaptive-zoom Gemma fallback

The required fallback used one generic 2×2 configuration: full frame plus four equal quadrants for bodycam 660s and all seven negatives. It made 40 calls, took 84,663 ms in model-call time (2,116.57 ms mean), and produced three schema-invalid responses.

- Bodycam 660s: no weapon on the full frame or any tile.
- NASA action-camera negative: bottom-right tile falsely reported a “large-caliber machine gun or heavy weapon” with confidence 0.95.
- Other reviewed negatives: no valid applied weapon result.

Result: **NOT_PROMISING**. `ADAPTIVE_ZOOM_VLM_PROMISING` is not claimed.

## Recommendation

Keep the production pipeline unchanged. Phase 5.4 should not begin from either discovered DETR checkpoint or this Gemma tiling strategy. If work resumes, require a newly sourced checkpoint with explicit commercial/permissive weight terms, published firearm-domain validation, and a dry-run reproduction of this exact gate before any integration design.
