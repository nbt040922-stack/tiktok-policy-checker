# Phase 6 — Production hardening and batch workflow

## Operational architecture

```text
single or newline-separated YouTube URLs
  -> canonical video-ID deduplication
  -> atomic persistent job store
  -> grouped TEXT phase (Qwen GPU owner)
  -> durable transcript/text checkpoint
  -> grouped VISUAL phase (Gemma GPU owner + CPU OCR)
  -> deterministic final decision
  -> revisioned JSON + HTML reports
```

The existing download manager remains limited to two concurrent downloads. Policy analysis is conservative at one active job/phase because Qwen and Gemma share one GPU. `GpuScheduler.withGpu()` serializes all large-model work, including the legacy single-video IPC path.

## Job database

Phase 6 deliberately uses an atomic versioned JSON store at `analysis-jobs.json`, not native SQLite. The existing app already uses JSON persistence, 200 records occupy only 216,260 bytes, reload in 2 ms, and adding a native SQLite module would create an Electron ABI/rebuild dependency. The file is written through a temporary file and atomic rename. A malformed database is renamed to `.corrupt-<timestamp>` and the UI exposes the recovery warning.

This is the intentional Ponytail ceiling: migrate to SQLite when measured history reaches thousands of records or concurrent writers are introduced. The current store has one main-process writer.

Controlled statuses are `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, and `PAUSED`. Stages are separate: `QUEUED`, `METADATA`, `TRANSCRIPT`, `TEXT_POLICY`, `VISUAL_PROXY`, `VISUAL_ANALYSIS`, `FINALIZING`, and `DONE`. Stage percentages are coarse and do not claim per-frame precision.

Each job persists the requested operational fields, current phase, human/technical error, model and policy versions, report paths, aggregate result, metrics, and revision history. The version fingerprint covers policy set, Qwen model/prompt, visual thresholds, Gemma model/schema, OCR runtime, and news routing. Old reports remain readable and display their original versions; current history marks mismatched jobs `STALE`.

## Recovery and retries

At startup, stale `RUNNING` records become `QUEUED` with `APP_INTERRUPTED`. `QUEUED` and `PAUSED` records retain their state. Revision-scoped checkpoints persist transcript ingestion, text results, and visual results with the analysis fingerprint:

- valid transcript checkpoint skips metadata/subtitle download;
- valid text checkpoint skips Qwen work;
- valid visual checkpoint skips proxy/Gemma/OCR work before finalization;
- missing proxy or incompatible version safely reruns the required phase.

Network, YouTube rate/server, temporary Ollama, timeout, and OCR worker failures retry up to three total attempts with bounded exponential backoff. Invalid/private/removed videos, missing transcript, missing model, corrupt policy files, and unsupported URLs fail immediately with separate `errorCode`, `technicalMessage`, and Vietnamese `userMessage`.

Pause finishes the active phase safely and prevents another phase from starting. Resume restores paused records. Cancel propagates through the existing abort signal to subtitle fetch, yt-dlp, FFmpeg, Qwen, OCR, and Gemma. Cancel-all does not delete completed reports. Retry uses the same record and durable checkpoint. Re-analysis creates a new revision and preserves the prior JSON/HTML files.

## Reports and history

Every revision produces `reports/<video-id>-<revision>.json` and `.html`. JSON contains metadata, versions, video aggregate, segment judgments, policy IDs, separated on-screen evidence, visual findings, lower-risk windows, metrics, and warnings. HTML is intentionally operational: result/counts, risky sections, policy reasons, on-screen text evidence, recommended 120–180 second lower-risk windows, warnings, and runtime. It never claims TikTok approval.

Batch export supports JSON and RFC-style quoted CSV columns from the prompt. History supports title/channel/video-ID search, priority result filters, open-report, retry, cancel, and re-analysis. The renderer caps displayed records at 100; the database retains history.

Report retention defaults to indefinitely (`keepReportsDays = 0`) and can be set to 30, 90, or 365 days. Qwen cache, visual cache, and reports have distinct maintenance actions. Storage reports separate report, cache, and temporary-media sizes.

## Logging and privacy

`logs/app.log` and `logs/jobs.log` are JSON-lines logs, rotate at 5 MiB, and contain timestamp/job/video/stage/event/duration/error code where applicable. Recursive sanitization removes transcript, OCR text, prompts, cookies, authorization, passwords, and token fields. Model output content is not logged by default.

## UI scope

The compact screen is preserved. The URL control accepts one or many pasted URLs. A small queue panel shows counts, status, stage, coarse progress, final aggregate, actions, search/filter, exports, and collapsed storage maintenance. Only the most relevant 100 records enter the DOM.

