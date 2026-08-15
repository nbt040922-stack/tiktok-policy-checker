const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AnalysisJobStore, AnalysisQueue, GpuScheduler, JOB_STAGE, JOB_STATUS, ReportManager,
  aggregateResult, analysisFingerprint, elapsedMs, parseBatchUrls
} = require('../analysis-jobs');
const { StructuredLogger } = require('../structured-log');
const { ModelFindingCache } = require('../services/policyJudge');
const { RapidOcrProvider, VisualFindingCache } = require('../services/visualRisk');

const versions = { policySet: 'policy-v1', qwenModel: 'qwen', qwenPrompt: 'p1', visualThresholds: 't1', gemmaModel: 'gemma', gemmaVersion: 'g1', ocr: 'ocr1', newsRouting: 'n1' };
const result = (id = 'abc123xyz') => ({ videoId: id, url: `https://www.youtube.com/watch?v=${id}`, title: `News ${id}`, channelName: 'Channel', durationSeconds: 180,
  overallDecision: 'KEEP', visualStatus: 'AVAILABLE', ocrStatus: 'AVAILABLE', analyzedAt: new Date().toISOString(),
  segmentJudgments: [{ id: 's1', decision: 'KEEP', startSeconds: 0, endSeconds: 180, startLabel: '00:00', endLabel: '03:00', policyIds: [], evidence: { onScreenText: [] }, visualFindings: [] }],
  recommendedClips: [{ startSeconds: 0, endSeconds: 180 }], metrics: { qwenCalls: 1, gemmaCalls: 1, ocrCalls: 1 } });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-jobs-'));
  const store = new AnalysisJobStore({ filePath: path.join(dir, 'jobs.json') });
  const reports = new ReportManager({ reportsDir: path.join(dir, 'reports') });
  return { dir, store, reports, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('batch parser canonicalizes YouTube URLs and removes duplicate IDs', () => {
  const parsed = parseBatchUrls('https://youtu.be/abc123xyz?t=2\nhttps://m.youtube.com/watch?v=abc123xyz&x=1\nyoutube.com/shorts/def456uvw\ninvalid');
  assert.deepEqual(parsed.urls.map(item => item.videoId), ['abc123xyz', 'def456uvw']);
  assert.equal(parsed.urls[0].sourceUrl, 'https://www.youtube.com/watch?v=abc123xyz');
  assert.deepEqual(parsed.invalid, ['invalid']);
});

test('persistent store recovers interrupted jobs and quarantines corrupt data', () => {
  const f = fixture();
  try {
    f.store.state.jobs.push({ jobId: 'one', status: JOB_STATUS.RUNNING, stage: JOB_STAGE.TEXT_POLICY, progress: 45 }); f.store.save();
    const recovered = new AnalysisJobStore({ filePath: f.store.filePath });
    assert.equal(recovered.get('one').status, JOB_STATUS.QUEUED); assert.equal(recovered.get('one').lastError.errorCode, 'APP_INTERRUPTED');
    fs.writeFileSync(f.store.filePath, '{broken');
    const clean = new AnalysisJobStore({ filePath: f.store.filePath });
    assert.equal(clean.jobs().length, 0); assert.equal(clean.health.ok, false); assert.ok(fs.existsSync(clean.health.quarantinedPath));
  } finally { f.cleanup(); }
});

test('queue persists transitions, reports, history, and batch exports', async () => {
  const f = fixture();
  try {
    const queue = new AnalysisQueue({ store: f.store, reports: f.reports, versions, delay: async () => {}, executor: async (job, context) => {
      for (const stage of [JOB_STAGE.METADATA, JOB_STAGE.TRANSCRIPT, JOB_STAGE.TEXT_POLICY, JOB_STAGE.VISUAL_PROXY, JOB_STAGE.VISUAL_ANALYSIS]) context.onStage(stage);
      return result(job.videoId);
    } });
    const added = queue.enqueueText('https://youtu.be/abc123xyz\nhttps://youtu.be/def456uvw');
    assert.equal(added.added.length, 2); assert.equal(queue.enqueueText('https://youtu.be/abc123xyz').duplicates.length, 1);
    queue.start(); await queue.waitForIdle();
    assert.equal(queue.summary().completed, 2); assert.equal(queue.summary().results.SAFE, 2);
    const job = queue.list()[0]; assert.equal(job.status, JOB_STATUS.COMPLETED); assert.equal(job.progress, 100);
    assert.ok(fs.existsSync(job.resultPath)); assert.match(fs.readFileSync(job.htmlReportPath, 'utf8'), /Recommended lower-risk windows/);
    const csv = f.reports.export(queue.store.jobs(), 'csv', path.join(f.dir, 'batch.csv'));
    const json = f.reports.export(queue.store.jobs(), 'json', path.join(f.dir, 'batch.json'));
    assert.match(fs.readFileSync(csv, 'utf8'), /videoId,title,channel,url,duration,status,overallResult/);
    assert.equal(JSON.parse(fs.readFileSync(json, 'utf8')).length, 2);
    assert.equal(new AnalysisJobStore({ filePath: f.store.filePath }).jobs().length, 2);
  } finally { f.cleanup(); }
});

test('retry is bounded to three attempts and permanent failures fail once', async () => {
  for (const [code, expected] of [['NETWORK_ERROR', 3], ['VIDEO_UNAVAILABLE', 1]]) {
    const f = fixture(); let attempts = 0;
    try {
      const queue = new AnalysisQueue({ store: f.store, reports: f.reports, versions, delay: async () => {}, executor: async () => { attempts++; throw Object.assign(new Error(code), { code }); } });
      queue.enqueueText('https://youtu.be/abc123xyz'); queue.start(); await queue.waitForIdle();
      assert.equal(attempts, expected); assert.equal(queue.list()[0].status, JOB_STATUS.FAILED);
    } finally { f.cleanup(); }
  }
});

test('pause, resume, per-job cancellation, cancel all, and retry reuse records', async () => {
  const f = fixture(); let release;
  try {
    const queue = new AnalysisQueue({ store: f.store, reports: f.reports, versions, delay: async () => {}, executor: (_job, { signal }) => new Promise((resolve, reject) => {
      release = () => resolve(result()); signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' })), { once: true });
    }) });
    queue.pause(); queue.enqueueText('https://youtu.be/abc123xyz\nhttps://youtu.be/def456uvw');
    assert.ok(queue.list().every(job => job.status === JOB_STATUS.PAUSED));
    queue.start(); queue.resume(); await new Promise(resolve => setImmediate(resolve));
    const activeId = queue.active.job.jobId; assert.equal(queue.cancel(activeId), true);
    await new Promise(resolve => setImmediate(resolve)); queue.cancelAll(); await queue.waitForIdle();
    assert.ok(queue.list().every(job => job.status === JOB_STATUS.CANCELLED));
    const failed = queue.store.jobs()[0]; failed.status = JOB_STATUS.FAILED; queue.store.save();
    assert.equal(queue.retry(failed.jobId), true); await new Promise(resolve => setImmediate(resolve)); release(); await queue.waitForIdle();
    assert.equal(queue.store.get(failed.jobId).status, JOB_STATUS.COMPLETED);
  } finally { f.cleanup(); }
});

test('GPU scheduler serializes model ownership across jobs', async () => {
  const gpu = new GpuScheduler(); const events = [];
  const first = gpu.withGpu('qwen', async () => { events.push('qwen-start'); await new Promise(resolve => setTimeout(resolve, 10)); events.push('qwen-end'); });
  const second = gpu.withGpu('gemma', async () => { events.push('gemma-start'); events.push('gemma-end'); });
  await Promise.all([first, second]); assert.deepEqual(events, ['qwen-start', 'qwen-end', 'gemma-start', 'gemma-end']); assert.equal(gpu.owner, null);
});

test('scheduler groups text checkpoints before visual phases', async () => {
  const f = fixture(); const phases = [];
  try {
    const queue = new AnalysisQueue({ store: f.store, reports: f.reports, versions, executor: async job => {
      phases.push(`${job.phase}:${job.videoId}`);
      return job.phase === 'TEXT' ? { deferred: true, metadata: { title: job.videoId } } : result(job.videoId);
    } });
    queue.enqueueText('https://youtu.be/abc123xyz\nhttps://youtu.be/def456uvw\nhttps://youtu.be/ghi789rst'); queue.start(); await queue.waitForIdle();
    assert.deepEqual(phases.map(value => value.split(':')[0]), ['TEXT', 'TEXT', 'TEXT', 'VISUAL', 'VISUAL', 'VISUAL']);
    assert.equal(queue.summary().completed, 3); assert.ok(queue.store.jobs().every(job => job.attempts === 1));
  } finally { f.cleanup(); }
});

test('analysis versions mark stale jobs and re-analysis preserves revisions', async () => {
  const f = fixture();
  try {
    const queue = new AnalysisQueue({ store: f.store, reports: f.reports, versions, executor: async job => result(job.videoId) });
    const id = queue.enqueueText('https://youtu.be/abc123xyz').added[0]; queue.start(); await queue.waitForIdle();
    const oldPath = queue.store.get(id).resultPath; queue.versions = { ...versions, policySet: 'policy-v2' };
    assert.equal(queue.stale(queue.store.get(id)), true); assert.equal(queue.reanalyze(id), true); await queue.waitForIdle();
    const job = queue.store.get(id); assert.equal(job.revisionId, 'r2'); assert.equal(job.revisions[0].resultPath, oldPath); assert.ok(fs.existsSync(oldPath));
    assert.equal(job.analysisVersion, analysisFingerprint(queue.versions));
  } finally { f.cleanup(); }
});

test('200-job queue persists while UI query remains capped and searchable', () => {
  const f = fixture();
  try {
    const queue = new AnalysisQueue({ store: f.store, reports: f.reports, versions, executor: async job => result(job.videoId), idFactory: (() => { let n = 0; return () => `job-${++n}`; })() });
    const urls = Array.from({ length: 200 }, (_, index) => `https://youtu.be/id${String(index).padStart(6, '0')}`).join('\n');
    queue.enqueueText(urls); assert.equal(queue.store.jobs().length, 200); assert.equal(queue.list().length, 100);
    queue.store.jobs()[150].title = 'Unique newsroom'; assert.equal(queue.list({ search: 'unique newsroom' }).length, 1);
    assert.ok(fs.statSync(f.store.filePath).size < 2 * 1024 * 1024);
    assert.equal(new AnalysisJobStore({ filePath: f.store.filePath }).jobs().length, 200);
  } finally { f.cleanup(); }
});

test('structured logs redact private content and rotate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-logs-')); const file = path.join(dir, 'jobs.log');
  try {
    const logger = new StructuredLogger({ filePath: file, maxBytes: 40, now: () => 'time' });
    logger.write({ jobId: 'one', transcript: 'secret words', ocrText: 'private@example.com', authorization: 'Bearer secret' });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret words|private@example|Bearer secret/);
    logger.write({ jobId: 'two', event: 'completed' }); assert.ok(fs.existsSync(`${file}.1`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt model caches are quarantined and ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-cache-'));
  try {
    for (const [name, Cache] of [['qwen.json', ModelFindingCache], ['visual.json', VisualFindingCache]]) {
      const file = path.join(dir, name); fs.writeFileSync(file, '{bad'); const cache = new Cache({ filePath: file });
      assert.equal(cache.entries.size, 0); assert.equal(fs.readdirSync(dir).some(item => item.startsWith(`${name}.corrupt-`)), true);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('frozen OCR runtime and Phase 6 IPC/doctor/UI contracts are present', async () => {
  const provider = new RapidOcrProvider({ executablePath: path.join(__dirname, '..', 'resources', 'ocr', 'rapidocr-worker.exe') });
  assert.deepEqual((await provider.healthCheck()).runtime, 'frozen-worker');
  const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(source('main.js'), /enqueue-analysis-jobs/); assert.match(source('preload.js'), /onAnalysisJobsUpdated/);
  assert.match(source('index.html'), /id="analysisQueue"/); assert.match(source('renderer.js'), /limit: 100/);
  assert.match(source('scripts/doctor.js'), /OCR runtime/); assert.match(source('package.json'), /resources\/ocr\//);
});

test('wall timing includes transcript fallback and visual work', () => {
  assert.equal(elapsedMs(1000, () => 16000), 15000);
});

test('unavailable visual pass hides final safe windows and preserves cause', () => {
  const f = fixture();
  try {
    const incomplete = { ...result(), visualStatus: 'UNAVAILABLE', visualErrorCode: 'VISUAL_PROXY_HTTP_403',
      visualError: 'HTTP Error 403', ocrStatus: 'UNAVAILABLE', ocrErrorCode: 'VISUAL_PIPELINE_NOT_REACHED',
      ocrError: 'Visual proxy failed before OCR could start.' };
    const output = f.reports.write({ videoId: 'abc123xyz', revisionId: 'r1', sourceUrl: 'url', modelVersions: {}, analysisVersion: 'a', policyVersion: 'p' }, incomplete);
    assert.equal(output.report.videoResult, 'INCOMPLETE'); assert.equal(output.report.safeWindows.length, 0);
    assert.match(output.report.warnings.join(' '), /VISUAL_PROXY_HTTP_403|VISUAL_PIPELINE_NOT_REACHED/);
  } finally { f.cleanup(); }
});

test('successful visual pass with OCR not required remains complete', () => {
  assert.equal(aggregateResult({ ...result(), ocrStatus: 'NOT_USED' }), 'SAFE');
});
