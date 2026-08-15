const { app, BrowserWindow, ipcMain, dialog, session, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  AnalysisJobStore, AnalysisQueue, GpuScheduler, JOB_STAGE, ReportManager, elapsedMs
} = require('./analysis-jobs');
const { StructuredLogger } = require('./structured-log');
const { DownloadManager, JOB_STATES, PROGRESS_PREFIX, parseYtDlpProgress } = require('./download-manager');
const { ContentOpsBridge } = require('./contentops-bridge');
const { clearEphemeralState } = require('./ephemeral-state');
const { YouTubeAuthSession, isAuthRequired, redactSensitive } = require('./auth-session');
const { YouTubeIngestionService, classifyIngestionError, fetchSubtitleWithRetry } = require('./services/youtube');
const { ExtensionManager } = require('./services/youtube/extensionTranscript/extensionManager');
const { TranscriptBrowserManager } = require('./services/youtube/extensionTranscript/transcriptBrowserManager');
const { TimedTextCircuitBreaker, TranscriptProviderChain } = require('./services/youtube/providerChain');
const { ModelFindingCache, POLICY_JUDGE_PROMPT_VERSION, PolicyJudgeService, loadPolicyJudgeConfig } = require('./services/policyJudge');
const { LocalQwenProvider, PolicyJudgeError } = require('./services/policyJudge/provider');
const { loadPolicySet } = require('./services/policyKnowledge');
const {
  VisualFindingCache, VisualMediaService, VisualRiskService, VisualSamplingService, loadVisualRiskConfig
} = require('./services/visualRisk');
const {
  FINAL_PATH_PREFIX,
  bootstrapRuntime,
  buildYtDlpBaseArgs,
  classifyYtDlpFailure,
  executeWithRecovery,
  extractFinalPath,
  periodicUpdateCheck,
  repairYtDlp,
  resolveBinaryPaths,
  runEngineDiagnostics,
  runProcess,
  safeUpdateYtDlp,
  updateLogRecord
} = require('./engine-runtime');

let mainWindow;
let tray = null;
let latestDiagnostics = null;
let updateInFlight = null;
let downloadManager = null;
let youtubeAuth = null;
let youtubeIngestion = null;
let transcriptExtension = null;
let transcriptBrowser = null;
let contentOpsBridge = null;
let policyJudge = null;
let visualRisk = null;
let visualMedia = null;
let analysisQueue = null;
let quitCleanupStarted = false;
const gpuScheduler = new GpuScheduler();
const latestAnalysisRequests = new Map();
const activeAnalysisControllers = new Map();
const MAX_CONCURRENT_DOWNLOADS = 2;

// Dynamic Binary Path Resolver
const binaryPaths = resolveBinaryPaths({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appDir: __dirname,
  userDataPath: app.getPath('userData')
});
const { ytdlpPath } = binaryPaths;
const legacyCookiesPath = path.join(app.getPath('userData'), 'cookies.txt');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const logPath = path.join(app.getPath('userData'), 'app_debug.log');
const jobsPath = path.join(app.getPath('userData'), 'download-jobs.json');
const contentOpsRecordsPath = path.join(app.getPath('userData'), 'contentops-handoffs.json');
const analysisJobsPath = path.join(app.getPath('userData'), 'analysis-jobs.json');
const reportsPath = path.join(app.getPath('userData'), 'reports');
const exportsPath = path.join(app.getPath('userData'), 'exports');
const logsPath = path.join(app.getPath('userData'), 'logs');
const contentOpsBridgePort = Number.parseInt(process.env.CONTENTOPS_BRIDGE_PORT || '8790', 10);
const contentOpsHeadless = process.env.CONTENTOPS_HEADLESS === '1';

clearEphemeralState(app.getPath('userData'));
const spawnEnv = { ...process.env };
const appLogger = new StructuredLogger({ filePath: path.join(logsPath, 'app.log') });
const jobsLogger = new StructuredLogger({ filePath: path.join(logsPath, 'jobs.log') });

// Persistent Settings Manager
function getSettings() {
  const defaults = { savePath: app.getPath('downloads'), keepReportsDays: 0 };
  try {
    if (fs.existsSync(settingsPath)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
    }
  } catch (e) {
    logToFile('Error reading settings.json: ' + e.message);
  }
  return defaults;
}

function saveSettings(settings) {
  try {
    const merged = { ...getSettings(), ...settings };
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (e) {
    logToFile('Error saving settings.json: ' + e.message);
    return settings;
  }
}

// Global Save Path Initialization
let currentSavePath = getSettings().savePath;

function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logPath, logEntry, 'utf8');
  appLogger.write({ event: 'app', message });
}

// Verification & Startup
async function validateBinaries() {
  const diagnostics = await runEngineDiagnostics(binaryPaths, spawnEnv);
  latestDiagnostics = diagnostics;
  logToFile('Engine diagnostics: ' + JSON.stringify(diagnostics));
  const failures = ['ytdlp', 'deno', 'ffmpeg'].filter(name => diagnostics[`${name}_status`] !== 'ok');
  const fallbackFailures = ['ytdlp', 'deno', 'ffmpeg'].filter(name => diagnostics[`fallback_${name}_status`] !== 'ok');
  if (failures.length || fallbackFailures.length) {
    const details = [
      ...failures.map(name => `runtime ${name}: ${diagnostics[`${name}_status`]} (${diagnostics.errors[name] || 'unknown error'})`),
      ...fallbackFailures.map(name => `fallback ${name}: ${diagnostics[`fallback_${name}_status`]} (${diagnostics.fallback_errors[name] || 'unknown error'})`)
    ];
    if (contentOpsHeadless) logToFile(`System Check Failed: ${details.join('; ')}`);
    else dialog.showErrorBox('System Check Failed', details.join('\n'));
    return false;
  }
  return true;
}

function logUpdateResult(result) {
  logToFile('yt-dlp update: ' + JSON.stringify(updateLogRecord(result)));
}

function notifyEngineStatus() {
  if (mainWindow && !mainWindow.isDestroyed() && latestDiagnostics) {
    mainWindow.webContents.send('engine-status-updated', latestDiagnostics);
  }
}

function notifyAuthState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth-state-updated', state);
  }
}

function performSafeUpdate(trigger) {
  if (!updateInFlight) {
    updateInFlight = safeUpdateYtDlp(binaryPaths, { env: spawnEnv, trigger })
      .finally(() => { updateInFlight = null; });
  }
  return updateInFlight;
}

function recoveryLogger(record) {
  logToFile('Auto-recovery: ' + JSON.stringify(record));
}

function ensureBinaryExists(filePath) {
  if (!fs.existsSync(filePath)) {
    const message = `Critical file missing: ${path.basename(filePath)} Path: ${filePath}`;
    if (contentOpsHeadless) logToFile(message);
    else dialog.showErrorBox('Binary Not Found', message);
    return false;
  }
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1020, height: 760, minWidth: 950, minHeight: 650,
    frame: false, backgroundColor: '#202124', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => { if (!contentOpsHeadless) mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Tray Integration
function createTray() {
  const iconPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'mascot.png')
    : path.join(__dirname, 'resources', 'mascot.png');

  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { if(mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit YTDOWNLOAD', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setToolTip('YTDOWNLOAD v1.0.0');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if(mainWindow) mainWindow.show(); });
}

// IPC Handlers
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('minimize-to-tray', () => {
  mainWindow.hide();
  if (process.platform === 'win32') {
    tray.displayBalloon({ title: 'YTDOWNLOAD', content: 'App is still running in the system tray.' });
  }
});
ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow.close());
ipcMain.on('app-quit', () => { app.isQuiting = true; app.quit(); });

ipcMain.handle('open-home-dir', () => shell.openPath(app.getPath('userData')));
ipcMain.handle('open-external', (event, url) => shell.openExternal(url));

ipcMain.handle('update-engine', async () => {
  logToFile('Checking for engine updates...');
  const result = await performSafeUpdate('MANUAL');
  logUpdateResult(result);
  latestDiagnostics = await runEngineDiagnostics(binaryPaths, spawnEnv);
  notifyEngineStatus();
  return result;
});

ipcMain.handle('repair-engine', async () => {
  const result = await repairYtDlp(binaryPaths, { env: spawnEnv });
  logUpdateResult(result);
  latestDiagnostics = result.diagnostics;
  notifyEngineStatus();
  return result;
});

ipcMain.handle('get-engine-status', () => latestDiagnostics);
ipcMain.handle('get-auth-state', () => youtubeAuth?.state || 'UNKNOWN');
ipcMain.handle('login-youtube', () => youtubeAuth.login());
ipcMain.handle('logout-youtube', () => youtubeAuth.logout());
ipcMain.handle('open-youtube-transcript-session', () => transcriptBrowser.openSession());
ipcMain.handle('get-transcript-extension-health', () => transcriptExtension?.health || { status: 'EXTENSION_NOT_FOUND' });

ipcMain.on('cancel-all-downloads', () => {
  downloadManager?.cancelAll('user');
});

async function fetchMetadataWithCookies(url, cookiesPath, signal) {
  if (!ensureBinaryExists(ytdlpPath)) throw new Error('yt-dlp.exe missing');
    const args = [...buildYtDlpBaseArgs({ paths: binaryPaths, cookiesPath }), '--no-playlist', '--skip-download', '--dump-single-json', url];
    const result = await executeWithRecovery({
      operation: () => runProcess(ytdlpPath, args, { env: spawnEnv, timeoutMs: 0, signal }),
      recover: performSafeUpdate,
      trigger: 'METADATA_FAILURE',
      logger: recoveryLogger
    });
    if (!result.ok) {
      const errorMsg = result.stderr || result.error || 'Unknown error occurred';
      logToFile(`Metadata fetch failed: ${classifyYtDlpFailure(errorMsg).reason}`);
      const error = new Error(isAuthRequired(errorMsg) ? 'YouTube sign-in required' : errorMsg);
      error.authRequired = isAuthRequired(errorMsg);
      error.engineFailure = Boolean(result.recovery && result.recovery.update_status !== 'NOT_CHECKED');
      throw error;
    }
    try { return JSON.parse(result.stdout); } catch(e) {
      logToFile('Metadata parse failed: ' + e.message);
      throw new Error('Metadata parse error');
    }
}

async function fetchMetadata(url) {
  return youtubeAuth.withTemporaryCookies(cookiesPath => fetchMetadataWithCookies(url, cookiesPath));
}

async function downloadVisualProxy(url, workDir, signal) {
  return youtubeAuth.withTemporaryCookies(async cookiesPath => {
    const outputTemplate = path.join(workDir, 'proxy.%(ext)s');
    const args = [
      ...buildYtDlpBaseArgs({ paths: binaryPaths, cookiesPath }), '--no-playlist', '--no-part',
      '--extractor-args', 'youtube:player_client=web',
      '-f', '18/best[height<=360]/bestvideo[height<=360]/worst', '--output', outputTemplate, url
    ];
    const result = await runProcess(ytdlpPath, args, { env: spawnEnv, timeoutMs: 0, signal });
    if (!result.ok) {
      const message = result.error || result.stderr || 'Visual proxy download failed.';
      const code = result.cancelled ? 'ANALYSIS_CANCELLED' : /HTTP Error 403/i.test(message) ? 'VISUAL_PROXY_HTTP_403' : 'VISUAL_PROXY_DOWNLOAD_FAILED';
      throw Object.assign(new Error(message), { code, cancelled: result.cancelled, stage: 'VISUAL_PROXY' });
    }
    const proxy = fs.readdirSync(workDir).map(name => path.join(workDir, name)).find(file => /^proxy\./.test(path.basename(file)) && !file.endsWith('.part'));
    if (!proxy) throw new Error('Visual proxy download produced no media file.');
    return proxy;
  });
}

async function runFullAnalysis(url, { signal, jobId = null, analysisStartedAtMs = null, onStage = () => {}, onTranscriptProvider = () => {}, checkpointDir = null, analysisVersion = null, stopAfterText = false, unloadVisualAfter = true } = {}) {
  const timing = { started: analysisStartedAtMs || Date.now(), proxyStarted: null, proxyDone: null, visualStarted: null };
  const trackedStage = stage => {
    if (stage === 'visual_proxy' && !timing.proxyStarted) timing.proxyStarted = Date.now();
    if (stage === 'visual_sampling' && !timing.visualStarted) timing.visualStarted = Date.now();
    onStage(stage);
  };
  const readCheckpoint = name => {
    if (!checkpointDir) return null;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(checkpointDir, `${name}.json`), 'utf8'));
      return value.analysisVersion === analysisVersion ? value.data : null;
    } catch (_) { return null; }
  };
  const writeCheckpoint = (name, data) => {
    if (!checkpointDir) return;
    fs.mkdirSync(checkpointDir, { recursive: true });
    const target = path.join(checkpointDir, `${name}.json`); const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ analysisVersion, data }), 'utf8'); fs.renameSync(temp, target);
  };
  try {
    let ingestion = readCheckpoint('transcript');
    if (ingestion) { trackedStage('metadata'); trackedStage('transcript'); }
    else {
      ingestion = await youtubeAuth.withTemporaryCookies(cookiesPath => youtubeIngestion.ingest(url,
        { cookiesPath, jobId, onStage: trackedStage, onProviderAttempt: onTranscriptProvider, signal }));
      writeCheckpoint('transcript', ingestion);
    }
    let textResult = readCheckpoint('text');
    if (textResult) trackedStage('policy');
    else {
      logToFile(`Policy pipeline: ${JSON.stringify({ event: 'TEXT_POLICY_START', jobId, videoId: ingestion.metadata.videoId })}`);
      const health = await policyJudge.healthCheck({ signal });
      if (!health.ok) throw new PolicyJudgeError(health.code, health.message);
      textResult = await gpuScheduler.withGpu('qwen', () => policyJudge.analyzeIngestion(ingestion, { onStage: trackedStage, signal, skipHealthCheck: true, deferCompletion: true }));
      logToFile(`Policy pipeline: ${JSON.stringify({ event: 'TEXT_POLICY_SUCCESS', jobId, videoId: ingestion.metadata.videoId, duration: textResult.metrics.totalAnalysisMs })}`);
      writeCheckpoint('text', textResult);
    }
    if (stopAfterText) return { deferred: true, metadata: ingestion.metadata };
    let data; let finalizeStarted = null;
    let visualFailureStage = null;
    try {
      let visualResult = readCheckpoint('visual');
      if (visualResult) trackedStage('visual_sampling');
      else {
        trackedStage('visual_proxy');
        logToFile(`Visual pipeline: ${JSON.stringify({ event: 'VISUAL_PROXY_START', jobId, videoId: ingestion.metadata.videoId })}`);
        visualFailureStage = 'VISUAL_PROXY';
        visualResult = await visualMedia.withProxy(ingestion, { signal }, async (proxyPath, workDir) => {
          timing.proxyDone = Date.now();
          logToFile(`Visual pipeline: ${JSON.stringify({ event: 'VISUAL_PROXY_SUCCESS', jobId, videoId: ingestion.metadata.videoId, duration: timing.proxyDone - timing.proxyStarted })}`);
          visualFailureStage = 'VISUAL_ANALYSIS';
          logToFile(`Visual pipeline: ${JSON.stringify({ event: 'VISUAL_ANALYSIS_START', jobId, videoId: ingestion.metadata.videoId })}`);
          const result = await gpuScheduler.withGpu('gemma', () => visualRisk.analyze(proxyPath, workDir, ingestion, textResult.segmentJudgments, { onStage: trackedStage, signal, unloadAfter: unloadVisualAfter }));
          logToFile(`Visual pipeline: ${JSON.stringify({ event: 'VISUAL_ANALYSIS_SUCCESS', jobId, videoId: ingestion.metadata.videoId, duration: result.metrics.visualAnalysisMs })}`);
          return result;
        });
        visualResult.metrics.visualProxyMs = timing.proxyDone - timing.proxyStarted;
        writeCheckpoint('visual', visualResult);
      }
      finalizeStarted = Date.now();
      data = policyJudge.applyVisualAnalysis(textResult, visualResult, visualRisk.config, { onStage: trackedStage });
    } catch (visualError) {
      if (signal?.aborted || visualError.code === 'ANALYSIS_CANCELLED' || visualError.cancelled) throw visualError;
      const failureStage = visualError.stage || visualFailureStage || 'VISUAL_ANALYSIS';
      const errorCode = visualError.code || (failureStage === 'VISUAL_PROXY' ? 'VISUAL_PROXY_DOWNLOAD_FAILED' : 'VISUAL_ANALYSIS_FAILED');
      logToFile(`Visual pipeline: ${JSON.stringify({ event: `${failureStage}_FAILURE`, jobId, videoId: ingestion.metadata.videoId,
        stage: failureStage, errorCode, technicalMessage: String(visualError.message || errorCode).slice(0, 500) })}`);
      finalizeStarted = Date.now();
      data = policyJudge.applyVisualAnalysis(textResult, {
        visualStatus: 'UNAVAILABLE', visualErrorCode: errorCode, visualError: String(visualError.message || errorCode).slice(0, 500),
        visualFailureStage: failureStage, ocrStatus: 'UNAVAILABLE',
        ocrErrorCode: failureStage === 'VISUAL_PROXY' ? 'VISUAL_PIPELINE_NOT_REACHED' : 'VISUAL_PIPELINE_INTERRUPTED',
        ocrError: failureStage === 'VISUAL_PROXY' ? 'Visual proxy failed before OCR could start.' : 'Visual analysis ended before OCR status could be established.',
        framesBySegment: ingestion.transcriptSegments.map(() => []),
        metrics: {
          framesSampled: 0, framesDeduplicated: 0, framesCheapScanned: 0, framesEscalated: 0,
          ocrCalls: 0, ocrMs: 0, ocrFrames: 0, ocrUsefulFrames: 0, ocrDuplicateSkips: 0,
          vlmCalls: 0, gemmaMs: 0, gemmaCalls: 0, gemmaCallsSkippedByAnchorReuse: 0,
          visualCacheHits: 0, visualAnalysisMs: 0, newsVisualMs: 0, sceneTypeCounts: {},
          anchorSegments: 0, brollSegments: 0, documentSegments: 0, textHeavySegments: 0
        }
      }, visualRisk.config, { onStage: trackedStage });
    }
    const visualMetrics = data.metrics.visual || {};
    const transcriptMetrics = textResult.transcriptMetrics || {};
    data.metrics = { ...data.metrics,
      downloadMs: visualMetrics.visualProxyMs || 0,
      textPolicyMs: textResult.metrics.totalAnalysisMs || 0,
      qwenCalls: textResult.metrics.segmentsSentToQwen || 0, qwenCacheHits: textResult.metrics.cacheHits || 0,
      visualProxyMs: visualMetrics.visualProxyMs || (timing.proxyStarted ? Math.max(0, (timing.proxyDone || Date.now()) - timing.proxyStarted) : 0),
      visualAnalysisMs: visualMetrics.visualAnalysisMs || 0,
      ocrMs: visualMetrics.ocrMs || 0, ocrCalls: visualMetrics.ocrCalls || 0,
      gemmaMs: visualMetrics.gemmaMs || 0, gemmaCalls: visualMetrics.gemmaCalls || 0,
      visualCacheHits: visualMetrics.visualCacheHits || 0, ...transcriptMetrics,
      transcriptProviderUsed: textResult.transcriptProvider?.provider || 'DIRECT_CAPTION', totalMs: elapsedMs(timing.started) };
    data.metrics.finalizeMs = Date.now() - finalizeStarted;
    data.metrics.totalMs = elapsedMs(timing.started);
    logToFile(`Policy pipeline: ${JSON.stringify({ event: 'FINALIZE_SUCCESS', jobId, videoId: ingestion.metadata.videoId, duration: data.metrics.finalizeMs })}`);
    logToFile(`Policy judge metrics: ${JSON.stringify(data.metrics)}`);
    return data;
  } catch (error) { throw error instanceof PolicyJudgeError ? error : classifyIngestionError(error); }
}

ipcMain.handle('analyze-youtube-video', async (event, { url, requestId }) => {
  const senderId = event.sender.id;
  activeAnalysisControllers.get(senderId)?.abort();
  const controller = new AbortController();
  activeAnalysisControllers.set(senderId, controller);
  latestAnalysisRequests.set(senderId, requestId);
  const onStage = stage => {
    if (latestAnalysisRequests.get(senderId) === requestId && !event.sender.isDestroyed()) event.sender.send('analysis-stage', { requestId, stage });
  };
  try { return { ok: true, data: await runFullAnalysis(url, { signal: controller.signal, onStage }) }; }
  catch (error) {
    logToFile(`Video analysis failed: ${error.code || 'ANALYSIS_FAILED'}`);
    return { ok: false, error: { code: error.code || 'ANALYSIS_FAILED', message: error.message } };
  } finally {
    if (latestAnalysisRequests.get(senderId) === requestId) latestAnalysisRequests.delete(senderId);
    if (activeAnalysisControllers.get(senderId) === controller) activeAnalysisControllers.delete(senderId);
  }
});

ipcMain.handle('enqueue-analysis-jobs', (_event, text, options) => analysisQueue.enqueueText(text, options));
ipcMain.handle('get-analysis-jobs', (_event, filters) => analysisQueue ? { jobs: analysisQueue.list(filters), summary: analysisQueue.summary(), paused: analysisQueue.store.state.paused, database: analysisQueue.store.health } : { jobs: [], summary: {}, paused: false });
ipcMain.handle('pause-analysis-queue', () => { analysisQueue.pause(); return true; });
ipcMain.handle('resume-analysis-queue', () => { analysisQueue.resume(); return true; });
ipcMain.handle('cancel-analysis-job', (_event, id) => analysisQueue.cancel(id));
ipcMain.handle('cancel-all-analysis-jobs', () => analysisQueue.cancelAll());
ipcMain.handle('retry-analysis-job', (_event, id) => analysisQueue.retry(id));
ipcMain.handle('reanalyze-job', (_event, id) => analysisQueue.reanalyze(id));
ipcMain.handle('open-analysis-report', async (_event, id) => {
  const job = analysisQueue.store.get(id); return job?.htmlReportPath ? shell.openPath(job.htmlReportPath) : 'Report unavailable.';
});
ipcMain.handle('get-analysis-result', (_event, id) => {
  const job = analysisQueue.store.get(id);
  if (!job?.resultPath || !fs.existsSync(job.resultPath)) return null;
  const report = JSON.parse(fs.readFileSync(job.resultPath, 'utf8'));
  return { title: report.metadata.title, durationSeconds: report.metadata.durationSeconds,
    overallDecision: report.videoResult === 'INCOMPLETE' ? 'INCOMPLETE' : report.overallDecision, segments: report.segmentJudgments,
    recommendedClips: report.safeWindows.map((item, index) => ({ id: `clip-${index + 1}`, startSeconds: item.start,
      endSeconds: item.end, startLabel: String(item.start), endLabel: String(item.end), decision: 'KEEP', transcript: '' })) };
});
ipcMain.handle('export-analysis-batch', (_event, format) => {
  if (!['csv', 'json'].includes(format)) throw new Error('Unsupported export format.');
  const output = path.join(exportsPath, `analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`);
  return analysisQueue.reports.export(analysisQueue.store.jobs(), format, output);
});
ipcMain.handle('clear-policy-cache', () => { policyJudge.cache.entries.clear(); fs.rmSync(policyJudge.cache.filePath, { force: true }); return true; });
ipcMain.handle('clear-visual-cache', () => { visualRisk.cache.entries.clear(); fs.rmSync(visualRisk.cache.filePath, { force: true }); return true; });
ipcMain.handle('clear-analysis-reports', async () => {
  const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Cancel', 'Clear reports'], defaultId: 0, cancelId: 0,
    title: 'Clear reports?', message: 'Completed job history remains, but local JSON and HTML report files will be removed.' });
  if (answer.response !== 1) return false;
  fs.rmSync(reportsPath, { recursive: true, force: true }); fs.mkdirSync(reportsPath, { recursive: true }); return true;
});
function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const target = path.join(root, entry.name); return total + (entry.isDirectory() ? directorySize(target) : fs.statSync(target).size);
  }, 0);
}
ipcMain.handle('get-analysis-storage', () => ({ reportsBytes: directorySize(reportsPath), cacheBytes: [policyJudge.cache.filePath, visualRisk.cache.filePath].reduce((sum, file) => sum + (file && fs.existsSync(file) ? fs.statSync(file).size : 0), 0),
  temporaryMediaBytes: directorySize(visualMedia.tempRoot), keepReportsDays: getSettings().keepReportsDays }));
ipcMain.handle('set-report-retention', (_event, days) => saveSettings({ keepReportsDays: Math.max(0, Math.min(3650, Number(days) || 0)) }));

ipcMain.handle('get-playlist-data', async (event, url) => {
  if (!ensureBinaryExists(ytdlpPath)) throw new Error('yt-dlp.exe missing');
  return youtubeAuth.withTemporaryCookies(async cookiesPath => {
    const args = [...buildYtDlpBaseArgs({ paths: binaryPaths, cookiesPath }), '--flat-playlist', '--dump-json'];
    if (url.includes('/shorts')) args.push('--match-filter', 'duration < 65');
    args.push(url);

    const result = await executeWithRecovery({
      operation: () => runProcess(ytdlpPath, args, { env: spawnEnv, timeoutMs: 0 }),
      recover: performSafeUpdate,
      trigger: 'PLAYLIST_FAILURE',
      logger: recoveryLogger
    });
    if (!result.ok) {
      const errorMsg = result.stderr || result.error || 'Unknown error occurred';
      logToFile(`Playlist fetch failed: ${classifyYtDlpFailure(errorMsg).reason}`);
      throw new Error(isAuthRequired(errorMsg) ? 'YouTube sign-in required' : errorMsg);
    }
    try {
      return result.stdout.trim().split('\n').map(line => {
        const data = JSON.parse(line);
        return {
          id: data.id,
          title: data.title,
          url: data.url || `https://www.youtube.com/watch?v=${data.id}`,
          duration: data.duration,
          thumbnail: data.thumbnails ? data.thumbnails[0].url : (data.thumbnail || ''),
          uploader: data.uploader || 'YouTube'
        };
      });
    } catch(e) {
      logToFile('Parse error in get-playlist-data: ' + e.message);
      throw new Error('Playlist metadata parse error');
    }
  });
});

function runManagedDownloadProcess(job, args, context) {
  return new Promise((resolve) => {
    const subprocess = spawn(ytdlpPath, args, { env: spawnEnv, windowsHide: true });
    context.registerProcess(subprocess);
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, ...result });
    };

    const handleLine = line => {
      const progress = parseYtDlpProgress(line);
      if (progress) context.update(progress);
      if (/^\[(?:Merger|VideoRemuxer|Fixup)/.test(line)) context.setState(JOB_STATES.MERGING);
    };
    const consume = (chunk, isStderr) => {
      const text = chunk.toString();
      if (isStderr) {
        stderr += text;
        stderrBuffer += text;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop();
        lines.forEach(handleLine);
      } else {
        stdout += text;
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop();
        lines.forEach(handleLine);
      }
    };
    subprocess.stdout.on('data', data => consume(data, false));
    subprocess.stderr.on('data', data => consume(data, true));
    subprocess.on('error', error => finish({ ok: false, code: null, error: error.message }));
    subprocess.on('close', code => {
      if (stdoutBuffer) handleLine(stdoutBuffer);
      if (stderrBuffer) handleLine(stderrBuffer);
      finish({ ok: code === 0, code, error: code === 0 ? null : `Process exited with code ${code}` });
    });
  });
}

async function executeDownloadJob(job, context) {
  if (!ensureBinaryExists(ytdlpPath)) {
    return { ok: false, errorMessage: 'yt-dlp.exe missing', errorCategory: 'PERMANENT' };
  }

  try {
    const metadata = await fetchMetadata(job.url);
    context.update({ title: metadata.title || job.title, thumbnail: metadata.thumbnail || job.thumbnail });
  } catch (error) {
    if (error.authRequired || isAuthRequired(error.message)) {
      return { ok: false, errorMessage: 'YouTube sign-in required', errorCategory: 'AUTH' };
    }
    const failure = classifyYtDlpFailure(error.message);
    return { ok: false, errorMessage: error.message, engineFailure: error.engineFailure || failure.recoverable };
  }
  if (context.isCancelled()) return { ok: false, cancelled: true };

  let finalSavePath = job.output_directory;
  if (job.subdirectory) {
    const sanitizedSubDir = job.subdirectory.replace(/[^\w\s-]/g, '_').replace(/\.{2,}/g, '_');
    finalSavePath = path.join(finalSavePath, sanitizedSubDir);
  }
  try {
    fs.mkdirSync(finalSavePath, { recursive: true });
    fs.accessSync(finalSavePath, fs.constants.W_OK);
  } catch (error) {
    return { ok: false, errorMessage: `Không thể ghi vào thư mục: ${finalSavePath}`, errorCategory: 'PERMANENT' };
  }

  context.setState(JOB_STATES.DOWNLOADING);
  const result = await youtubeAuth.withTemporaryCookies(async cookiesPath => {
    const args = [
      ...buildYtDlpBaseArgs({ paths: binaryPaths, cookiesPath, ffmpeg: true }),
      '--output', path.join(finalSavePath, '%(title)s.%(ext)s'),
      '--no-part',
      '-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '--newline', '--progress',
      '--progress-template', `download:${PROGRESS_PREFIX}%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`,
      '--no-simulate', '--print', `after_move:${FINAL_PATH_PREFIX}%(filepath)s`,
      job.url
    ];
    return executeWithRecovery({
      operation: () => runManagedDownloadProcess(job, args, context),
      recover: performSafeUpdate,
      trigger: 'DOWNLOAD_FAILURE',
      logger: recoveryLogger
    });
  });
  if (!result.ok) {
    if (context.isCancelled()) return { ok: false, cancelled: true };
    const fullMessage = result.stderr || result.error || `Process exited with code ${result.code}`;
    if (isAuthRequired(fullMessage)) {
      return { ok: false, errorMessage: 'YouTube sign-in required', errorCategory: 'AUTH' };
    }
    const message = result.stderr?.trim().split(/\r?\n/).pop() || result.error || `Process exited with code ${result.code}`;
    const engineRecoveryUsed = Boolean(result.recovery && result.recovery.update_status !== 'NOT_CHECKED');
    return { ok: false, errorMessage: message, engineFailure: engineRecoveryUsed || classifyYtDlpFailure(message).recoverable };
  }
  const outputPath = result.stdout.split(/\r?\n/).map(extractFinalPath).filter(Boolean).pop();
  return { ok: true, outputPath };
}

ipcMain.handle('enqueue-download-jobs', (event, jobs) => downloadManager.enqueueMany(jobs));
ipcMain.handle('get-download-jobs', () => downloadManager?.list() || []);
ipcMain.handle('cancel-download-job', (event, id) => downloadManager.cancel(id, 'user'));
ipcMain.handle('retry-download-job', (event, id) => downloadManager.retry(id));
ipcMain.handle('clear-download-jobs', (event, states) => downloadManager.clear(states));

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { 
    properties: ['openDirectory', 'createDirectory'], 
    defaultPath: currentSavePath || app.getPath('downloads') 
  });
  
  if (!result.canceled && result.filePaths[0]) {
    const newPath = result.filePaths[0];
    currentSavePath = newPath;
    saveSettings({ savePath: newPath });
    return newPath;
  }
  return null;
});
ipcMain.handle('open-download-folder', async () => {
  const folderPath = currentSavePath || app.getPath('downloads');
  try {
    fs.mkdirSync(folderPath, { recursive: true });
    const error = await shell.openPath(folderPath);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('get-default-path', () => currentSavePath || app.getPath('downloads'));

app.whenReady().then(async () => {
  if (fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8');
  const bootstrap = await bootstrapRuntime(binaryPaths, { run: runProcess, env: spawnEnv });
  logToFile('Runtime bootstrap: ' + JSON.stringify(bootstrap));
  youtubeAuth = new YouTubeAuthSession({
    sessionFromPartition: partition => session.fromPartition(partition, { cache: true }),
    createBrowserWindow: options => new BrowserWindow({ ...options, parent: mainWindow || undefined }),
    userDataPath: app.getPath('userData'),
    onStateChange: notifyAuthState,
    logger: record => logToFile(`Auth: ${redactSensitive(JSON.stringify(record))}`)
  });
  await youtubeAuth.initialize();
  transcriptExtension = new ExtensionManager({
    userDataPath: app.getPath('userData'), sessionFromPartition: (partition, options) => session.fromPartition(partition, options),
    logger: record => logToFile(`Transcript extension: ${JSON.stringify(record)}`)
  });
  transcriptBrowser = new TranscriptBrowserManager({
    extensionManager: transcriptExtension, createBrowserWindow: options => new BrowserWindow(options),
    logger: record => logToFile(`Transcript provider: ${JSON.stringify(record)}`)
  });
  const transcriptProviders = new TranscriptProviderChain({
    fetchDirect: (track, signal) => fetchSubtitleWithRetry(track, globalThis.fetch, signal),
    extensionProvider: transcriptBrowser, circuitBreaker: new TimedTextCircuitBreaker(),
    logger: record => logToFile(`Transcript provider: ${JSON.stringify(record)}`)
  });
  youtubeIngestion = new YouTubeIngestionService({ getRawMetadata: fetchMetadataWithCookies, providerChain: transcriptProviders });
  const judgeConfig = loadPolicyJudgeConfig();
  policyJudge = new PolicyJudgeService({
    repository: loadPolicySet(),
    config: judgeConfig,
    provider: new LocalQwenProvider(judgeConfig),
    cache: new ModelFindingCache({ filePath: path.join(app.getPath('userData'), 'policy-judge-cache.json'), maxEntries: judgeConfig.cacheMaxEntries })
  });
  const visualConfig = loadVisualRiskConfig();
  visualMedia = new VisualMediaService({ tempRoot: path.join(app.getPath('userData'), 'visual-temp'), downloadProxy: downloadVisualProxy });
  visualMedia.cleanupStale();
  visualRisk = new VisualRiskService({
    config: visualConfig, textModel: judgeConfig.model,
    sampler: new VisualSamplingService({ ffmpegPath: binaryPaths.ffmpegPath, runProcess, config: visualConfig }),
    cache: new VisualFindingCache({ filePath: path.join(app.getPath('userData'), 'visual-findings-cache.json'), maxEntries: visualConfig.cacheMaxEntries })
  });
  const policyRepository = policyJudge.repository;
  const analysisVersions = {
    policySet: policyRepository.version, qwenModel: judgeConfig.model, qwenPrompt: POLICY_JUDGE_PROMPT_VERSION,
    visualThresholds: visualConfig.thresholdVersion, gemmaModel: visualConfig.model,
    gemmaVersion: visualConfig.modelVersion, ocr: 'rapidocr-3.9.2-onnxruntime-1.28.0',
    newsRouting: visualConfig.detectorVersion
  };
  const stageMap = {
    metadata: JOB_STAGE.METADATA, transcript: JOB_STAGE.TRANSCRIPT, policy: JOB_STAGE.TEXT_POLICY,
    visual_proxy: JOB_STAGE.VISUAL_PROXY, visual_sampling: JOB_STAGE.VISUAL_ANALYSIS,
    safe_windows: JOB_STAGE.FINALIZING, complete: JOB_STAGE.FINALIZING
  };
  analysisQueue = new AnalysisQueue({
    store: new AnalysisJobStore({ filePath: analysisJobsPath }),
    reports: new ReportManager({ reportsDir: reportsPath }), versions: analysisVersions,
    executor: (job, context) => {
      const hasLaterVisual = analysisQueue.store.jobs().some(item => item.jobId !== job.jobId && ['QUEUED', 'PAUSED'].includes(item.status));
      return runFullAnalysis(job.sourceUrl, {
        jobId: job.jobId,
        analysisStartedAtMs: new Date(job.startedAt).getTime(),
        signal: context.signal,
        checkpointDir: path.join(app.getPath('userData'), 'analysis-checkpoints', job.jobId, job.revisionId),
        analysisVersion: job.analysisVersion,
        stopAfterText: job.phase !== 'VISUAL', unloadVisualAfter: analysisQueue.store.state.paused || !hasLaterVisual,
        onTranscriptProvider: provider => context.onStage(JOB_STAGE.TRANSCRIPT, { transcriptProviderAttempt: provider }),
        onStage: stage => { if (stageMap[stage]) context.onStage(stageMap[stage]); }
      });
    }
  });
  analysisQueue.on('changed', snapshot => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('analysis-jobs-updated', snapshot);
  });
  analysisQueue.on('job-event', record => {
    jobsLogger.write(record);
    if (analysisQueue.store.state.paused && ['completed', 'failed', 'cancelled'].includes(record.event)) {
      void visualRisk.provider.unload(visualConfig.model).catch(() => {});
    }
  });
  const keepReportsDays = getSettings().keepReportsDays;
  if (keepReportsDays > 0 && fs.existsSync(reportsPath)) {
    const cutoff = Date.now() - keepReportsDays * 86400000;
    for (const entry of fs.readdirSync(reportsPath, { withFileTypes: true })) {
      const target = path.join(reportsPath, entry.name);
      if (entry.isFile() && fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { force: true });
    }
  }
  analysisQueue.start();
  if (fs.existsSync(legacyCookiesPath)) {
    logToFile('Legacy cookies.txt retained but disabled; dedicated YouTube session is primary.');
  }
  if (await validateBinaries()) {
    downloadManager = new DownloadManager({
      jobsPath,
      executor: executeDownloadJob,
      maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
      logger: record => logToFile(`Download job: ${JSON.stringify(record)}`)
    });
    downloadManager.load();
    contentOpsBridge = new ContentOpsBridge({
      manager: downloadManager,
      recordsPath: contentOpsRecordsPath,
      port: contentOpsBridgePort
    });
    contentOpsBridge.restore();
    downloadManager.on('jobs', jobs => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-jobs-updated', jobs);
      }
    });
    if (!contentOpsHeadless) {
      createTray();
      createWindow();
    }
    downloadManager.start();
    void contentOpsBridge.start().then(() => {
      logToFile(`Content Ops bridge listening on 127.0.0.1:${contentOpsBridgePort}`);
    }).catch(error => {
      logToFile(`Content Ops bridge failed: ${error.message}`);
    });
    void periodicUpdateCheck({
      settings: getSettings(),
      saveSettings,
      paths: binaryPaths,
      update: (paths, { trigger }) => performSafeUpdate(trigger)
    }).then(async result => {
      logUpdateResult(result);
      if (result.update_status !== 'NOT_CHECKED') {
        latestDiagnostics = await runEngineDiagnostics(binaryPaths, spawnEnv);
        notifyEngineStatus();
      }
    }).catch(() => {
      logToFile('Periodic yt-dlp update: UPDATE_FAILED_USABLE');
    });
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (quitCleanupStarted) return;
  event.preventDefault();
  quitCleanupStarted = true;
  for (const controller of activeAnalysisControllers.values()) controller.abort();
  analysisQueue?.active?.controller.abort();
  analysisQueue?.stop();
  transcriptBrowser?.destroy();
  Promise.allSettled([
    session.fromPartition('').clearCache(),
    youtubeAuth?.session.clearCache() || Promise.resolve(),
    contentOpsBridge?.stop() || Promise.resolve()
  ]).finally(() => {
    clearEphemeralState(app.getPath('userData'));
    app.quit();
  });
});
app.on('will-quit', () => {
  clearEphemeralState(app.getPath('userData'));
});
