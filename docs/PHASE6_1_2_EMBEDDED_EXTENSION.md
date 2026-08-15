# Phase 6.1.2 — embedded transcript extension

## Architecture

Transcript ingestion remains a two-provider chain:

1. `DIRECT_CAPTION` — existing yt-dlp metadata and timed-text track.
2. `EMBEDDED_EXTENSION` — Electron session `persist:youtube-transcript`, used only for HTTP 408/429/5xx or caption transport network failures.

No-caption, invalid URL, private, removed, and authentication failures do not invoke the extension. Two consecutive timed-text HTTP 429 responses open a 15-minute circuit breaker; one direct probe is allowed after cooldown. Extension work is sequential through one reusable BrowserWindow. Navigation state and target video ID are checked before DOM data is accepted.

The extension is loaded once per app process. Its session is isolated from both the default app session and the existing YouTube authentication session. Login, when required, is manual through **Open YouTube Session**. The app never imports browser cookies, fills Google credentials, or reads cookie values.

## Provisioning

Third-party source is not committed or bundled. The operator must review its license and provision an unpacked, unmodified copy of **YouTube Summary with ChatGPT & Claude 2.3.1**.

Development can point directly to an operator-controlled copy:

```powershell
$env:YOUTUBE_TRANSCRIPT_EXTENSION_PATH='C:\controlled\youtube-summary-2.3.1'
npm run transcript:extension:doctor
```

Packaged/default location:

```text
%APPDATA%\tiktok-policy-checker\extensions\youtube-summary\manifest.json
```

Copy the already reviewed unpacked directory into that location before launching the app. Normal production execution never reads Chrome, Edge, or Cốc Cốc user-data directories.

## Runtime behavior

- Exact expected extension ID: `nmmicjeknamkfloonkhhcjmomieiodli`.
- Exact tested version: `2.3.1`, Manifest V3.
- Timeout: `EXTENSION_TRANSCRIPT_TIMEOUT_MS`, default 45 seconds.
- Direct 429 switches immediately; 408/5xx receive one direct retry first.
- Browser fallback is visible because live validation showed hidden rendering did not activate the extension UI. Set `EXTENSION_TRANSCRIPT_HIDDEN=1` only for investigation; hidden mode is not validated.
- DOM interaction uses stable labels and native transcript segment elements, never screen coordinates or minified extension functions.
- Logs contain job/video/provider/timing/error metadata, never transcript text, cookies, extension storage, auth data, or clipboard data.

The extension may internally contact Glasp. Product code does not call Glasp, use private Glasp APIs, hold Glasp credentials, modify extension code, or automate account/rate-limit evasion.

## Commands

```powershell
npm run transcript:extension:doctor
npm run transcript:extension:test
```

The doctor validates the controlled path and manifest without opening YouTube. The live test defaults to `wxEpPin8MWw`; use `YOUTUBE_TRANSCRIPT_VIDEO_ID` for another authorized video.
