const path = require('node:path');
const { ExtensionManager } = require('../services/youtube/extensionTranscript/extensionManager');
const { TranscriptBrowserManager } = require('../services/youtube/extensionTranscript/transcriptBrowserManager');

async function main() {
  const { app, BrowserWindow, session } = require('electron');
  app.setPath('userData', process.env.TRANSCRIPT_TEST_USER_DATA || path.join(process.env.APPDATA, 'tiktok-policy-checker'));
  await app.whenReady();
  const manager = new ExtensionManager({ userDataPath: app.getPath('userData'),
    sessionFromPartition: (partition, options) => session.fromPartition(partition, options) });
  manager.session.webRequest.onCompleted({ urls: ['https://www.youtube.com/*'] }, details => {
    const url = new URL(details.url);
    if (/timedtext|get_transcript|get_panel/.test(url.pathname)) console.log(JSON.stringify({ event: 'transcript-network', path: url.pathname, status: details.statusCode }));
  });
  const browser = new TranscriptBrowserManager({ extensionManager: manager,
    createBrowserWindow: options => new BrowserWindow(options), show: process.env.EXTENSION_TRANSCRIPT_HIDDEN !== '1' });
  const videoId = process.env.YOUTUBE_TRANSCRIPT_VIDEO_ID || 'wxEpPin8MWw';
  try {
    const result = await browser.extract({ videoId, url: `https://www.youtube.com/watch?v=${videoId}`,
      durationSeconds: Number(process.env.YOUTUBE_TRANSCRIPT_VIDEO_DURATION) || 0 });
    console.log(JSON.stringify({ status: 'PASS', videoId, provider: result.transcriptProvider,
      cueCount: result.transcriptCues.length, segmentCount: result.transcriptSegments.length, extensionMs: result.extensionMs }, null, 2));
  } finally { browser.destroy(); app.quit(); }
}

if (process.versions.electron) main().catch(error => {
  const { app } = require('electron');
  console.error(JSON.stringify({ status: 'FAIL', code: error.code, message: error.message, diagnostics: error.diagnostics }));
  app.once('will-quit', () => { process.exitCode = 1; }); app.quit();
});

module.exports = { main };
