# Phase 6.1.3 evaluation

Evaluation date: 2026-08-15 (Asia/Saigon)

## Automated verification

- Full test suite: PASS, 182/182.
- Build command: PASS (exit code 0).
- Portable artifact: `dist/TikTok Policy Checker 1.0.0.exe`, 255,824,118 bytes.
- Build note: Windows resource editing reported one transient `Unable to commit changes` message; electron-builder retried and produced the portable artifact successfully.

## Known video: `spPowx0g9VU`

Two packaged-app attempts produced the same transcript-stage result:

- Direct provider attempted and returned `YOUTUBE_RATE_LIMITED` (HTTP 429 path).
- Embedded extension 2.3.1 loaded successfully.
- The extension panel remained at `Loading transcript...` and timed out after about 48 seconds.
- Final job state: `FAILED` at `TRANSCRIPT`, `TRANSCRIPT_PROVIDERS_EXHAUSTED`.

Because the packaged run did not obtain a transcript, it never reached text policy or visual analysis. This run does not satisfy the known-video end-to-end acceptance criterion.

## Isolated known-video visual continuation

The exact previously downloaded 360p proxy for `spPowx0g9VU` was processed through the production `VisualRiskService` using 55 aligned KEEP segments. This isolates the Phase 6.1.3 visual fix from the extension's current external timeout.

Result:

- `visualStatus`: `AVAILABLE`
- `ocrStatus`: `AVAILABLE`
- `framesSampled`: 165
- `framesCheapScanned`: 165
- `framesDeduplicated`: 4
- `ocrCalls`: 73
- `gemmaCalls`: 43
- `visualAnalysisMs`: 429,450
- `newsVisualMs`: 429,450

This confirms that the known video's proxy is valid and the visual pipeline performs real frame sampling, cheap scanning, OCR, and Gemma analysis after the proxy 403 fix. It is not presented as a substitute for the blocked packaged end-to-end run.

## Five-video smoke test

Not run. Phase rules require the packaged known-video case to pass first.

## Status

Implementation, regression tests, isolated proxy validation, full tests, and build pass. Phase 6.1.3 remains blocked from full acceptance by the embedded extension's current transcript timeout. Do not begin the 20-video rerun yet.
