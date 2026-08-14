# Phase 4.1 - Local Qwen Policy Judge

## Status

The calibrated local judge passes the Phase 4.1 benchmark and same-video E2E acceptance gates. Qwen3-14B Q4_K_M remains local through Ollama at `127.0.0.1`.

## Architecture

```text
timestamped transcript
  -> deterministic risk screen
  -> thresholded, diverse policy retrieval
  -> neutral PRECHECK_KEEP or local Qwen findings
  -> deterministic policy decision engine
  -> adjacent merge and KEEP-only 120-180 second clips
```

The renderer never loads the model. The main process owns ingestion, retrieval, local inference, caching, mapping, and aggregation. The application never downloads the model.

## Configuration

Defaults are in `config/policy-judge.json`. The provider permits loopback hosts only. Environment overrides are `QWEN_SERVER_URL`, `QWEN_MODEL`, and `QWEN_QUANTIZATION`. Default candidate count is five, retrieval minimum score is five, and concurrency is one.

## Prompt and findings

Prompt version: `qwen-policy-findings-v2`.

Qwen returns grounded findings, not KEEP/REVIEW/REMOVE. Each finding must reference a supplied policy ID and use the strict schema. The provider rejects unknown IDs, invalid enums/confidence, extra fields, and invented policy facts. The canonical policy treatment is copied from the repository candidate rather than trusted from model output.

The prompt makes topic mention distinct from policy applicability and allows empty findings for reporting, quotation, debunking, prevention, and other non-applicable context. Non-thinking mode uses `/no_think` and `think: false`.

## Deterministic decision semantics

- REMOVE requires an applicable prohibited rule at or above the configured remove threshold without a supported exception.
- REVIEW covers visual evidence, insufficient or conflicting context, age restriction, FYF prohibition, unknown/restricted postability, or intermediate confidence.
- KEEP requires no unresolved restrictive finding.
- PRECHECK_KEEP is used only when the risk screen is neutral and retrieval has no qualifying candidate.
- A public-interest allowance applies only when that policy was actually retrieved and the content has supported controlled reporting/educational context.

KEEP never guarantees monetization.

## Retrieval and prefilter

Retrieval scores exact phrases and specific policy terms more strongly than generic words, requires a score of five, and returns at most two candidates per category. Broad metadata overlap no longer creates candidates. Public-interest candidates are available only in supported benign context. The risk screen guards risky current and neighboring segments from being bypassed when retrieval is empty.

## Cache and metrics

Cache format v2 stores validated model findings, not final decisions or transcript text. Decision thresholds are applied again on every cache hit, so changing thresholds remaps existing findings without another model call. Prompt, model, policy, sampling, text/context, and candidate changes invalidate the key. Version 1 final-verdict entries are ignored.

Metrics distinguish `PRECHECK_KEEP`, `QWEN_JUDGED`, `MODEL_FAILURE_REVIEW`, `VISUAL_REVIEW`, `POLICY_REVIEW`, and `REMOVE`, and report actual Qwen calls, cache hits, timing, and token usage.

## Failure and transcript-only behavior

Timeout, repeated invalid output, missing relevant policy for a risky segment, and local service failure resolve conservatively to REVIEW without crashing analysis. The judge cannot inspect frames, OCR, blood, nudity, weapons, or visual graphicness; decisions that depend on unseen imagery remain REVIEW.

## Evaluation

Run `npm run benchmark:qwen`. The final 40-case benchmark reached 100% agreement, zero false KEEP, and 100% neutral bypass. Detailed baseline and same-video results are in `POLICY_ENGINE_PHASE4_QWEN_EVAL.md`.
