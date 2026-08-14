# Phase 4 / 4.1 Qwen Evaluation

## Status

`PHASE_4_1_PASS`. Retrieval, prefiltering, model output, deterministic decision mapping, and cache semantics were calibrated using the same local Qwen3-14B Q4_K_M runtime.

## Model

- Runtime: Ollama on `127.0.0.1`
- Model: Qwen3-14B, Q4_K_M
- Prompt: `qwen-policy-findings-v2`
- Sampled GPU memory: 11,679 MiB peak; no OOM

## Synthetic benchmark

| Metric | Phase 4 baseline | Phase 4.1 final |
| --- | ---: | ---: |
| Cases | 12 | 40 |
| Agreement | 50% | 100% (40/40) |
| False KEEP | 1 | 0 |
| False REMOVE | 1 | 0 |
| False REVIEW | not recorded | 0 |
| REVIEW rate | 33.3% | 30% |
| Neutral prefilter bypass | 0% | 100% |
| Qwen calls | 12/12 | 30/40 |
| Mean latency | 12,435 ms | 7,632 ms |
| p50 latency | 5,394 ms | 6,853 ms |
| p95 latency | 60,027 ms | 11,574 ms |

The final balanced suite has ten neutral, ten clearly allowed contextual, ten review/visual, and ten prohibited examples. Expectations are engineering labels for this repository, not official moderation decisions.

The 180-second safe-window probe produced one valid KEEP clip.

## Same-video E2E comparison

| Video | Phase 4 baseline | Phase 4.1 final |
| --- | --- | --- |
| Clean educational `M7lc1UVf-VE` | 84 Qwen calls; 72 REVIEW; no clips; judge 433,802 ms | 0 Qwen calls; 0 REVIEW; 8 clips; judge 153 ms; total 3,555 ms |
| Political/news `wxEpPin8MWw` | 14 Qwen calls; 14 REVIEW; no clips; judge 93,707 ms | 4 Qwen calls; 11 KEEP, 3 REVIEW, 0 REMOVE; 1 clip; judge 17,061 ms; total 19,685 ms |
| Sensitive prevention `Le7n6i0dpTI` | 2 Qwen calls; 1 KEEP, 1 REVIEW; judge 11,125 ms | 2 Qwen calls; 2 KEEP, 0 REVIEW/REMOVE; judge 6,251 ms |

The clean video REVIEW rate is 0%. Political reporting is not blanket-reviewed. The WHO suicide-prevention context is retained as allowed educational/prevention content.

## Acceptance

- Synthetic agreement at least 80%: PASS (100%)
- False KEEP equals zero: PASS
- Neutral prefilter bypass at least 60%: PASS (100%)
- Clean E2E REVIEW below 15%: PASS (0%)
- Clean E2E Qwen-call reduction at least 60%: PASS (100%)
- Safe 120-180 second clips generated: PASS
- Political/news not blanket REVIEW: PASS
- Sensitive prevention context classified correctly: PASS
- No OOM: PASS

## Limitations

The screen is transcript-only and primarily English lexical matching. Visual-only policy evidence still requires REVIEW. The benchmark is synthetic and intentionally balanced, so its REVIEW rate is not a production prevalence estimate.
