# Phase 4 — Qwen Evaluation

## Evaluation status

`BLOCKED_MODEL_NOT_INSTALLED`

Checked on 2026-08-14:

- GPU: NVIDIA GeForce RTX 5060 Ti
- Total VRAM: 16,311 MiB
- VRAM used before model: 8,931 MiB
- VRAM free before model: 7,120 MiB
- Ollama: installed and reachable
- Other installed models: `gemma4:12b`, `qwen2.5:7b` (neither satisfies the configured Phase 4 model)
- Configured model: `qwen3:14b`
- Installed model: none
- Health result: `MODEL_NOT_INSTALLED`

The official Ollama tag listing reports `qwen3:14b-q4_K_M` at approximately 9.3 GB: <https://ollama.com/library/qwen3/tags>. With only 7,120 MiB free during the final check, even the model artifact alone exceeds currently free VRAM, before allowing headroom for KV cache, Electron, and the OS. No processes were terminated and no model was downloaded without user authorization.

## Requested benchmark results

| Metric | Result |
|---|---|
| Runtime | Ollama localhost |
| Model | Qwen3-14B target; not installed |
| Quantization | Q4_K_M target |
| Peak model VRAM | Not measured |
| Average latency | Not measured |
| Throughput | Not measured |
| Benchmark fixtures prepared | 12 |
| Fixtures executed against Qwen | 0 |
| Agreement rate | Not measured |
| False KEEP | Not measured |
| False REMOVE | Not measured |
| REVIEW rate | Not measured |
| JSON validity | Not measured against real model |
| Manual YouTube E2E | 0 of 3; blocked before ingestion by health check |

No placeholder numbers are reported as model results.

## Automated verification completed

The provider and pipeline are covered with deterministic local doubles for:

- health and missing-model handling;
- localhost-only enforcement;
- non-thinking request and strict JSON Schema;
- invalid JSON retry and timeout;
- unknown policy-ID rejection;
- prompt/policy/model cache invalidation;
- candidate limit and adjacent context;
- KEEP/REVIEW/REMOVE confidence mapping;
- visual-review fallback;
- deterministic prefilter and cache hit;
- adjacent decision merge and KEEP-only safe-window logic;
- stale-request guard and real subprocess cancellation.

These tests validate engineering behavior, not Qwen quality.

## Unblocking the real evaluation

1. Free enough VRAM that the 9.3 GB model plus KV cache has safe headroom.
2. Explicitly install `qwen3:14b`, or explicitly choose the smaller Qwen3-8B Q4 fallback.
3. Confirm `ollama list` shows the configured model.
4. Run `npm run benchmark:qwen`.
5. Run the three requested normal/news/sensitive YouTube E2E cases and record metrics here.

Phase 4 cannot be marked PASS until those measurements complete without OOM, unstable latency, or dangerous false KEEP behavior.
