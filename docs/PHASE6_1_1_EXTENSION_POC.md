# Phase 6.1.1 — YouTube Summary Extension Electron POC

## Decision

`EXTENSION_WORKS_IN_ELECTRON`

The extension loaded, its Manifest V3 service worker ran, the YouTube content
script rendered the complete UI, a transcript appeared for a Phase 6.1 video
whose direct timed-text request returned HTTP 429, and **Copy transcript** put a
4,028-character transcript on the clipboard. Production ingestion code was not
changed and the extension is not bundled with the application.

## Environment and extension

| Item | Result |
| --- | --- |
| Extension | YouTube Summary with ChatGPT & Claude |
| Extension ID | `nmmicjeknamkfloonkhhcjmomieiodli` |
| Extension version | `2.3.1` (installed directory `2.3.1_0`) |
| Installed source | Cốc Cốc `Default` Chromium profile; not present in local Chrome profiles |
| POC copy | `%TEMP%\TikTokPolicyChecker\extension-poc\youtube-summary\2.3.1` |
| Manifest | Version 3 |
| Electron | 28.3.3 |
| Partition | `persist:youtube-transcript-poc` |
| POC user data | `%LOCALAPPDATA%\TikTokPolicyChecker\ExtensionPOC` |
| Loader | `session.loadExtension` (required by Electron 28; `session.extensions` is absent) |
| Load result | `EXTENSION_LOADED`; ID, name, and version matched |
| Load errors/warnings | No extension load error or warning observed |

Electron 28 officially loads unpacked extensions per persistent session through
`session.loadExtension`. Its documented extension API support is intentionally
partial: [Electron 28.3.3 extension documentation](https://github.com/electron/electron/blob/v28.3.3/docs/api/extensions.md).

## Manifest inspection

- `permissions`: `storage`
- `host_permissions`: absent
- YouTube content script: `assets/youtube-helper.ts-loader-843c8d69.js` on
  `https://www.youtube.com/*`
- Other content scripts: Glasp, ChatGPT, Claude, Mistral, Gemini, AI Studio,
  Grok, plus an `<all_urls>` web helper
- background: module service worker `service-worker-loader.js`
- `web_accessible_resources`: declared for `<all_urls>` and the matching
  provider/YouTube origins
- `externally_connectable`: absent

The copied third-party files remain outside Git and were not modified.

## Chrome API compatibility

Static inspection found the calls below. “Official” refers to the Electron
28.3.3 support list; an unlisted API can still work provisionally.

| API | Used | Electron 28 official | Observed |
| --- | --- | --- | --- |
| `runtime.id`, `lastError` | Yes | Yes | Working |
| `runtime.getManifest`, `getURL` | Yes | Yes | Working |
| `runtime.connect`, `sendMessage` | Yes | Yes | Working; content/background messaging completed |
| `runtime.onConnect`, `onMessage` | Yes | Yes | Working |
| `runtime.onInstalled`, `onStartup` | Yes | Yes | No error; service worker active |
| `runtime.setUninstallURL` | Yes | No (unlisted) | Non-fatal; not functionally exercised |
| `storage.local`, `storage.onChanged` | Yes | Yes (`storage.local`) | Working across POC restart |
| `tabs.sendMessage` | Yes | Yes | Working through extension UI flow |
| `tabs.query` | Yes | Partial | Non-fatal; exact filters not exhaustively exercised |
| `tabs.update` | Yes | Partial | Not exercised |
| `tabs.create` | Yes | No (unlisted) | Not exercised; summary-in-new-tab was intentionally skipped |
| `windows.update` | Yes | No (unlisted) | Not exercised |
| Manifest V3 background service worker | Yes | No (only MV2 background is listed) | Working: registered and handled messages |

No use of `chrome.sidePanel`, `chrome.identity`, `chrome.cookies`, or
`chrome.webRequest` was found.

## Runtime results

Test video: `wxEpPin8MWw`, one of the Phase 6.1 sources that produced timed-text
HTTP 429 in the production ingestion test.

| Check | Result |
| --- | --- |
| Normal Chromium extension baseline | PASS per operator-provided baseline |
| Electron unpacked extension | PASS |
| `EXTENSION_LOADED` | Yes |
| `BACKGROUND_ACTIVE` | Yes; extension service worker registered |
| `CONTENT_SCRIPT_ACTIVE` | Yes; injected player icon and sidebar |
| `UI_VISIBLE` | Yes; Transcript/Summary/Chat/Highlights UI rendered |
| Transcript | `TRANSCRIPT_SUCCESS` |
| Copy transcript | PASS; 4,028 characters, expected title and first sentence verified without logging clipboard text |
| Restart | Extension and UI loaded again from the same persistent partition |
| YouTube login | `LOGIN_NOT_PERSISTED`; no login was established, so this records the observed signed-out restart rather than a failed authenticated-cookie test |

The POC never automated Google login. An operator can establish a login manually
and repeat close/restart if authenticated persistence is needed later; transcript
success did not require login in this test.

## Transcript source and network flow

Successful source classification: **A + B**.

1. The extension first called YouTube internal `youtubei/v1/get_transcript` and
   received HTTP 400.
2. It tried the caption track `api/timedtext` repeatedly and received HTTP 429.
3. It called Glasp `cf-api-getYtScripts` (HTTP 200), but no usable transcript was
   produced by that fallback.
4. Its final fallback clicked YouTube's native transcript control. YouTube called
   `youtubei/v1/get_panel` (HTTP 200), rendered transcript segment nodes, and the
   extension read those nodes from the page DOM.
5. Copy used the already-rendered transcript array and the browser clipboard API.

This matches the inspected bundle: `I7` tries `get_transcript`, `k3` tries
timed-text, `k7` messages the Glasp service worker, and `N7` clicks the YouTube
transcript button then parses `ytd-transcript-segment-renderer` or
`transcript-segment-view-model` nodes.

| Host | Path pattern | Method | Status | Role |
| --- | --- | --- | --- | --- |
| `www.youtube.com` | `/youtubei/v1/get_transcript` | POST | 400 | Failed internal API attempt |
| `www.youtube.com` | `/api/timedtext` | GET | 429 | Failed caption attempt |
| `us-central1-driven-current-285910.cloudfunctions.net` | `/cf-api-getYtScripts` | POST | 200 | Glasp fallback attempt |
| `www.youtube.com` | `/youtubei/v1/get_panel` | POST | 200 | Successful native transcript panel |
| `us-central1-driven-current-285910.cloudfunctions.net` | `/cf-api-youtube` | POST | 200 | Glasp transcript check/log path |
| `us-central1-driven-current-285910.cloudfunctions.net` | `/cf-logs-sendGlaspLog` | POST | 200 | Glasp telemetry |
| `yt-summary.glasp.co` | `/yt_lg/:videoId/unknown/unknown/{action}` | GET | `ERR_FAILED` | Non-blocking extension telemetry |

All requests ran in the isolated persistent partition. Cookie values and request
headers were deliberately not inspected. Logs contain hostname, redacted path
pattern, method, status, initiator when available, and partition only.

## First incompatibility and security boundary

The first concrete compatibility difference was the loading API: Electron 28
does not expose `session.extensions.loadExtension`, so the POC uses the version-
appropriate `session.loadExtension`. This did not prevent extension operation.
The extension also triggers a harmless YouTube reload that supersedes the first
navigation; the POC records `ERR_ABORTED` without treating it as a crash.

No Chrome cookies, passwords, credentials, raw cookies, signed URLs, extension
session data, screenshots, or copied third-party extension files are committed.
The production `services/youtube` pipeline is unchanged.

## Recommended next step

Reproduce only the successful transport independently:

```text
Electron persistent YouTube session
→ open YouTube native transcript panel
→ wait for transcript segment DOM
→ parse timestamps/text
```

Do not integrate or patch the third-party extension. Glasp backends are contacted
by the extension, but the successful transcript transport observed here came
from YouTube's native panel/DOM and can be implemented without Glasp credentials
or private APIs.
