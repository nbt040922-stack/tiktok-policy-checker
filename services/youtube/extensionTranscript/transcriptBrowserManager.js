const { normalizeCues, segmentTranscript, timestampToSeconds } = require('../transcript');
const { EXTENSION_ID, EXTENSION_VERSION } = require('./extensionManager');

const DOM_SCRIPT = `(() => {
  const id = new URL(location.href).searchParams.get('v');
  const rows = [...document.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model')];
  const segments = rows.map(row => ({
    timestamp: (row.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp')?.textContent || '').trim(),
    text: (row.querySelector('.segment-text, .ytwTranscriptSegmentViewModelSegment, .ytAttributedStringHost')?.textContent || '').trim()
  })).filter(item => item.timestamp && item.text);
  if (!segments.length) {
    const root = document.documentElement;
    const staleClose = document.querySelector('button[aria-label="Close transcript"]');
    if (!root.dataset.tpcNavigationClean) {
      root.dataset.tpcNavigationClean = '1'; if (staleClose) staleClose.click();
    } else {
    const icon = document.querySelector('#glasp-yt-summary-icon-in-player');
    if (icon && !root.dataset.tpcExtensionOpened) {
      const seenAt = Number(document.documentElement.dataset.tpcExtensionSeenAt || 0);
      if (!seenAt) document.documentElement.dataset.tpcExtensionSeenAt = String(Date.now());
      else if (Date.now() - seenAt > 1000) { document.documentElement.dataset.tpcExtensionOpened = '1'; icon.click(); }
    } else if (document.querySelector('#glasp-yt-summary-widget') && !document.documentElement.dataset.tpcSummaryOpened) {
      const seenAt = Number(document.documentElement.dataset.tpcSummarySeenAt || 0);
      if (!seenAt) document.documentElement.dataset.tpcSummarySeenAt = String(Date.now());
      else if (Date.now() - seenAt > 750) {
        const summary = [...document.querySelectorAll('#glasp-yt-summary-widget *')]
          .find(node => node.children.length === 0 && /^YouTube Summary$/i.test((node.textContent || '').trim()));
        if (summary) { document.documentElement.dataset.tpcSummaryOpened = '1'; summary.click(); }
      }
    } else if (/YouTube Summary|Copy transcript|Transcript & Summary/i.test(document.body.innerText || '')
      && !document.documentElement.dataset.tpcTranscriptTriggered) {
      const candidates = [...document.querySelectorAll('.glasp-extension button, .glasp-extension [role="button"], .glasp-extension *')]
        .filter(node => node.children.length < 5);
      const button = candidates.find(node => /^(transcript|bản chép)$/i.test((node.textContent || '').trim()));
      if (button) { document.documentElement.dataset.tpcTranscriptTriggered = '1'; button.click(); }
    }
    }
  }
  const controls = [...document.querySelectorAll('button, [role="button"], [role="tab"]')]
    .map(node => ({ tag: node.tagName, text: (node.textContent || '').trim().slice(0, 60), aria: node.getAttribute('aria-label'),
      id: node.id, className: String(node.className || '').slice(0, 100) }))
    .filter(item => /transcript|summary|bản chép/i.test([item.text, item.aria].join(' '))).slice(0, 12);
  return { videoId: id, segments, controls, nativeRows: rows.length,
    extensionUiReady: Boolean(document.querySelector('#glasp-yt-summary-widget')) };
})()`;

function parseDomSegments(rows, durationSeconds = 0) {
  const starts = rows.map(row => ({ startSeconds: timestampToSeconds(String(row.timestamp || '')), text: String(row.text || '') }))
    .filter(row => Number.isFinite(row.startSeconds) && row.text.trim());
  return normalizeCues(starts.map((row, index) => ({
    ...row,
    endSeconds: starts[index + 1]?.startSeconds || Math.max(row.startSeconds + 4, Number(durationSeconds) || row.startSeconds + 4)
  })));
}

function transcriptForPage(state, videoId, durationSeconds) {
  return state?.videoId === videoId ? parseDomSegments(state.segments || [], durationSeconds) : [];
}

function cancelled() { return Object.assign(new Error('Analysis was cancelled.'), { code: 'ANALYSIS_CANCELLED' }); }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(cancelled()); }, { once: true });
  });
}

class TranscriptBrowserManager {
  constructor({ extensionManager, createBrowserWindow, timeoutMs = Number(process.env.EXTENSION_TRANSCRIPT_TIMEOUT_MS) || 45000,
    show = process.env.EXTENSION_TRANSCRIPT_HIDDEN !== '1', logger = () => {} } = {}) {
    this.extensionManager = extensionManager; this.createBrowserWindow = createBrowserWindow;
    this.timeoutMs = timeoutMs; this.show = show; this.logger = logger; this.window = null; this.tail = Promise.resolve();
  }
  async ensureWindow(visible = this.show) {
    await this.extensionManager.load();
    if (!this.window || this.window.isDestroyed()) {
      this.window = this.createBrowserWindow({ width: 1280, height: 900, show: visible,
        webPreferences: { session: this.extensionManager.session, nodeIntegration: false, contextIsolation: true, sandbox: true } });
      this.window.on('closed', () => { this.window = null; });
    } else if (visible) this.window.show();
    return this.window;
  }
  openSession() { return this.ensureWindow(true).then(window => window.loadURL('https://www.youtube.com/').catch(() => {})); }
  extract(request) {
    const run = this.tail.then(() => this._extract(request));
    this.tail = run.catch(() => {});
    return run;
  }
  async _extract({ videoId, url, durationSeconds, signal }) {
    if (signal?.aborted) throw cancelled();
    const started = Date.now(); const window = await this.ensureWindow();
    const abort = () => { if (!window.isDestroyed()) window.webContents.stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await window.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED') throw error; });
      const deadline = Date.now() + this.timeoutMs;
      let sawUi = false; let lastState = null;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw cancelled();
        const state = await window.webContents.executeJavaScript(DOM_SCRIPT, true);
        const childFrames = (window.webContents.mainFrame.framesInSubtree || window.webContents.mainFrame.frames).filter(frame => frame !== window.webContents.mainFrame).filter(frame =>
          frame.url.startsWith(`chrome-extension://${EXTENSION_ID}/`) || frame.url.startsWith('https://www.youtube.com/'));
        const childStates = await Promise.all(childFrames.map(async frame => ({
          url: (() => { try { const value = new URL(frame.url); return `${value.protocol}//${value.host}${value.pathname}`; } catch (_) { return ''; } })(),
          state: await frame.executeJavaScript(DOM_SCRIPT, true).catch(() => null)
        })));
        lastState = { ...state, frames: childStates };
        sawUi ||= state.extensionUiReady || childStates.some(item => item.state?.extensionUiReady);
        if (state.videoId !== videoId) { await sleep(500, signal); continue; }
        const transcriptState = [state, ...childStates.map(item => item.state)].find(item => item?.segments?.length) || state;
        const cues = transcriptForPage({ ...transcriptState, videoId: state.videoId }, videoId, durationSeconds);
        if (cues.length) {
          const extensionMs = Date.now() - started;
          this.logger({ event: 'provider-success', videoId, provider: 'EMBEDDED_EXTENSION', duration: extensionMs });
          return { transcriptCues: cues, transcriptSegments: segmentTranscript(cues), transcriptLanguage: 'unknown',
            transcriptSource: 'extension', transcriptProvider: { provider: 'EMBEDDED_EXTENSION', extensionId: EXTENSION_ID,
              extensionVersion: EXTENSION_VERSION, language: 'unknown', isAutoGenerated: null, retrievedAt: new Date().toISOString() }, extensionMs };
        }
        await sleep(500, signal);
      }
      throw Object.assign(new Error(sawUi ? 'Extension transcript timed out.' : 'Extension UI did not initialize.'),
        { code: sawUi ? 'EXTENSION_TIMEOUT' : 'EXTENSION_RUNTIME_FAILED', diagnostics: lastState });
    } catch (error) {
      if (error.code !== 'ANALYSIS_CANCELLED') this.extensionManager.reportRuntimeFailure(error);
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  destroy() { if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = null; }
}

module.exports = { DOM_SCRIPT, TranscriptBrowserManager, parseDomSegments, transcriptForPage };
