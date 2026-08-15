const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { AnalysisJobStore, AnalysisQueue, GpuScheduler, JOB_STAGE, ReportManager } = require('../analysis-jobs');
const { buildYtDlpBaseArgs, resolveBinaryPaths, runProcess } = require('../engine-runtime');
const { ModelFindingCache, PolicyJudgeService, loadPolicyJudgeConfig } = require('../services/policyJudge');
const { LocalQwenProvider } = require('../services/policyJudge/provider');
const { loadPolicySet } = require('../services/policyKnowledge');
const { VisualFindingCache, VisualRiskService, VisualSamplingService, loadVisualRiskConfig } = require('../services/visualRisk');
const { OllamaVisualProvider } = require('../services/visualRisk/provider');
const { YouTubeIngestionService } = require('../services/youtube');

const root = path.join(__dirname, '..');
const manifest = require('../test/news-visual/manifest.json');
const proxyRoot = process.env.NEWS_VISUAL_PROXY_DIR || path.join(os.tmpdir(), 'tpc-phase5-4-news');
const outputPath = process.env.PHASE6_BATCH_OUTPUT || path.join(root, 'docs', 'evidence', 'phase6-batch-results.json');
const resolvedPaths = resolveBinaryPaths({ isPackaged: false, appDir: root, userDataPath: path.join(os.tmpdir(), 'phase6-runtime') });
const binaryPaths = { ...resolvedPaths, ytdlpPath: resolvedPaths.fallbackYtdlpPath, denoPath: resolvedPaths.fallbackDenoPath, ffmpegPath: resolvedPaths.fallbackFfmpegPath };
const judgeConfig = loadPolicyJudgeConfig(); const visualConfig = loadVisualRiskConfig();
const versions = { policySet: loadPolicySet().version, qwenModel: judgeConfig.model, qwenPrompt: 'policy-judge-v2',
  visualThresholds: visualConfig.thresholdVersion, gemmaModel: visualConfig.model, gemmaVersion: visualConfig.modelVersion,
  ocr: 'rapidocr-3.9.2-onnxruntime-1.28.0', newsRouting: visualConfig.detectorVersion };

function percentile(values, fraction) {
  if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function probeVram() { return new Promise(resolve => execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], (error, stdout) => resolve(error ? null : Number.parseInt(stdout, 10)))); }
async function metadata(url) {
  const args = [...buildYtDlpBaseArgs({ paths: binaryPaths }), '--no-playlist', '--skip-download', '--dump-single-json', url];
  const result = await runProcess(binaryPaths.ytdlpPath, args, { timeoutMs: 0 });
  if (!result.ok) throw Object.assign(new Error(result.stderr || result.error), { code: /429|5\d\d/.test(result.stderr) ? 'NETWORK_ERROR' : 'VIDEO_UNAVAILABLE' });
  return JSON.parse(result.stdout);
}
function summarize(jobs, wallMs, peakVramMiB) {
  const done = jobs.filter(job => job.status === 'COMPLETED'); const runtimes = done.map(job => job.metrics.totalMs);
  const sum = key => done.reduce((total, job) => total + Number(job.metrics[key] || 0), 0);
  return { videos: jobs.length, completed: done.length, failed: jobs.length - done.length, retries: jobs.reduce((sum, job) => sum + Math.max(0, job.attempts - 1), 0),
    wallMs, videosPerHour: Number((done.length / Math.max(wallMs / 3600000, 0.0001)).toFixed(2)),
    meanMs: done.length ? Math.round(runtimes.reduce((a, b) => a + b, 0) / done.length) : 0,
    medianMs: percentile(runtimes, 0.5), p95Ms: percentile(runtimes, 0.95), peakVramMiB,
    qwenCallsPerVideo: done.length ? Number((sum('qwenCalls') / done.length).toFixed(2)) : 0,
    gemmaCallsPerVideo: done.length ? Number((sum('gemmaCalls') / done.length).toFixed(2)) : 0,
    ocrCallsPerVideo: done.length ? Number((sum('ocrCalls') / done.length).toFixed(2)) : 0,
    qwenCacheHits: sum('qwenCacheHits'), visualCacheHits: sum('visualCacheHits'),
    totalMetrics: { transcriptMs: sum('transcriptMs'), textPolicyMs: sum('textPolicyMs'), visualProxyMs: sum('visualProxyMs'), ocrMs: sum('ocrMs'), gemmaMs: sum('gemmaMs') } };
}

function queueStressProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-queue-stress-')); const beforeHeap = process.memoryUsage().heapUsed;
  try {
    const store = new AnalysisJobStore({ filePath: path.join(dir, 'jobs.json') });
    const queue = new AnalysisQueue({ store, reports: new ReportManager({ reportsDir: path.join(dir, 'reports') }), versions, executor: async () => ({}) });
    const started = Date.now(); queue.enqueueText(Array.from({ length: 200 }, (_, index) => `https://youtu.be/st${String(index).padStart(6, '0')}`).join('\n'));
    const enqueueMs = Date.now() - started; const listStarted = Date.now(); const renderedRecords = queue.list().length; const listMs = Date.now() - listStarted;
    const reloadStarted = Date.now(); const reloaded = new AnalysisJobStore({ filePath: store.filePath }).jobs().length; const reloadMs = Date.now() - reloadStarted;
    return { records: store.jobs().length, renderedRecords, enqueueMs, listMs, reloadMs, reloaded,
      databaseBytes: fs.statSync(store.filePath).size, heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - beforeHeap) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function schedulingProbe() {
  async function generate(model, keepAlive) {
    const response = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'Reply OK.', stream: false, keep_alive: keepAlive, options: { num_predict: 1, temperature: 0 } }) });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`); return response.json();
  }
  async function unload(model) { await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) }); }
  async function run(grouped) {
    await unload(judgeConfig.model); await unload(visualConfig.model); const before = await probeVram(); let peak = before;
    const monitor = setInterval(async () => { const value = await probeVram(); if (Number.isFinite(value)) peak = Math.max(peak || 0, value); }, 250);
    const started = Date.now(); const responses = [];
    try {
      if (grouped) {
        responses.push(await generate(judgeConfig.model, '5m'), await generate(judgeConfig.model, '5m')); await unload(judgeConfig.model);
        responses.push(await generate(visualConfig.model, '5m'), await generate(visualConfig.model, '5m')); await unload(visualConfig.model);
      } else {
        for (let index = 0; index < 2; index++) { responses.push(await generate(judgeConfig.model, 0)); responses.push(await generate(visualConfig.model, 0)); }
      }
      return { wallMs: Date.now() - started, modelReloadMs: Math.round(responses.reduce((sum, value) => sum + Number(value.load_duration || 0), 0) / 1e6), peakVramMiB: peak,
        modelLoads: grouped ? 2 : 4, failureRecovery: grouped ? 'phase checkpoints required' : 'single job boundary' };
    } finally { clearInterval(monitor); await unload(judgeConfig.model); await unload(visualConfig.model); }
  }
  const perVideo = await run(false); const grouped = await run(true);
  return { perVideo, grouped, groupedImprovementPercent: Number(((1 - grouped.wallMs / perVideo.wallMs) * 100).toFixed(1)), selected: grouped.wallMs < perVideo.wallMs * 0.85 ? 'GROUPED_TEXT_THEN_VISUAL' : 'PER_VIDEO_COMPLETE' };
}

async function main() {
  const videos = manifest.videos.slice(0, Math.max(1, Number(process.env.PHASE6_BATCH_LIMIT) || manifest.videos.length));
  const missing = videos.filter(video => !fs.existsSync(path.join(proxyRoot, `${video.id}.mp4`)));
  if (missing.length) throw new Error(`Missing local news proxies: ${missing.map(item => item.id).join(', ')}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-batch-')); const startupStarted = Date.now();
  const qwenCache = new ModelFindingCache({ filePath: path.join(temp, 'qwen-cache.json'), maxEntries: judgeConfig.cacheMaxEntries });
  const visualCache = new VisualFindingCache({ filePath: path.join(temp, 'visual-cache.json'), maxEntries: visualConfig.cacheMaxEntries });
  const policy = new PolicyJudgeService({ repository: loadPolicySet(), config: judgeConfig, provider: new LocalQwenProvider(judgeConfig), cache: qwenCache });
  const visual = new VisualRiskService({ config: visualConfig, textModel: judgeConfig.model, provider: new OllamaVisualProvider(visualConfig),
    sampler: new VisualSamplingService({ ffmpegPath: binaryPaths.ffmpegPath, runProcess, config: visualConfig }), cache: visualCache });
  const ingestion = new YouTubeIngestionService({ getRawMetadata: metadata }); const gpu = new GpuScheduler();
  const store = new AnalysisJobStore({ filePath: path.join(temp, 'jobs.json') }); const reports = new ReportManager({ reportsDir: path.join(temp, 'reports') });
  const startupMs = Date.now() - startupStarted;
  const executor = async (job, context) => {
    const started = Date.now(); const stageAt = {}; const stage = value => { stageAt[value] ||= Date.now(); context.onStage(value); };
    const input = await ingestion.ingest(job.sourceUrl, { onStage: value => stage(value === 'metadata' ? JOB_STAGE.METADATA : JOB_STAGE.TRANSCRIPT), signal: context.signal });
    const ingestionDone = Date.now(); stage(JOB_STAGE.TEXT_POLICY);
    const health = await policy.healthCheck({ signal: context.signal }); if (!health.ok) throw Object.assign(new Error(health.message), { code: health.code });
    const text = await gpu.withGpu('qwen', () => policy.analyzeIngestion(input, { signal: context.signal, skipHealthCheck: true, deferCompletion: true }));
    stage(JOB_STAGE.VISUAL_PROXY); const proxyStarted = Date.now(); stage(JOB_STAGE.VISUAL_ANALYSIS);
    const work = fs.mkdtempSync(path.join(temp, 'frames-')); let visualResult;
    try { visualResult = await gpu.withGpu('gemma', () => visual.analyze(path.join(proxyRoot, `${job.videoId}.mp4`), work, input, text.segmentJudgments, { signal: context.signal })); }
    finally { fs.rmSync(work, { recursive: true, force: true }); }
    const merged = policy.applyVisualAnalysis(text, visualResult, visualConfig); const vm = visualResult.metrics;
    merged.metrics = { ...merged.metrics, transcriptMs: ingestionDone - started, textPolicyMs: text.metrics.totalAnalysisMs,
      qwenCalls: text.metrics.segmentsSentToQwen, qwenCacheHits: text.metrics.cacheHits, visualProxyMs: Date.now() - proxyStarted - vm.visualAnalysisMs,
      ocrMs: vm.ocrMs, ocrCalls: vm.ocrCalls, gemmaMs: vm.gemmaMs, gemmaCalls: vm.gemmaCalls,
      visualCacheHits: vm.visualCacheHits, totalMs: Date.now() - started };
    return merged;
  };
  const queue = new AnalysisQueue({ store, reports, versions, executor, delay: async () => {} });
  queue.enqueueText(videos.map(item => item.url).join('\n')); let peak = await probeVram();
  const monitor = setInterval(async () => { const value = await probeVram(); if (Number.isFinite(value)) peak = Math.max(peak || 0, value); }, 400);
  const coldStarted = Date.now(); queue.start(); await queue.waitForIdle(); const coldWallMs = Date.now() - coldStarted; clearInterval(monitor);
  const coldJobs = queue.store.jobs().map(job => JSON.parse(JSON.stringify(job))); const cold = summarize(coldJobs, coldWallMs, peak);
  for (const job of queue.store.jobs()) if (job.status === 'COMPLETED') queue.reanalyze(job.jobId);
  const warmStarted = Date.now(); await queue.waitForIdle(); const warm = summarize(queue.store.jobs(), Date.now() - warmStarted, await probeVram());
  const scheduling = process.env.PHASE6_SKIP_SCHEDULING === '1' ? { skipped: true } : await schedulingProbe();
  const projections = Object.fromEntries([50, 100, 200].map(count => [count, { coldMachineHours: Number((cold.meanMs * count / 3600000).toFixed(2)), warmMachineHours: Number((warm.meanMs * count / 3600000).toFixed(2)) }]));
  const evidence = { generatedAt: new Date().toISOString(), sourceMediaCommitted: false, corpusSize: videos.length,
    proxyDownloadExcluded: true, coldApplicationStartMs: startupMs, coldEmptyCache: cold, warmCaches: warm, scheduling, projections,
    queueStress: queueStressProbe(),
    bottlenecks: Object.entries(cold.totalMetrics).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([stage, ms]) => ({ stage, ms })),
    jobs: coldJobs.map(job => ({ videoId: job.videoId, status: job.status, attempts: job.attempts, overallResult: job.overallResult, lastError: job.lastError, metrics: job.metrics })) };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, cold, warm, scheduling, projections, bottlenecks: evidence.bottlenecks }, null, 2));
  fs.rmSync(temp, { recursive: true, force: true });
}

main().catch(error => { console.error(JSON.stringify({ code: error.code || 'PHASE6_BATCH_FAILED', message: error.message })); process.exitCode = 1; });
