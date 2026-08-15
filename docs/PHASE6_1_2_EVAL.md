# Phase 6.1.2 evaluation

## Current decision

Status: `PARTIAL — KNOWN VIDEO BLOCKED`

Extension loading, production session isolation, structured DOM extraction, cancellation, stale-video protection, provider metadata, circuit breaker, doctor, and a second real news video pass are implemented. The required known video `wxEpPin8MWw` currently reaches extension timed-text HTTP 429 but does not receive/render the native `get_panel` result before the 45-second bound. Therefore the phase does not claim PASS and the five-video or twenty-video workloads were not started.

## Environment

- Extension: YouTube Summary with ChatGPT & Claude `2.3.1`.
- ID: `nmmicjeknamkfloonkhhcjmomieiodli`.
- Session: `persist:youtube-transcript`.
- Location: `%APPDATA%\tiktok-policy-checker\extensions\youtube-summary` (outside Git).
- Login: signed out; manual login not required for the passing video.

## Real results

### Known 429 video — `wxEpPin8MWw`

- Extension loaded and widget activated.
- `youtubei/v1/get_transcript`: HTTP 400.
- timed-text: HTTP 429.
- Result: `EXTENSION_TIMEOUT` at 45 seconds; zero accepted DOM rows.
- Pipeline continuation: not reached.

This is a current external/runtime failure, not reported as success based on the older Phase 6.1.1 POC.

### Second Phase 6.1 video — `ooiOo4WjutY`

- timed-text: HTTP 429.
- `youtubei/v1/get_transcript`: HTTP 400.
- `youtubei/v1/get_panel`: HTTP 200.
- Result: PASS, 19 timestamped cues and 5 normalized analysis segments.
- Extension latency: 10,586 ms.

The live run exposed two required compatibility details: the fallback BrowserWindow must render visibly, and current YouTube rows use `transcript-segment-view-model` with `ytAttributedStringHost` text nodes.

## Deferred gates

- Full Qwen/visual/report pipeline: not run because the exact known-video gate failed.
- Five-video queue: not run.
- Twenty-video Phase 6.1 rerun: not run.
- Cold/warm aggregate latency and 1/5/20 renderer memory: not claimable.
- Login persistence: session is persistent by construction; authenticated restart was not exercised because login automation is prohibited and manual login was unnecessary.

These gates must remain blocked until `wxEpPin8MWw` again produces native transcript DOM or an explicitly approved substitute acceptance rule is chosen.

## Regression and build

- Automated suite: PASS, 178/178.
- Extension doctor: PASS.
- Windows x64 portable build: PASS.
- Packaged startup/normal-close smoke: PASS; zero remaining app processes.
- Artifact: `dist/TikTok Policy Checker 1.0.0.exe`, 255,831,970 bytes.
- SHA-256: `726271F1E25B7D285D94F1C9186224E4551C32C7302E813381B9BBF687733597`.
