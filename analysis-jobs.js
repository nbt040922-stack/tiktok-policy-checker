const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const JOB_STATUS = Object.freeze({
  QUEUED: 'QUEUED', RUNNING: 'RUNNING', COMPLETED: 'COMPLETED', FAILED: 'FAILED',
  CANCELLED: 'CANCELLED', PAUSED: 'PAUSED'
});
const JOB_STAGE = Object.freeze({
  QUEUED: 'QUEUED', METADATA: 'METADATA', TRANSCRIPT: 'TRANSCRIPT', TEXT_POLICY: 'TEXT_POLICY',
  VISUAL_PROXY: 'VISUAL_PROXY', VISUAL_ANALYSIS: 'VISUAL_ANALYSIS', FINALIZING: 'FINALIZING', DONE: 'DONE'
});
const STAGE_PROGRESS = Object.freeze({
  QUEUED: 0, METADATA: 10, TRANSCRIPT: 20, TEXT_POLICY: 45,
  VISUAL_PROXY: 55, VISUAL_ANALYSIS: 90, FINALIZING: 98, DONE: 100
});
const RETRYABLE_CODES = new Set(['NETWORK_ERROR', 'YOUTUBE_RATE_LIMITED', 'YOUTUBE_SERVER_ERROR',
  'MODEL_HTTP_TEMPORARY', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'VISUAL_MODEL_UNAVAILABLE',
  'VISUAL_MODEL_TIMEOUT', 'OCR_FAILED', 'OCR_UNAVAILABLE']);

function nowIso(now = Date.now) { return new Date(now()).toISOString(); }
function elapsedMs(startedAtMs, now = Date.now) { return Math.max(0, now() - startedAtMs); }
function videoIdFrom(value) {
  try {
    const input = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtu.be', 'youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return null;
    const id = host === 'youtu.be' ? url.pathname.split('/').filter(Boolean)[0]
      : url.pathname === '/watch' ? url.searchParams.get('v')
        : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1];
    return /^[A-Za-z0-9_-]{6,}$/.test(id || '') ? id : null;
  } catch (_) { return null; }
}

function parseBatchUrls(text) {
  const seen = new Set(); const urls = []; const invalid = [];
  for (const value of String(text || '').split(/\s+/).map(item => item.trim()).filter(Boolean)) {
    const videoId = videoIdFrom(value);
    if (!videoId) { invalid.push(value); continue; }
    if (seen.has(videoId)) continue;
    seen.add(videoId); urls.push({ videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}` });
  }
  return { urls, invalid };
}

function analysisFingerprint(versions) {
  return crypto.createHash('sha256').update(JSON.stringify(versions)).digest('hex').slice(0, 20);
}

function aggregateResult(result) {
  if (!result || result.visualStatus === 'UNAVAILABLE' || result.ocrStatus === 'UNAVAILABLE') return 'INCOMPLETE';
  const decisions = (result.segmentJudgments || result.segments || []).map(item => item.decision);
  if (decisions.includes('REMOVE')) return 'HAS_REMOVE';
  if (decisions.includes('REVIEW')) return 'HAS_REVIEW';
  return 'SAFE';
}

function quarantine(filePath, fileSystem = fs) {
  const target = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fileSystem.renameSync(filePath, target);
  return target;
}

class AnalysisJobStore {
  constructor({ filePath, fileSystem = fs, now = Date.now } = {}) {
    if (!path.isAbsolute(filePath)) throw new TypeError('Job store path must be absolute.');
    this.filePath = filePath; this.fs = fileSystem; this.now = now;
    this.state = { formatVersion: 1, paused: false, jobs: [] };
    this.health = { ok: true, type: 'atomic-json', quarantinedPath: null };
    this.load();
    if (!this.fs.existsSync(this.filePath)) this.save();
  }
  load() {
    if (!this.fs.existsSync(this.filePath)) return this.state;
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (parsed.formatVersion !== 1 || !Array.isArray(parsed.jobs)) throw new Error('Unsupported analysis job database format.');
      this.state = parsed;
      let recovered = false;
      for (const job of this.state.jobs) {
        if (job.status === JOB_STATUS.RUNNING) {
          job.status = JOB_STATUS.QUEUED; job.progress = STAGE_PROGRESS[job.stage] || 0;
          job.lastError = { errorCode: 'APP_INTERRUPTED', technicalMessage: 'Previous app session ended during analysis.', userMessage: 'Analysis was safely queued again after restart.' };
          recovered = true;
        }
      }
      if (recovered) this.save();
    } catch (error) {
      try { this.health.quarantinedPath = quarantine(this.filePath, this.fs); } catch (_) {}
      this.health.ok = false; this.health.error = error.message;
      this.state = { formatVersion: 1, paused: false, jobs: [] };
      this.save();
    }
    return this.state;
  }
  save() {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    this.fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    this.fs.renameSync(temp, this.filePath);
  }
  jobs() { return this.state.jobs; }
  get(id) { return this.state.jobs.find(job => job.jobId === id) || null; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function segmentCounts(result) {
  const segments = result.segmentJudgments || result.segments || [];
  return Object.fromEntries(['KEEP', 'REVIEW', 'REMOVE'].map(decision => [decision.toLowerCase(), segments.filter(item => item.decision === decision).length]));
}

class ReportManager {
  constructor({ reportsDir, fileSystem = fs, now = Date.now } = {}) {
    this.reportsDir = reportsDir; this.fs = fileSystem; this.now = now;
  }
  write(job, result) {
    this.fs.mkdirSync(this.reportsDir, { recursive: true });
    const base = `${job.videoId}-${job.revisionId}`;
    const jsonPath = path.join(this.reportsDir, `${base}.json`);
    const htmlPath = path.join(this.reportsDir, `${base}.html`);
    const segments = result.segmentJudgments || result.segments || [];
    const safeWindows = (result.visualStatus === 'AVAILABLE' ? result.recommendedClips || [] : []).map(item => ({
      start: item.startSeconds, end: item.endSeconds, duration: item.endSeconds - item.startSeconds,
      confidence: 1, source: 'deterministic KEEP run', label: 'Recommended lower-risk window'
    }));
    const warnings = [result.visualStatus === 'UNAVAILABLE' ? `Visual (${result.visualErrorCode || 'UNAVAILABLE'}): ${result.visualError || 'Unavailable'}` : null,
      result.ocrStatus === 'UNAVAILABLE' ? `OCR (${result.ocrErrorCode || 'UNAVAILABLE'}): ${result.ocrError || 'Unavailable'}` : null].filter(Boolean);
    const report = {
      schemaVersion: 1, revisionId: job.revisionId, videoId: job.videoId,
      metadata: { title: result.title, channel: result.channelName, durationSeconds: result.durationSeconds, url: result.url || job.sourceUrl },
      analyzedAt: result.analyzedAt || nowIso(this.now), versions: job.modelVersions,
      analysisVersion: job.analysisVersion, policyVersion: job.policyVersion,
      videoResult: aggregateResult(result), overallDecision: result.overallDecision,
      counts: segmentCounts(result), segmentJudgments: segments,
      policyIds: [...new Set(segments.flatMap(item => item.policyIds || []))],
      onScreenEvidence: segments.flatMap(item => item.evidence?.onScreenText || []),
      visualFindings: segments.flatMap(item => item.visualFindings || []), safeWindows,
      transcriptProvider: result.transcriptProvider || null, metrics: result.metrics || {}, warnings
    };
    this.fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    this.fs.writeFileSync(htmlPath, this.html(report), 'utf8');
    return { jsonPath, htmlPath, report };
  }
  html(report) {
    const risky = report.segmentJudgments.filter(item => item.decision !== 'KEEP');
    const rows = risky.map(item => `<tr><td>${escapeHtml(item.startLabel)}–${escapeHtml(item.endLabel)}</td><td>${escapeHtml(item.decision)}</td><td>${escapeHtml(item.reason || '')}</td><td>${escapeHtml((item.policyIds || []).join(', '))}</td></tr>`).join('');
    const windows = report.safeWindows.map(item => `<li>${escapeHtml(item.label)}: ${item.start.toFixed(1)}s–${item.end.toFixed(1)}s (${item.duration.toFixed(1)}s; ${escapeHtml(item.source)})</li>`).join('');
    const ocr = report.onScreenEvidence.slice(0, 50).map(item => `<li>${escapeHtml(item.text || item.normalizedText || '')}</li>`).join('');
    const provider = report.transcriptProvider?.provider === 'EMBEDDED_EXTENSION' ? 'Browser fallback' : 'Direct';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.metadata.title || report.videoId)}</title><style>body{font:14px system-ui;max-width:1000px;margin:40px auto;padding:0 20px;color:#202124}h1{font-size:24px}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#eee;font-weight:700}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}.warn{color:#9b3439}small{color:#666}</style></head><body><h1>${escapeHtml(report.metadata.title || report.videoId)}</h1><p>${escapeHtml(report.metadata.channel)} · ${Math.round(report.metadata.durationSeconds || 0)}s</p><p class="badge">${escapeHtml(report.videoResult)}</p><p>KEEP ${report.counts.keep} · REVIEW ${report.counts.review} · REMOVE ${report.counts.remove}</p><h2>Risky sections</h2><table><thead><tr><th>Time</th><th>Result</th><th>Reason</th><th>Policies</th></tr></thead><tbody>${rows || '<tr><td colspan="4">None</td></tr>'}</tbody></table><h2>On-screen text evidence</h2><ul>${ocr || '<li>None</li>'}</ul><h2>Recommended lower-risk windows</h2><ul>${windows || '<li>None found</li>'}</ul><h2>Subsystem warnings</h2><ul class="warn">${report.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>None</li>'}</ul><h2>Runtime</h2><p><small>Transcript provider: ${provider}</small></p><pre>${escapeHtml(JSON.stringify(report.metrics, null, 2))}</pre><small>Automated risk assessment; not TikTok approval. Analyzed with ${escapeHtml(report.policyVersion)} / ${escapeHtml(report.analysisVersion)}.</small></body></html>`;
  }
  export(jobs, format, outputPath) {
    const rows = jobs.map(job => ({ videoId: job.videoId, title: job.title || '', channel: job.channel || '', url: job.sourceUrl,
      duration: job.durationSeconds || 0, status: job.status, overallResult: job.overallResult || '',
      keepSegments: job.counts?.keep || 0, reviewSegments: job.counts?.review || 0, removeSegments: job.counts?.remove || 0,
      safeWindowCount: job.safeWindowCount || 0, runtimeSeconds: Number(((job.metrics?.totalMs || 0) / 1000).toFixed(1)), error: job.lastError?.userMessage || '' }));
    this.fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (format === 'json') this.fs.writeFileSync(outputPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    else {
      const columns = Object.keys(rows[0] || { videoId: '' });
      const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
      this.fs.writeFileSync(outputPath, `${columns.join(',')}\n${rows.map(row => columns.map(key => quote(row[key])).join(',')).join('\n')}\n`, 'utf8');
    }
    return outputPath;
  }
}

class GpuScheduler {
  constructor() { this.tail = Promise.resolve(); this.owner = null; }
  withGpu(owner, operation) {
    const run = this.tail.then(async () => { this.owner = owner; try { return await operation(); } finally { this.owner = null; } });
    this.tail = run.catch(() => {});
    return run;
  }
}

function errorRecord(error) {
  const code = error?.code || 'ANALYSIS_FAILED';
  const messages = {
    INVALID_URL: 'URL YouTube không hợp lệ.', VIDEO_UNAVAILABLE: 'Video không còn khả dụng.',
    AUTH_REQUIRED: 'Video cần đăng nhập hoặc đang để riêng tư.', TRANSCRIPT_UNAVAILABLE: 'Video không có transcript có thể phân tích.',
    MODEL_NOT_INSTALLED: 'Mô hình AI cục bộ chưa được cài đặt.', POLICY_SET_UNAVAILABLE: 'Bộ chính sách bị thiếu hoặc hỏng.',
    NETWORK_ERROR: 'Lỗi mạng tạm thời. Ứng dụng sẽ thử lại.'
  };
  return { errorCode: code, technicalMessage: String(error?.message || error || code).slice(0, 500), userMessage: messages[code] || 'Không thể hoàn tất phân tích video này.' };
}

class AnalysisQueue extends EventEmitter {
  constructor({ store, executor, reports, versions, maxAttempts = 3, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, idFactory } = {}) {
    super(); this.store = store; this.executor = executor; this.reports = reports; this.versions = versions;
    this.maxAttempts = maxAttempts; this.delay = delay; this.now = now;
    this.idFactory = idFactory || (() => crypto.randomUUID()); this.active = null; this.running = false;
  }
  enqueueText(text, { force = false } = {}) {
    const parsed = parseBatchUrls(text); const added = []; const duplicates = [];
    for (const item of parsed.urls) {
      const existing = [...this.store.jobs()].reverse().find(job => job.videoId === item.videoId && job.status !== JOB_STATUS.CANCELLED);
      if (existing && !force) { duplicates.push(existing.jobId); continue; }
      if (existing && force) { this.reanalyze(existing.jobId); added.push(existing.jobId); continue; }
      const createdAt = nowIso(this.now); const jobId = this.idFactory();
      const job = { jobId, videoId: item.videoId, sourceUrl: item.sourceUrl, title: null, channel: null,
        createdAt, startedAt: null, completedAt: null, status: this.store.state.paused ? JOB_STATUS.PAUSED : JOB_STATUS.QUEUED,
        stage: JOB_STAGE.QUEUED, progress: 0, attempts: 0, lastError: null,
        analysisVersion: analysisFingerprint(this.versions), policyVersion: this.versions.policySet,
        modelVersions: this.versions, resultPath: null, htmlReportPath: null, overallResult: null,
        revisionId: 'r1', revisions: [], phase: 'TEXT', metrics: {}, warnings: [] };
      this.store.jobs().push(job); added.push(jobId);
    }
    this._changed(); this._drain(); return { added, duplicates, invalid: parsed.invalid };
  }
  list({ search = '', result = '', limit = 100 } = {}) {
    const query = search.toLowerCase();
    return [...this.store.jobs()].reverse().filter(job => (!result || job.overallResult === result || job.status === result)
      && (!query || [job.title, job.channel, job.videoId].some(value => String(value || '').toLowerCase().includes(query))))
      .slice(0, Math.min(500, limit)).map(job => ({ ...job, stale: this.stale(job) }));
  }
  start() { this.running = true; this._drain(); }
  stop() { this.running = false; }
  waitForIdle() {
    if (!this.active && !this.store.jobs().some(job => [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING].includes(job.status))) return Promise.resolve();
    return new Promise(resolve => this.once('idle', resolve));
  }
  pause() {
    this.store.state.paused = true;
    for (const job of this.store.jobs()) if (job.status === JOB_STATUS.QUEUED) job.status = JOB_STATUS.PAUSED;
    this._changed();
  }
  resume() {
    this.store.state.paused = false;
    for (const job of this.store.jobs()) if (job.status === JOB_STATUS.PAUSED) job.status = JOB_STATUS.QUEUED;
    this._changed(); this._drain();
  }
  cancel(id) {
    const job = this.store.get(id);
    if (!job || ![JOB_STATUS.QUEUED, JOB_STATUS.PAUSED, JOB_STATUS.RUNNING].includes(job.status)) return false;
    if (this.active?.job.jobId === id) this.active.controller.abort();
    job.status = JOB_STATUS.CANCELLED; job.completedAt = nowIso(this.now); this._event(job, 'cancelled'); this._changed(); return true;
  }
  cancelAll() { return this.store.jobs().filter(job => this.cancel(job.jobId)).length; }
  retry(id) {
    const job = this.store.get(id); if (!job || job.status !== JOB_STATUS.FAILED) return false;
    Object.assign(job, { status: this.store.state.paused ? JOB_STATUS.PAUSED : JOB_STATUS.QUEUED, stage: JOB_STAGE.QUEUED, progress: 0, attempts: 0, lastError: null, startedAt: null, completedAt: null });
    this._changed(); this._drain(); return true;
  }
  reanalyze(id) {
    const job = this.store.get(id); if (!job || job.status === JOB_STATUS.RUNNING) return false;
    if (job.resultPath) job.revisions.push({ revisionId: job.revisionId, analysisVersion: job.analysisVersion, createdAt: job.completedAt, resultPath: job.resultPath, htmlReportPath: job.htmlReportPath });
    const next = Number(job.revisionId.slice(1) || 1) + 1;
    Object.assign(job, { revisionId: `r${next}`, analysisVersion: analysisFingerprint(this.versions), modelVersions: this.versions,
      policyVersion: this.versions.policySet, status: this.store.state.paused ? JOB_STATUS.PAUSED : JOB_STATUS.QUEUED,
      stage: JOB_STAGE.QUEUED, progress: 0, attempts: 0, lastError: null, startedAt: null, completedAt: null,
      resultPath: null, htmlReportPath: null, overallResult: null, phase: 'TEXT' });
    this._changed(); this._drain(); return true;
  }
  stale(job) { return job.analysisVersion !== analysisFingerprint(this.versions); }
  summary() {
    const jobs = this.store.jobs(); const completed = jobs.filter(job => job.status === JOB_STATUS.COMPLETED);
    const runtimes = completed.map(job => job.metrics?.totalMs || 0).sort((a, b) => a - b);
    const sum = key => completed.reduce((total, job) => total + Number(job.metrics?.[key] || 0), 0);
    return { total: jobs.length, queued: jobs.filter(job => [JOB_STATUS.QUEUED, JOB_STATUS.PAUSED].includes(job.status)).length,
      running: jobs.filter(job => job.status === JOB_STATUS.RUNNING).length, completed: completed.length,
      failed: jobs.filter(job => job.status === JOB_STATUS.FAILED).length,
      results: Object.fromEntries(['SAFE', 'HAS_REVIEW', 'HAS_REMOVE', 'INCOMPLETE'].map(value => [value, completed.filter(job => job.overallResult === value).length])),
      totalRuntimeMs: runtimes.reduce((a, b) => a + b, 0), averageMs: runtimes.length ? Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length) : 0,
      medianMs: runtimes.length ? runtimes[Math.floor((runtimes.length - 1) / 2)] : 0,
      qwenCalls: sum('qwenCalls'), gemmaCalls: sum('gemmaCalls'), ocrCalls: sum('ocrCalls'), cacheHits: sum('qwenCacheHits') + sum('visualCacheHits') };
  }
  _stage(job, stage, patch = {}) {
    if (!JOB_STAGE[stage]) return;
    Object.assign(job, patch, { stage, progress: STAGE_PROGRESS[stage] }); this._event(job, 'stage'); this._changed();
  }
  _drain() {
    if (!this.running || this.active || this.store.state.paused) return;
    const queued = this.store.jobs().filter(item => item.status === JOB_STATUS.QUEUED);
    const job = queued.find(item => item.phase !== 'VISUAL') || queued[0];
    if (!job) { this.emit('idle'); return; }
    const controller = new AbortController(); this.active = { job, controller };
    void this._run(job, controller).finally(() => { this.active = null; this._drain(); });
  }
  async _run(job, controller) {
    job.status = JOB_STATUS.RUNNING; job.startedAt ||= nowIso(this.now); job.attempts ||= 1; this._changed(); this._event(job, 'started');
    const started = new Date(job.startedAt).getTime();
    try {
      const result = await this.executor(job, { signal: controller.signal, onStage: (stage, patch) => this._stage(job, stage, patch) });
      if (controller.signal.aborted || job.status === JOB_STATUS.CANCELLED) return;
      if (result?.deferred) {
        Object.assign(job, { status: this.store.state.paused ? JOB_STATUS.PAUSED : JOB_STATUS.QUEUED, phase: 'VISUAL',
          title: result.metadata?.title || job.title, channel: result.metadata?.channelName || job.channel,
          durationSeconds: result.metadata?.durationSeconds || job.durationSeconds });
        this._event(job, 'phase_completed', { phase: 'TEXT' }); this._changed(); return;
      }
      this._stage(job, JOB_STAGE.FINALIZING);
      const output = this.reports.write(job, result); const counts = segmentCounts(result);
      Object.assign(job, { status: JOB_STATUS.COMPLETED, stage: JOB_STAGE.DONE, progress: 100, completedAt: nowIso(this.now), phase: 'DONE',
        resultPath: output.jsonPath, htmlReportPath: output.htmlPath, title: result.title || job.title,
        channel: result.channelName || job.channel, durationSeconds: result.durationSeconds,
        overallResult: output.report.videoResult, counts, safeWindowCount: output.report.safeWindows.length,
        warnings: output.report.warnings, metrics: { ...(result.metrics || {}), totalMs: this.now() - started } });
      this._event(job, 'completed', { duration: job.metrics.totalMs }); this._changed();
    } catch (error) {
      if (controller.signal.aborted || job.status === JOB_STATUS.CANCELLED || error?.code === 'CANCELLED' || error?.code === 'ANALYSIS_CANCELLED') {
        job.status = JOB_STATUS.CANCELLED; job.completedAt = nowIso(this.now); this._event(job, 'cancelled'); this._changed(); return;
      }
      job.lastError = errorRecord(error);
      if (RETRYABLE_CODES.has(job.lastError.errorCode) && job.attempts < this.maxAttempts) {
        job.attempts++; job.status = JOB_STATUS.QUEUED; this._event(job, 'retry', { errorCode: job.lastError.errorCode }); this._changed();
        await this.delay(Math.min(30000, 1000 * 2 ** (job.attempts - 1)));
        if (job.status === JOB_STATUS.QUEUED) await this._run(job, controller);
        return;
      }
      job.status = JOB_STATUS.FAILED; job.completedAt = nowIso(this.now); this._event(job, 'failed', { errorCode: job.lastError.errorCode }); this._changed();
    }
  }
  _changed() { this.store.save(); this.emit('changed', { jobs: this.list(), summary: this.summary(), paused: this.store.state.paused, database: this.store.health }); }
  _event(job, event, extra = {}) { this.emit('job-event', { jobId: job.jobId, videoId: job.videoId, status: job.status, stage: job.stage, event, attempts: job.attempts, ...extra }); }
}

module.exports = { AnalysisJobStore, AnalysisQueue, GpuScheduler, JOB_STAGE, JOB_STATUS, ReportManager,
  elapsedMs,
  STAGE_PROGRESS, aggregateResult, analysisFingerprint, errorRecord, parseBatchUrls, quarantine, segmentCounts, videoIdFrom };
