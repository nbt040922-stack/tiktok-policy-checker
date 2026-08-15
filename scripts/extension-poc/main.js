const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:youtube-transcript-poc';
const TRANSCRIPT_REQUEST = /(?:timedtext|get_transcript|transcript|caption|glasp|youtubei|cf-api-(?:getYtScripts|youtube))/i;

function redactText(value) {
  return String(value || '')
    .replace(/([?&](?:key|token|auth|signature|sig|expire|ei|lsig|oauth)[^=]*)=[^&\s]+/gi, '$1=[REDACTED]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/[A-Za-z0-9_-]{80,}/g, '[REDACTED]');
}

function networkRecord(details, status) {
  const url = new URL(details.url);
  return {
    event: 'transcript-network',
    hostname: url.hostname,
    path: url.pathname
      .replace(/(?<=\/)[A-Za-z0-9_-]{11}(?=\/|$)/g, ':videoId')
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, ':id'),
    method: details.method,
    status,
    initiator: details.initiator ? redactText(details.initiator).split('?')[0] : null,
    session: PARTITION,
    cookies: 'NOT_INSPECTED'
  };
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function run() {
  const { app, BrowserWindow, session } = require('electron');
  const extensionPath = path.resolve(process.env.YOUTUBE_TRANSCRIPT_EXTENSION_PATH || '');
  if (!process.env.YOUTUBE_TRANSCRIPT_EXTENSION_PATH || !fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error('YOUTUBE_TRANSCRIPT_EXTENSION_PATH must point to a copied unpacked extension containing manifest.json.');
  }
  if (/\\User Data\\.*\\Extensions\\/i.test(extensionPath)) {
    throw new Error('Refusing to load the browser-installed copy. Run npm run poc:extension:prepare first.');
  }

  app.setName('TikTok Policy Checker Extension POC');
  app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'TikTokPolicyChecker', 'ExtensionPOC'));

  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (_consoleEvent, level, message, line, sourceId) => emit({
      event: 'console', type: contents.getType(), level, message: redactText(message), line,
      source: redactText(sourceId).split('?')[0]
    }));
    contents.on('render-process-gone', (_goneEvent, details) => emit({ event: 'renderer-gone', reason: details.reason }));
  });

  await app.whenReady();
  const ses = session.fromPartition(PARTITION, { cache: true });
  ses.serviceWorkers.on('console-message', (_event, details) => emit({
    event: 'service-worker-console', level: details.level, message: redactText(details.message),
    source: redactText(details.source).split('?')[0]
  }));
  ses.serviceWorkers.on('registration-completed', (_event, details) => emit({
    event: 'service-worker-registered', scope: redactText(details.scope).split('?')[0]
  }));

  const filter = { urls: ['https://*/*'] };
  ses.webRequest.onCompleted(filter, details => {
    if (TRANSCRIPT_REQUEST.test(details.url)) emit(networkRecord(details, details.statusCode));
  });
  ses.webRequest.onErrorOccurred(filter, details => {
    if (TRANSCRIPT_REQUEST.test(details.url)) emit(networkRecord(details, details.error));
  });

  let extension;
  try {
    const modernLoader = ses.extensions && ses.extensions.loadExtension;
    extension = modernLoader
      ? await modernLoader.call(ses.extensions, extensionPath, { allowFileAccess: false })
      : await ses.loadExtension(extensionPath, { allowFileAccess: false });
    emit({ event: 'extension-loaded', id: extension.id, name: extension.name, version: extension.version,
      path: extensionPath, loader: modernLoader ? 'session.extensions.loadExtension' : 'session.loadExtension' });
  } catch (error) {
    emit({ event: 'extension-load-failed', message: redactText(error.message) });
    throw error;
  }

  const window = new BrowserWindow({
    title: 'YouTube Transcript Extension POC', width: 1280, height: 900, show: false,
    webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  window.webContents.on('did-finish-load', () => {
    const probe = async phase => {
      if (window.isDestroyed()) return;
      const page = await window.webContents.executeJavaScript(`({
        url: location.origin + location.pathname,
        signedIn: ![...document.querySelectorAll('a, button')].some(el => /^Sign in$/i.test((el.textContent || '').trim())),
        extensionTextVisible: /YouTube Summary/.test(document.body.innerText || '')
      })`, true).catch(error => ({ probeError: redactText(error.message) }));
      emit({ event: 'page-probe', phase, ...page });
    };
    void probe('ready');
    setTimeout(() => void probe('settled'), 5000);
  });
  window.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) emit({ event: 'page-load-failed', code, description, url: validatedURL.split('?')[0] });
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => app.quit());

  const target = process.env.YOUTUBE_TRANSCRIPT_VIDEO_URL || 'https://www.youtube.com/';
  await window.loadURL(target).catch(error => {
    if (error.code !== 'ERR_ABORTED') throw error;
    emit({ event: 'navigation-superseded', url: target.split('?')[0] });
  });
  if (process.env.POC_OPEN_DEVTOOLS === '1') window.webContents.openDevTools({ mode: 'detach' });
}

if (process.versions.electron) run().catch(error => {
  console.error(redactText(error.stack || error.message));
  require('electron').app.quit();
});

module.exports = { PARTITION, TRANSCRIPT_REQUEST, networkRecord, redactText };
