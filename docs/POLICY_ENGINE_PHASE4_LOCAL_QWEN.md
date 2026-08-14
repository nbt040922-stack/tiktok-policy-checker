# Phase 4 — Local Qwen Policy Judge

## Status

The local-judge integration is implemented and `qwen3:14b` was installed after explicit user authorization. Real benchmark and YouTube E2E evaluation completed without OOM, but Phase 4 remains blocked on quality and throughput. See `POLICY_ENGINE_PHASE4_QWEN_EVAL.md` for measured results.

## Architecture

```text
YouTube ingestion (main process)
  -> timestamped transcript segments
  -> deterministic no-candidate prefilter
  -> top 5 policy candidates from tiktok-global-2025-h2
  -> version-aware SHA-256 judgment cache
  -> LocalQwenProvider over 127.0.0.1
  -> strict JSON validation and conservative decision mapping
  -> adjacent display-range merge + KEEP-only 120–180 second windows
  -> existing renderer
```

The Electron renderer never loads the model. The main process owns ingestion, policy retrieval, model calls, cache, and result aggregation. The policy knowledge base remains the only policy source; Qwen receives only the current segment, one previous/next segment, and up to five candidate rules.

## Runtime and model

The configured runtime is the locally installed Ollama service at `http://127.0.0.1:11434`. It provides the simplest available Windows localhost boundary on this workstation. The configured model is `qwen3:14b`, reported as `Qwen3-14B`, with expected `Q4_K_M` quantization. Ollama lists the Q4_K_M artifact at approximately 9.3 GB: <https://ollama.com/library/qwen3/tags>.

Qwen runs in non-thinking mode through both `/no_think` in the system prompt and `think: false` in the local request. Qwen documents `/no_think` as its dynamic non-thinking control: <https://qwenlm.github.io/blog/qwen3/>.

## Explicit installation

Installation is a separate user action:

```powershell
ollama pull qwen3:14b
ollama serve
```

The application itself never runs `ollama pull`. The model used for evaluation was installed as a separate, explicitly authorized operator action. Before YouTube ingestion the app checks `/api/tags`; if the service or model is absent, analysis fails immediately with `Qwen Policy Judge is not running` or `Local model qwen3:14b is not installed`.

## Configuration

Defaults live in `config/policy-judge.json`. Workstation paths are not hardcoded. Supported environment overrides:

```text
QWEN_SERVER_URL=http://127.0.0.1:11434
QWEN_MODEL=qwen3:14b
QWEN_QUANTIZATION=Q4_K_M
```

The provider rejects non-loopback hosts. Candidate count is constrained to 3–8 and concurrency to 1–2; defaults are 5 and 1. Starting thresholds are engineering configuration, not TikTok thresholds: KEEP 0.80, REMOVE 0.85, otherwise REVIEW.

## Prompt and output

Prompt version: `qwen-policy-judge-v1`.

The grounding prompt forbids remembered policy, invented IDs/exceptions, unsupported monetization inference, hidden reasoning output, and claims about unseen visuals. Ollama receives a JSON Schema, and the application independently rejects missing/extra fields, invalid enums, invalid confidence, unknown categories, and policy IDs outside the candidate set.

Timeout is 60 seconds. Invalid JSON and temporary local HTTP errors retry once. Timeout, repeated invalid output, and ambiguous treatment become REVIEW rather than crashing the video.

## Decision semantics

- REMOVE requires supported prohibited postability and confidence at or above the REMOVE threshold.
- REVIEW covers low confidence, age restriction, FYF prohibition, conflicting/incomplete context, requested visual evidence, and unsupported REMOVE output.
- KEEP requires supported allowed postability, no strong FYF restriction, and confidence at or above the KEEP threshold.
- `KEEP_PRECHECK` applies only when deterministic retrieval finds no policy signal; outcome fields remain UNKNOWN.

KEEP never guarantees monetization.

## Transcript-only limitation

The judge does not inspect frames, OCR, blood, nudity, visually shown weapons, or visual graphicness. Qwen must return `requiresVisualReview: true` with REVIEW when the decision needs visual evidence.

## Cache and metrics

The persistent cache stores input hashes and validated results, not transcript text. Keys include policy version, model ID, quantization, sampling settings, prompt version, segment/context text, and candidate IDs. Any relevant version/config change produces a new key.

Metrics log only counts/timing/usage, not transcript content: total segments, prefiltered segments, Qwen calls, cache hits, mean/p50/p95 latency, prompt/generated tokens when reported, and total analysis time.

## Cancellation and UI

A new analysis aborts the previous model request, subtitle fetch, and active yt-dlp metadata subprocess. Existing renderer request guards still prevent stale UI writes. The UI remains structurally unchanged; Risky Sections now includes REVIEW and REMOVE, short reason, and policy IDs.

## Offline behavior

After Ollama, the model, application, and policy set are installed, policy judgment uses localhost only and requires no Internet. YouTube ingestion still requires network access.

## Benchmark

Run after explicit model installation and sufficient free VRAM:

```powershell
npm run benchmark:qwen
```

The runner uses 12 short synthetic, human-labeled examples and reports agreement, false KEEP, false REMOVE, REVIEW rate, timings, token counts, and GPU memory samples. Expectations describe this engine's desired behavior, not official TikTok moderation outcomes. The 2026-08-14 run completed at 50% agreement with one false KEEP, one false REMOVE, and one cold-start timeout; these results require calibration before Phase 4 can pass.
