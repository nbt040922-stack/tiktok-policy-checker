# Phase 6.1 daily-use validation

## Decision

Status: `BLOCKED_EXTERNAL_SOURCE`

Operational verdict: `NOT_READY`

The packaged application itself stayed responsive and preserved all 20 submitted jobs, but the production network began returning HTTP 429 for every YouTube timed-text request. No real job reached Qwen, visual proxy, OCR, Gemma, finalization, or report generation. Phase 6.1 therefore does not claim daily-use readiness or throughput from this run. The manifest and failed-run evidence are retained for a controlled rerun after the source limit clears or from a different authorized network.

## Build tested

- Product/version: TikTok Policy Checker 1.0.0, Windows x64 portable.
- Base commit: `61d84fa634307321992d796bbeee6babf23dda51`.
- Final validated working tree includes the two Phase 6.1 regression fixes documented below.
- Artifact: `dist/TikTok Policy Checker 1.0.0.exe`.
- Size: 255,821,214 bytes.
- SHA-256: `F1D6FDE892003F3743E639960D6BA4FC76A522E96C6AD121623BB0AC11A30D50`.
- The portable executable was copied to a fresh directory outside the repository before launch.

## Workload and queue integrity

The manifest contains 20 real news videos from BBC News, Reuters, CNBC Television, and SABC News. It covers anchor footage, B-roll, interviews, charts, documents/screenshots, political reporting, financial reporting, durations below five minutes through over twenty minutes, and one Unicode title. Metadata probes confirmed English subtitle tracks for the ten newly selected sources before the timed-text rate limit began.

The UI received 22 URL strings: 20 unique videos plus `youtu.be` and tracking-parameter variants of one video. It created exactly 20 jobs. Two duplicate forms were rejected. No job disappeared.

Final production database state after the planned operational probes:

```text
submitted URL strings      22
unique jobs                20
duplicates rejected         2
completed                   0
failed                     18
cancelled                   2 (one queued, one running)
lost                        0
jobs manually retried       4
```

The initial cold batch reached a terminal state in 217.860 seconds including a deliberate 139-second operator pause used to investigate the repeated failure. Measured active metadata plus subtitle-fetch time was 78.867 seconds. This is failure-handling time, not throughput.

## Production blocker and fixes

The original artifact selected a valid caption track, then the YouTube timed-text endpoint returned HTTP 429. `fetchSubtitle` incorrectly mapped that response to `TRANSCRIPT_UNAVAILABLE`, which is permanent and not retried. The minimal production fix maps HTTP 408/429 and 5xx subtitle responses to `NETWORK_ERROR`. A packaged manual retry then performed three bounded attempts with approximately two- and four-second backoff and ended with a clear network error. No automatic model or account action occurred.

The full test run also exposed a narrow crash-consistency race: `_run` emitted `started` before the atomic database save. A force-close in that interval left the job safely queued but without `APP_INTERRUPTED`. The order is now persist first, then emit. The crash recovery executable passed ten consecutive repetitions after the fix.

## Operational controls

- Pause/resume: PASS. The running metadata/transcript operation reached its safe boundary; no new job started while paused.
- Queued cancellation: PASS. The job became `CANCELLED` and never ran.
- Running cancellation: PASS via the UI cancel-all control while the target job showed `METADATA · RUNNING`; it became `TRANSCRIPT · CANCELLED`, created no report, and left no app-owned yt-dlp/FFmpeg/OCR process.
- Retry: PASS. HTTP 429 produced `NETWORK_ERROR`, attempts 1/2/3, bounded backoff, then a clear terminal failure.
- Force-close/restart: PASS. A job killed at `METADATA`, attempt 2, was preserved and resumed from the same record after reopening; it terminated clearly at attempt 3. Database and history remained readable and `visual-temp` was empty.
- Duplicate canonicalization: PASS, 22 URL strings to 20 jobs.
- Progress observed: `QUEUED`, `METADATA`, `TRANSCRIPT`. Later stages could not be reached because of the external source limit; no progress moved backward and no failed job showed 100%.

## Exports, history, logs, and storage

Packaged UI export produced a 20-row CSV with 20 unique video IDs and the required columns. JSON export parsed successfully with 20 jobs. Titles were unavailable because the failure happened before the ingestion result could be checkpointed, so Unicode propagation beyond the input/source URL was not claimable.

History survived normal close/reopen and force-close/reopen. Search and revision preservation for completed production reports could not be validated because no report was produced. The actual app logs contained no cookie, authorization, password, transcript-text, OCR-text, or prompt keys. The current log did not reach the 5 MiB rotation threshold; the rotating logger and privacy test passed in the 166-test suite.

No source video, proxy, frame, cookie, transcript, or raw OCR text is committed. After the run, `visual-temp` was zero bytes. No app-owned yt-dlp, FFmpeg, or RapidOCR process remained. The expected Electron process tree fell from about 535 MiB during startup/work to about 374 MiB idle.

## GPU, model, and OCR boundary

VRAM was 1,124 MiB before the packaged run, peaked at 1,454 MiB during the metadata-only workload, and was 1,252 MiB at the final snapshot. Ollama reported no resident model. This demonstrates no creep for the pre-model path only; it does not validate Qwen/Gemma scheduling or 5/10/20-video model-loaded snapshots.

The final clean-PATH fresh-install check passed for bundled yt-dlp, FFmpeg, Deno, policy/config resources, persistent database, Qwen, Gemma, and frozen RapidOCR. RapidOCR health started from packaged resources without system Python or `VISUAL_OCR_PYTHON`. End-to-end OCR output and reusable-worker lifecycle were not reached in the real workload.

## Throughput and capacity

Cold videos/hour: not measurable; zero jobs completed.

Warm videos/hour: not run; warming or reporting a cache number after a failed cold run would be misleading.

50/100/200-video machine-hour projections: not calculated. Phase 6 theoretical numbers are intentionally not reused as Phase 6.1 packaged results.

The only defensible bottlenecks in this run were:

1. YouTube timed-text HTTP 429, which blocked 100% of jobs.
2. YouTube metadata ingestion, 70.319 seconds of measured active time.
3. Portable self-extraction/startup, approximately 20 seconds to an observable first window.

Operator intervention required by the unplanned failure: one pause/investigation. The retry, cancel, crash, and restart actions were planned validation probes and are not counted as daily-use intervention.

## Acceptance gates

PASS: no lost jobs, duplicate handling, pause/resume, queued/running cancellation, bounded retry, crash recovery, database/history persistence, CSV, JSON, privacy scan, no process leak, no large temp leak, 200-record harness, doctor, clean-PATH fresh install, OCR packaging, artifact build, 166 regression tests.

NOT VALIDATED: 20 real completions, cold/warm throughput, Qwen/Gemma load/unload and VRAM creep, end-to-end OCR, five HTML reports, HTML/JSON comparison, completed-history search, revisions, stale completed analysis, deterministic repeated results, report integrity, duration-weighted throughput.

Phase 6.1 must be rerun before changing the operational verdict from `NOT_READY`.

## Phase 6.1.2 rerun note — 2026-08-15

The embedded extension provider was exercised after this report. A second manifest video, `ooiOo4WjutY`, recovered from timed-text HTTP 429 through YouTube `get_panel` HTTP 200 and returned 19 timestamped cues in 10.586 seconds. The exact prior blocker video, `wxEpPin8MWw`, still timed out without transcript DOM after 45 seconds. No five- or twenty-video rerun was started, so all previous blocked evidence and the `NOT_READY` verdict remain unchanged.
