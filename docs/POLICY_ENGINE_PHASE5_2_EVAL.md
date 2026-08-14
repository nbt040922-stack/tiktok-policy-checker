# Phase 5.2 Evaluation

## Decision

**STOP — MODEL_GAP / PERFORMANCE_GAP.** Phase 5.2 does not PASS and is not integrated.

## Known weapon cases

| Detector | Bodycam/news 660s | GLOCK 113s | Mandatory gate |
| --- | --- | --- | --- |
| OWLv2 base ensemble | MISS | 0.4395, correct handgun box | FAIL |
| Grounding DINO Tiny | 0.3998, television-sized/non-specific box | 0.5799, correct handgun box | FAIL |

At threshold 0.45, the bodycam case is missed. At threshold 0.30, a press-conference microphone scores 0.6454, a phone scores 0.4339, and several clean bodycam/sports/action frames overlap the bodycam score. No acceptable confidence bands exist on this reviewed set.

## Additional positives

| Window | Highest single-prompt score | Trusted weapon evidence |
| --- | ---: | --- |
| Bodycam 650s | 0.2289 | No |
| Bodycam 655s | 0.3635 | No |
| Bodycam 660s | 0.3998 | No |
| Bodycam 665s | 0.3927 | No |
| GLOCK 112s | 0.4697 | Yes |
| GLOCK 113s | 0.5799 | Yes |
| GLOCK 114s | 0.6285 | Yes |
| GLOCK 122s | 0.4584 | Yes |

## False positives

Raw negative-control scores: microphone 0.6454, phone 0.4339, clean Seattle bodycam 0.3814, swimming 0.3386, clean GLOCK interview 0.3330, NASA action camera 0.3155, and crowd 0.2721. The microphone is a catastrophic weapon false positive at every threshold that could admit the bodycam candidate.

## Runtime and VRAM

| Metric | Result |
| --- | ---: |
| Grounding DINO batch | 15 frames |
| Batch runtime | 126,509 ms |
| Mean latency | 8,434 ms/frame |
| PyTorch max allocated | 19,978 MiB |
| Projected 119 retained frames | >16 minutes detector-only |
| Target full visual pass | <=3 minutes |

This is a performance stop independent of the accuracy stop.

## OCR

RapidOCR 3.9.2 / Apache-2.0 was selected and installed in the ignored evaluation environment. Evaluation did not proceed because the mandatory weapon gate failed first. Baseline remains Gemma 7/12; Phase 5.2 useful extraction is **not measured**.

## Corpus and safe windows

The same Phase 5.1 sources and exact known frames were used. The broad 14-video rerun was not started after the stop condition. No product code changed, so escalation, runtime, VRAM, cache, cancellation, cleanup, and safe-window outputs remain the Phase 5.1 values.

## Test status

Only documentation and repository ignore state are changed. Existing automated tests and Windows build are rerun as regression gates; no specialized-provider test is claimed because no provider is integrated.

## Evidence

Raw gate measurements are stored in `docs/evidence/phase5-2-detector-gate.json`. Source frames and model weights are not committed.
