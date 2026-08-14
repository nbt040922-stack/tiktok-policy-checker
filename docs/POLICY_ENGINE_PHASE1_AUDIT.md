# TikTok Policy Checker — Phase 1 Audit

## Current architecture

- Desktop framework: Electron 28, packaged with `electron-builder` for a Windows portable build.
- Frontend: plain HTML, CSS, and browser JavaScript. There is no frontend framework, bundler, or TypeScript compiler.
- Runtime/backend: Electron main process on Node.js. `main.js` creates the window and owns IPC, app lifecycle, settings, tray, YouTube authentication, yt-dlp orchestration, and downloader recovery.
- Entrypoints: `main.js` for Electron, `index.html` for the renderer, `preload.js` for the context-isolated bridge, and `renderer.js` for UI behavior.
- URL input: `#urlInput` in `index.html`; `renderer.js` reads it, validates YouTube URLs, and triggers work.
- Enter workflow: a `keydown` listener prevents a plain Enter newline and calls the same button action as a click. Shift+Enter previously inserted a newline for multi-URL input.
- Center area: `#downloadList` for queue cards and `#welcomeArea` for the empty state.
- Status bar: `#engineLabel`, derived in the renderer from downloader job states.
- Menu: a custom draggable title bar with File, Downloads, Language, and Tools menus. Its actions are wired directly in `renderer.js` to the preload API.
- Downloader: `download-manager.js` owns queue state, concurrency, retries, cancellation, persistence cleanup, and progress updates. `main.js` supplies the yt-dlp execution callback.
- yt-dlp integration: `engine-runtime.js`, `runtime-binaries.js`, and `main.js` resolve bundled yt-dlp/Deno/FFmpeg binaries, fetch metadata, run downloads, verify output, update, repair, and recover.
- State management: local mutable renderer state plus `DownloadManager` in the main process; no external state library.
- IPC: context isolation is enabled. `preload.js` exposes a narrow `window.electronAPI`; `main.js` registers the matching IPC handlers.
- Build/config: `package.json` provides `start`, Node test runner, preflight, and electron-builder scripts. Runtime binaries are expected under `resources/bin/fallback` for packaged builds.
- Dependencies: only Electron and electron-builder are declared. Font Awesome and Inter are currently loaded from CDNs by `index.html`.
- Tests: Node's built-in test runner covers runtime binaries, engine recovery, downloads, authentication, bridge behavior, and several DOM/CSS contracts. There is no browser component-test framework.

The workspace `D:\Tiktok Policy Checker` was initially empty. The audited source is the adjacent clean Git repository at `D:\YTDOWNLOAD`; Phase 1 will copy its working files into the workspace without changing the original repository.

## Reusable components

- Electron window shell, custom title bar, window controls, background, glass surfaces, spacing, rounded URL capsule, and footer.
- `preload.js` security boundary and existing IPC contract.
- Main-process downloader, yt-dlp runtime, authentication, settings, tray, and recovery code for future metadata/transcript integration.
- Existing Node test infrastructure and CSS contract-test style.
- Existing Font Awesome icon system; no new icon package is needed.

## Components cần sửa

- `index.html`: product title, single-URL placeholder, Analyze semantics, four-state result region, and policy-focused footer.
- `renderer.js`: replace the downloader-first interaction with `analyzeVideo(url)`, progress state, result rendering, error/retry handling, state-driven counters, Enter, and Ctrl+L focus.
- `style.css`: retain the current visual language while styling the policy result states and decision badges.
- `package.json`: update product metadata while keeping the existing build/runtime setup.
- Add a small browser-compatible policy analysis service boundary and mock result model.
- Add focused tests for validation, the mock service, all three decisions, and the Enter contract.

## Components không nên đụng tới

- `download-manager.js`, `engine-runtime.js`, `runtime-binaries.js`, `auth-session.js`, and `contentops-bridge.js`.
- Existing main-process IPC handlers, binary provisioning, update/repair, authentication, and download execution paths.
- Existing recovery and downloader tests, except where an old UI-only contract must be updated for the new product purpose.
- The overall window geometry, title bar implementation, background, URL capsule, footer shell, and compact visual language.

## Risks

- CDN-hosted fonts/icons may be unavailable offline; the app already has system-font fallbacks, but icons depend on the existing remote Font Awesome stylesheet.
- The current renderer is tightly coupled to downloader menus. Replacing it in place would remove useful working code, so the original renderer should be retained as a dormant legacy file.
- Existing UI contract tests assert downloader-specific markup and will need a narrow policy-focused update.
- Phase 1 mock progress is timer-driven and does not represent real metadata/transcript work.
- There is no TypeScript toolchain. Models should use JSDoc typedefs to remain typed without adding a compiler or dependency.

## Recommended implementation plan

1. Copy the clean YTDOWNLOAD working tree into the current workspace, excluding `.git`, `node_modules`, and generated output.
2. Preserve the existing renderer as `renderer-downloader.js`; leave all downloader/backend modules intact.
3. Add `services/policyAnalysis/index.js` with JSDoc models, YouTube URL validation, the `analyzeVideo(url, onStageChange)` public boundary, and a mock implementation.
4. Replace only the center renderer experience with EMPTY, ANALYZING, SUCCESS, and ERROR states while retaining the existing shell and styling language.
5. Drive `Queue | Analyzing | Checked` from renderer state and support click, Enter, retry, and Ctrl+L.
6. Add small Node tests using the existing built-in runner; do not install a new test framework.
7. Run tests, launch Electron for a smoke check, inspect output, then produce the Phase 1 report.
