# Phase 6.1 operations

## Daily start

1. Run `npm run doctor` on the packaging/operations machine. Do not start a large batch unless yt-dlp, FFmpeg, Deno, OCR, Ollama, Qwen, Gemma, policy, database, cache, and report checks pass.
2. Start the portable executable from its deployment directory. Normal packaged OCR does not need Python or `VISUAL_OCR_PYTHON`.
3. Confirm queue/history are visible before pasting the manifest URLs.
4. Submit the batch once. The application canonicalizes YouTube URL forms and rejects duplicates.
5. Watch queued/running/completed/failed counts and the current stage. A job must always retain a status, stage, and error when applicable.

## Source-rate-limit response

HTTP 408/429 and YouTube/server 5xx errors are temporary. The queue makes at most three attempts with bounded backoff. If several jobs end with `NETWORK_ERROR`:

1. Pause the queue.
2. Do not repeatedly retry, change accounts, or attempt to evade the source limit.
3. Preserve the database and logs.
4. Wait for the limit to clear or move the scheduled rerun to another authorized network.
5. Retry one representative job first. Resume the batch only after it reaches text-policy processing.

`TRANSCRIPT_UNAVAILABLE` remains permanent for a video that genuinely has no supported track. `NETWORK_ERROR` is the retryable source/network condition.

## Recovery

- Pause lets active work reach its safe checkpoint and prevents another phase from starting.
- Cancel can stop a queued or running job. A cancelled job must not have a completed report.
- After an unexpected close, reopen the same portable application. Persisted `RUNNING` work is requeued with `APP_INTERRUPTED`; completed, queued, cancelled, and failed history remains intact.
- Do not edit `analysis-jobs.json` manually. Copy it for support analysis only while the application is closed.

## Reports and exports

- Open several HTML reports from completed jobs and compare one against its JSON revision before using a batch operationally.
- CSV and JSON exports are written under the application user-data `exports` directory.
- Reports default to indefinite retention. Cache clearing and report clearing are separate maintenance actions.
- Never treat a lower-risk window or report as TikTok approval.

## Resource checks

- During a successful rerun, record VRAM at baseline, Qwen loaded/unloaded, Gemma loaded, after videos 5/10/20, and post-batch.
- Qwen and Gemma should not remain resident together unexpectedly.
- After completion, verify no app-owned yt-dlp, FFmpeg, or RapidOCR child remains and `visual-temp` contains no abandoned large media.
- Ollama is the expected external persistent service; the application does not install or download models.

## Phase 6.1 rerun gate

Use `test/daily-use/manifest.json` unchanged unless a source becomes unavailable. Run cold from empty relevant caches, then warm with the same versions. Complete the unvalidated gates listed in `PHASE6_1_DAILY_USE_VALIDATION.md`, update the evidence JSON, and calculate capacity only from successful packaged cold throughput.
