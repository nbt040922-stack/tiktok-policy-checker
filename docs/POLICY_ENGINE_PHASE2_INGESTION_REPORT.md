# TikTok Policy Checker — Phase 2 Ingestion Report

## Architecture

Phase 2 keeps the Phase 1 UI/result contract and adds two boundaries:

1. `services/youtube/` runs in Electron's main process. It receives yt-dlp metadata, selects and fetches one subtitle track, normalizes cues, and creates analysis-sized transcript segments.
2. `services/policyAnalysis/` runs in the renderer. It converts real transcript segments into deterministic temporary decisions and derives safe windows.

Renderer communication stays behind the existing context-isolated preload bridge. No new dependency was added.

## Files changed

- `services/youtube/index.js`: metadata normalization, subtitle selection/fetch, safe errors, ingestion orchestration.
- `services/youtube/transcript.js`: JSON3/VTT parsing, cue cleanup, rolling-caption dedupe, segmentation.
- `services/policyAnalysis/index.js`: URL normalization, timestamp formatting, real-ingestion adapter, temporary decisions, safe-window baseline, request guard.
- `main.js`: reusable metadata call, authenticated ingestion IPC, real progress events.
- `preload.js`: narrow ingestion and progress APIs.
- `renderer.js`: request guard, real duration formatting, empty-result messages.
- `style.css`: empty-result styling.
- `scripts/manual-ingestion-check.js`: no-media real URL check.
- `test/policy-analysis.test.js`, `test/youtube-ingestion.test.js`, `test/auth-session.test.js`: Phase 2 coverage.

Downloader, engine runtime, authentication implementation, download manager, and Content Ops bridge were not rewritten.

## Metadata flow

```text
URL
  → normalize to canonical YouTube watch URL
  → renderer IPC
  → existing temporary authenticated cookie export
  → bundled yt-dlp --no-playlist --skip-download --dump-single-json
  → normalized metadata
```

Returned metadata contains real `videoId`, URL, title, duration, channel, and thumbnail URL. The command uses simulation/metadata mode and never requests video media.

## Transcript acquisition strategy

yt-dlp metadata supplies signed subtitle track URLs. The service fetches only the selected JSON3 or VTT subtitle resource through Node/Electron `fetch`; it does not download video or audio.

## Subtitle priority

1. Manual English (`en`, then English variants).
2. Auto-generated English.
3. Manual non-English fallback.
4. Auto-generated non-English fallback.
5. `TRANSCRIPT_UNAVAILABLE` when no supported JSON3/VTT track exists.

JSON3 is preferred over VTT within one language because it carries numeric millisecond timestamps directly.

## Normalization

- Numeric `startSeconds`/`endSeconds` remain source of truth.
- Whitespace is trimmed and collapsed.
- Empty/invalid cues are removed.
- Cues are sorted chronologically.
- Exact overlapping duplicates are merged.
- Rolling captions such as `hello` followed by `hello world` are collapsed without paraphrasing.
- Minimal subtitle markup/entities are removed/decoded; spoken wording is preserved.

## Segmentation

`segmentTranscript(cues, options)` creates stable policy-sized segments. Defaults:

- minimum duration: 12 seconds before sentence-boundary flush;
- maximum duration: 45 seconds;
- maximum text: 500 characters;
- maximum continuity gap: 2.5 seconds.

Options are configurable without changing the result contract.

## Error handling

Safe internal codes:

- `VIDEO_UNAVAILABLE`
- `TRANSCRIPT_UNAVAILABLE`
- `AUTH_REQUIRED`
- `NETWORK_ERROR`
- `INGESTION_ERROR`
- `CANCELLED`

IPC returns only code plus safe message. Raw yt-dlp output and stack traces are not exposed in UI. Logs record the code, not subtitle URLs, cookies, or tokens.

## Authentication reuse

Ingestion uses the existing `YouTubeAuthSession.withTemporaryCookies()` path. Temporary Netscape cookies are passed only to yt-dlp metadata acquisition and removed by the existing `finally` cleanup. No second login system, hardcoded cookie, or secret logging was added.

## Cancellation behavior

Every renderer request receives a generation token. Starting Video B invalidates Video A immediately; old stage events are suppressed in main process and stale results cannot render. Closing Electron terminates remaining child work with the app. Phase 2 does not yet kill an already-running yt-dlp metadata process when a newer request starts; it only prevents stale UI/state writes.

## Tests

- `npm test`: 89 passed, 0 failed.
- JavaScript syntax checks: passed.
- `npm run preflight`: passed for bundled yt-dlp, Deno, and FFmpeg.
- `npm run build`: passed; portable Windows executable created.
- Coverage includes URL normalization, metadata parsing, JSON3/VTT, rolling duplicates, segmentation, timestamp formatting, missing/malformed transcript, safe windows, auth reuse, no-media arguments, and race protection.

## Manual E2E

Run on 2026-08-14 without cookies and without downloaded artifacts:

1. Manual captions — `M7lc1UVf-VE`
   - Real title: `YouTube Developers Live: Embedded Web Player Customization`
   - Duration: 1344 seconds
   - Track: manual English
   - 466 normalized cues; 84 analysis segments
   - UI smoke-test: Enter triggered real ingestion, title/duration rendered, Checked became 1, five 2–3 minute recommended clips rendered from real timestamps.
2. Auto captions — `yfUlMjsMfxs`
   - Real title: `My Realistic 9–5 as a Software Engineer at Amazon`
   - Duration: 961 seconds
   - Track: automatic English
   - 389 normalized cues; 46 analysis segments
3. No transcript — `aqz-KE-bpKQ`
   - Real metadata retrieved.
   - Expected `TRANSCRIPT_UNAVAILABLE` returned with safe UI message.

No MP4, audio, subtitle, or cookie artifact was written to the repository.

## Known limitations

- KEEP/REVIEW/REMOVE decisions remain deterministic placeholders based on segment position, not TikTok policy analysis.
- Direct subtitle URLs are short-lived; an expired URL requires retrying metadata acquisition.
- Only JSON3 and VTT tracks are accepted. Other subtitle formats fall through to another supported track or a safe error.
- Request generations prevent race overwrite but do not preempt an active yt-dlp subprocess.
- A concurrent previously-running portable app caused Chromium disk-cache lock warnings during smoke testing; the Phase 2 UI and ingestion completed normally with no renderer exception.
- Build uses the default Electron icon. Portable build compression took about six minutes and briefly waited for antivirus to release the output file.

## Phase 3 recommendation

Add a real policy engine behind `analyzeTranscriptSegments()` while preserving ingestion and result models. Add explicit main-process subprocess cancellation before expanding policy logic. Do not add RAG, embeddings, or media download until policy requirements and evaluation fixtures are defined.
