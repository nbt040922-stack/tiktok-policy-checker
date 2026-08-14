# Phase 4 — Qwen Evaluation

## Evaluation status

`BLOCKED_QUALITY_AND_THROUGHPUT`

Evaluated on 2026-08-14 after the user explicitly authorized model installation. Qwen3-14B runs locally and stably, but Phase 4 is not a release PASS because the benchmark agreement rate is 50%, one dangerous false KEEP occurred, clean long-form content was over-routed to Qwen and REVIEW, and no 120–180 second safe clip was produced.

## Model and runtime

- GPU: NVIDIA GeForce RTX 5060 Ti, 16,311 MiB
- Runtime: Ollama on `http://127.0.0.1:11434`
- Model: `qwen3:14b` / Qwen3-14B
- Quantization: Q4_K_M
- Context: 4,096 tokens reported by the loaded Ollama process
- Processor: 100% GPU
- Prompt mode: non-thinking, `think: false` plus `/no_think`

The official Ollama tag listing reports the Q4_K_M artifact at approximately 9.3 GB: <https://ollama.com/library/qwen3/tags>.

## VRAM

| Measurement | Used | Free |
|---|---:|---:|
| Before model load | 2,164 MiB | 13,887 MiB |
| After benchmark | 11,342 MiB | 4,709 MiB |
| Highest observed during E2E | 11,393 MiB | 4,658 MiB |

Observed model-load delta was approximately 9,178 MiB. No OOM, GPU reset, CPU offload, or model-server crash occurred.

## Synthetic benchmark

Command: `npm run benchmark:qwen`

| Metric | Result |
|---|---:|
| Fixtures | 12 |
| Agreement | 6/12 (50.0%) |
| False KEEP | 1 |
| False REMOVE | 1 |
| REVIEW rate | 4/12 (33.3%) |
| Valid strict-JSON responses | 11/11 completed generations |
| Timeouts | 1/12 |
| Mean latency, including cold timeout | 12,435 ms/segment |
| p50 latency | 5,394 ms |
| p95 latency | 60,027 ms |
| Raw throughput | 4.82 segments/minute |

The false KEEP was the documentary weapon-discussion fixture, expected REVIEW but returned KEEP. The false REMOVE was a graphic-event verbal description, expected REVIEW but returned REMOVE. The first cold request timed out at 60 seconds and safely became REVIEW. Human labels are expectations for this engine, not official TikTok moderation outcomes.

## Manual YouTube E2E

All cases used the real public YouTube metadata/subtitle path, timestamp segmentation, production `tiktok-global-2025-h2` policy retrieval, and local Qwen judge.

| Case | Video | Duration | Segments | Prefilter | Qwen | Cache | KEEP | REVIEW | REMOVE | Safe clips | Judge runtime |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Normal clean | YouTube Developers: Embedded Web Player Customization | 1,344 s | 84 | 0 | 84 | 0 | 12 | 72 | 0 | 0 | 433,802 ms |
| Political/news | BBC News: AI and deepfakes in politics | 273 s | 14 | 0 | 14 | 0 | 0 | 14 | 0 | 0 | 93,707 ms |
| Sensitive | WHO: Preventing suicide — information for teachers | 47 s | 2 | 0 | 2 | 0 | 1 | 1 | 0 | 0 | 11,125 ms |

Result: 3/3 pipelines completed without OOM or invalid JSON. Across these cases, 100/100 segments were sent to Qwen and none bypassed the model, so the current prefilter did not reduce calls on this sample. The clean 22-minute video took 7 minutes 14 seconds of judge time and was incorrectly dominated by REVIEW results.

## Real cache probe

The exact 14-segment BBC ingestion was repeated in the same service session:

- Qwen calls: 0
- Cache hits: 14/14
- Total judge time: 11 ms

The cache therefore eliminates exact repeated model work, but does not solve first-pass throughput.

## Concurrency comparison

The same 12-segment, warm-model workload was run as one analysis at both supported concurrency settings.

| Concurrency | Total time | Throughput | Mean request latency | p50 | p95 | Peak VRAM |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 78,808 ms | 9.14 segments/min | 6,561 ms | 5,312 ms | 21,292 ms | 11,434 MiB |
| 2 | 71,755 ms | 10.03 segments/min | 11,364 ms | 11,421 ms | 14,718 ms | 11,595 MiB |

Concurrency 2 improved throughput by only 9.7% while increasing mean per-request latency by 73% and peak VRAM by 161 MiB. The default therefore remains 1.

## Engineering verification

- Local-only health and installed-model checks: PASS
- Q4_K_M detection: PASS
- Strict schema and policy-ID validation: PASS
- Timeout fallback to REVIEW: PASS
- Exact-input cache reuse: PASS
- Real YouTube transcript to Qwen pipeline: PASS
- Stable GPU execution without OOM: PASS
- Benchmark quality: FAIL
- Conservative false-KEEP objective: FAIL
- Effective first-pass Qwen call reduction: FAIL on manual E2E sample
- Safe 120–180 second clip generation: not demonstrated by the real E2E results

## Next action

Per the Phase 4 stop conditions, do not force a PASS. Candidate retrieval/prefilter calibration and prompt decision behavior require correction and re-evaluation. Qwen3-8B Q4 may be benchmarked as the specified throughput fallback, but it is a separate multi-gigabyte installation and still requires explicit user authorization.
