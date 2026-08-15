# Phase 6.1.3 — Visual continuation fix

## Root cause

The Browser transcript provider preserved the original ingestion metadata. The visual stage was reached, but yt-dlp failed while downloading the analysis proxy with `HTTP Error 403: Forbidden`. The previous fallback collapsed that concrete failure into a generic visual-subsystem warning.

## Fix

- The visual proxy selects yt-dlp's supported YouTube `web` player client while retaining the existing dedicated auth/cookie path.
- Browser fallback replaces transcript transport only. `metadata.url`, `videoId`, and `durationSeconds` remain the values obtained during normal metadata ingestion.
- All-PRECHECK_KEEP output still proceeds to `VISUAL_PROXY` and `VISUAL_ANALYSIS`.
- Logs now distinguish proxy start/success/failure from visual-analysis start/success/failure and retain stage, error code, and technical message.
- Failed proxy, frame, OCR, or model work preserves its specific diagnostic fields. OCR reports `VISUAL_PIPELINE_NOT_REACHED` when proxy creation fails before OCR can start.
- Final safe windows are emitted only after a successful visual pass.
- The report and result UI use the same video aggregate; incomplete subsystem state is not displayed as an overall KEEP result.

## Timing semantics

Stages are sequential for a single job.

- `metadataMs`: metadata acquisition and normalization.
- `directCaptionMs`: direct timed-text provider attempt.
- `extensionMs`: embedded Browser provider attempt.
- `transcriptMs`: full transcript provider-chain wall time; therefore it includes `extensionMs` when fallback is used.
- `textPolicyMs`: text-policy analysis.
- `visualProxyMs`: visual proxy acquisition.
- `visualAnalysisMs`: frame sampling, cheap scanning, OCR, and Gemma routing.
- `finalizeMs`: multimodal merge and final metric assembly.
- `totalMs`: job start through report-ready final result, across the queue's text and visual phases.

Child metrics such as `directCaptionMs` and `extensionMs` explain `transcriptMs`; they must not be added to it again.

## Regression coverage

Automated tests verify:

- Direct caption 429 followed by extension success preserves the original visual URL, video ID, and duration.
- An all-PRECHECK_KEEP text result still invokes visual analysis.
- A mocked 12-second extension fallback plus 3-second visual stage produces at least 15 seconds total wall time.
- Unavailable visual analysis suppresses final recommended safe windows and retains diagnostic codes.
- A successful visual pass with OCR `NOT_USED` remains complete.
- Cancellation and crash-recovery behavior remain intact.
