const analyzeBtn = document.getElementById('analyzeBtn');
const urlInput = document.getElementById('urlInput');
const policyResult = document.getElementById('policyResult');
const engineLabel = document.getElementById('engineLabel');
const analysisJobList = document.getElementById('analysisJobList');
const queueSummary = document.getElementById('queueSummary');
const historySearch = document.getElementById('historySearch');
const resultFilter = document.getElementById('resultFilter');

const analysisState = { queue: 0, analyzing: 0, checked: 0 };
let lastUrl = '';
let latestQueuedJob = null;
let queuePaused = false;
const requestGuard = window.PolicyAnalysis.createRequestGuard();

document.getElementById('winMinimize')?.addEventListener('click', () => window.electronAPI.minimizeWindow());
document.getElementById('winMaximize')?.addEventListener('click', () => window.electronAPI.maximizeWindow());
document.getElementById('winClose')?.addEventListener('click', () => window.electronAPI.closeWindow());

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function updateStatusBar() {
    engineLabel.textContent = `Queue: ${analysisState.queue} | Analyzing: ${analysisState.analyzing} | Checked: ${analysisState.checked}`;
}

function queueAction(job) {
    if (['QUEUED', 'PAUSED', 'RUNNING'].includes(job.status)) return `<button data-action="cancel" data-id="${job.jobId}">Cancel</button>`;
    if (job.status === 'FAILED') return `<button data-action="retry" data-id="${job.jobId}">Retry</button>`;
    if (job.status === 'COMPLETED') return `<button data-action="open" data-id="${job.jobId}">Open report</button><button data-action="reanalyze" data-id="${job.jobId}">Re-analyze</button>`;
    return '';
}

async function renderQueue(snapshot) {
    const query = historySearch.value.trim().toLowerCase(); const wanted = resultFilter.value;
    const priority = { HAS_REMOVE: 0, HAS_REVIEW: 1, SAFE: 2, FAILED: 3 };
    const jobs = (snapshot.jobs || []).filter(job => (!wanted || job.overallResult === wanted || job.status === wanted)
        && (!query || [job.title, job.channel, job.videoId].some(value => String(value || '').toLowerCase().includes(query))))
        .sort((a, b) => (priority[a.overallResult || a.status] ?? -1) - (priority[b.overallResult || b.status] ?? -1)).slice(0, 100);
    const summary = snapshot.summary || {};
    queuePaused = Boolean(snapshot.paused);
    analysisState.queue = summary.queued || 0; analysisState.analyzing = summary.running || 0; analysisState.checked = summary.completed || 0;
    updateStatusBar();
    queueSummary.textContent = snapshot.database?.ok === false
        ? 'Job database was corrupt and quarantined · New queue started safely'
        : `Queued ${summary.queued || 0} · Running ${summary.running || 0} · Completed ${summary.completed || 0}`;
    document.getElementById('pauseQueueBtn').textContent = queuePaused ? 'Resume' : 'Pause';
    analysisJobList.innerHTML = jobs.length ? jobs.map(job => `<article class="analysis-job">
        <div class="job-copy"><strong>${escapeHtml(job.title || job.sourceUrl)}</strong><small>${escapeHtml(job.stage)} · ${escapeHtml(job.status)}${job.stale ? ' · STALE' : ''}${job.lastError ? ` · ${escapeHtml(job.lastError.userMessage)}` : ''}</small></div>
        <div class="job-progress"><span style="width:${Math.max(0, Math.min(100, job.progress || 0))}%"></span></div>
        <span class="job-result">${escapeHtml(job.overallResult || `${job.progress || 0}%`)}</span><div class="job-actions">${queueAction(job)}</div>
    </article>`).join('') : '<p class="queue-empty">No analysis jobs yet.</p>';
    const running = jobs.find(job => job.status === 'RUNNING');
    if (running) renderAnalyzing(({ METADATA: 'metadata', TRANSCRIPT: 'transcript', TEXT_POLICY: 'policy', VISUAL_PROXY: 'visual_proxy', VISUAL_ANALYSIS: 'visual_sampling', FINALIZING: 'safe_windows' })[running.stage] || 'metadata');
    const completed = latestQueuedJob && jobs.find(job => job.jobId === latestQueuedJob && job.status === 'COMPLETED');
    if (completed) {
        const result = await window.electronAPI.getAnalysisResult(completed.jobId);
        if (result) renderSuccess(result);
        latestQueuedJob = null;
    }
}

function formatDuration(seconds) {
    return window.PolicyAnalysis.formatTimestamp(seconds);
}

function decisionBadge(decision) {
    return `<span class="decision decision-${decision.toLowerCase()}">${escapeHtml(decision)}</span>`;
}

function renderEmpty() {
    policyResult.className = 'policy-result policy-empty';
    policyResult.innerHTML = `
        <div class="empty-icon"><i class="fas fa-shield-alt"></i></div>
        <h1>TikTok Policy Checker</h1>
        <p>Paste a YouTube link above<br>to analyze the video.</p>`;
}

function renderAnalyzing(stage) {
    const stages = [
        ['metadata', 'Video metadata'],
        ['transcript', 'Transcript'],
        ['policy', 'Checking TikTok policies'],
        ['visual_proxy', 'Preparing local visual proxy'],
        ['visual_sampling', 'Scanning sampled frames'],
        ['safe_windows', 'Finding safe segments']
    ];
    const activeIndex = stage === 'complete' ? stages.length : Math.max(0, stages.findIndex(([key]) => key === stage));
    policyResult.className = 'policy-result policy-analyzing';
    policyResult.innerHTML = `
        <div class="loading-ring" aria-hidden="true"></div>
        <h1>Analyzing video...</h1>
        <div class="analysis-steps">
            ${stages.map(([key, label], index) => {
                const status = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending';
                const marker = status === 'complete' ? '✓' : status === 'active' ? '●' : '○';
                return `<div class="analysis-step ${status}" data-stage="${key}"><span>${marker}</span>${label}</div>`;
            }).join('')}
        </div>`;
}

function segmentRow(segment) {
    const visualRisk = segment.visualFindings?.length > 0;
    return `
        <article class="segment-row">
            <div class="segment-marker ${segment.decision.toLowerCase()}">${segment.decision === 'REMOVE' ? '×' : segment.decision === 'REVIEW' ? '!' : '✓'}</div>
            <div class="segment-main">
                <strong>${escapeHtml(segment.startLabel)} → ${escapeHtml(segment.endLabel)}</strong>
                <span>Duration: ${formatDuration(segment.endSeconds - segment.startSeconds)}</span>
                ${segment.reason ? `<small>${escapeHtml(segment.reason)}</small>` : ''}
                ${visualRisk ? '<small>REVIEW â€” Visual Risk</small>' : segment.decision === 'REVIEW' ? '<small>REVIEW â€” Text/Policy Context</small>' : ''}
                ${segment.policyIds?.length ? `<small>Policy: ${escapeHtml(segment.policyIds.join(', '))}</small>` : ''}
            </div>
            ${decisionBadge(segment.decision)}
        </article>`;
}

function renderSuccess(result) {
    const riskySections = result.segments.filter(segment => segment.decision !== 'KEEP');
    policyResult.className = 'policy-result policy-success';
    policyResult.innerHTML = `
        <section class="result-summary glass-panel">
            <div>
                <span class="eyebrow">VIDEO TITLE</span>
                <h1>${escapeHtml(result.title)}</h1>
                <p>Duration: ${formatDuration(result.durationSeconds)}</p>
            </div>
            <div class="overall"><span>Overall</span>${decisionBadge(result.overallDecision)}</div>
        </section>
        <section class="result-group">
            <h2>Recommended Clips</h2>
            <div class="glass-panel">${result.recommendedClips.length ? result.recommendedClips.map(segmentRow).join('') : '<p class="empty-result">No 2–3 minute safe window found.</p>'}</div>
        </section>
        <section class="result-group">
            <h2>Risky Sections</h2>
            <div class="glass-panel">${riskySections.length ? riskySections.map(segmentRow).join('') : '<p class="empty-result">No REVIEW or REMOVE sections found.</p>'}</div>
        </section>`;
}

function renderError(message) {
    policyResult.className = 'policy-result policy-error';
    policyResult.innerHTML = `
        <div class="error-icon"><i class="fas fa-exclamation-triangle"></i></div>
        <h1>Unable to analyze video.</h1>
        <p><strong>Reason:</strong><br>${escapeHtml(message)}</p>
        <button id="retryBtn" class="retry-btn" type="button">Retry</button>`;
    document.getElementById('retryBtn').addEventListener('click', () => analyzeVideo(lastUrl));
}

async function analyzeVideo(rawUrl = urlInput.value) {
    const urls = rawUrl.trim();
    lastUrl = urls;
    if (!urls) {
        renderError('Enter one or more YouTube video URLs.');
        return;
    }

    const activeRequest = requestGuard.next();
    analyzeBtn.disabled = true;
    updateStatusBar();
    renderAnalyzing('metadata');

    try {
        const result = await window.electronAPI.enqueueAnalysisJobs(urls);
        if (!requestGuard.isCurrent(activeRequest)) return;
        if (!result.added.length && result.invalid.length) throw new Error('No valid YouTube video URL was found.');
        latestQueuedJob = result.added.at(-1) || result.duplicates.at(-1) || null;
        urlInput.value = '';
        await refreshQueue();
    } catch (error) {
        if (requestGuard.isCurrent(activeRequest)) renderError(error.message || 'Unknown error.');
    } finally {
        if (requestGuard.isCurrent(activeRequest)) {
            analyzeBtn.disabled = false;
            updateStatusBar();
        }
    }
}

analyzeBtn.addEventListener('click', () => analyzeVideo());
urlInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        analyzeVideo();
    }
});

async function refreshQueue() {
    return renderQueue(await window.electronAPI.getAnalysisJobs({ search: historySearch.value, result: resultFilter.value, limit: 100 }));
}

async function refreshStorage() {
    const value = await window.electronAPI.getAnalysisStorage();
    const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
    document.getElementById('storageUsage').textContent = `Reports ${mb(value.reportsBytes)} · Cache ${mb(value.cacheBytes)} · Temp ${mb(value.temporaryMediaBytes)}`;
    document.getElementById('retentionDays').value = String(value.keepReportsDays || 0);
}

analysisJobList.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const actions = { cancel: 'cancelAnalysisJob', retry: 'retryAnalysisJob', open: 'openAnalysisReport', reanalyze: 'reanalyzeJob' };
    await window.electronAPI[actions[button.dataset.action]](button.dataset.id); await refreshQueue();
});
document.getElementById('pauseQueueBtn').addEventListener('click', async () => { await window.electronAPI[queuePaused ? 'resumeAnalysisQueue' : 'pauseAnalysisQueue'](); await refreshQueue(); });
document.getElementById('cancelPendingBtn').addEventListener('click', async () => { await window.electronAPI.cancelAllAnalysisJobs(); await refreshQueue(); });
document.getElementById('exportCsvBtn').addEventListener('click', () => window.electronAPI.exportAnalysisBatch('csv'));
document.getElementById('exportJsonBtn').addEventListener('click', () => window.electronAPI.exportAnalysisBatch('json'));
historySearch.addEventListener('input', refreshQueue);
resultFilter.addEventListener('change', refreshQueue);
document.getElementById('clearQwenBtn').addEventListener('click', async () => { await window.electronAPI.clearPolicyCache(); refreshStorage(); });
document.getElementById('clearVisualBtn').addEventListener('click', async () => { await window.electronAPI.clearVisualCache(); refreshStorage(); });
document.getElementById('clearReportsBtn').addEventListener('click', async () => { await window.electronAPI.clearAnalysisReports(); refreshStorage(); });
document.getElementById('retentionDays').addEventListener('change', async event => { await window.electronAPI.setReportRetention(event.target.value); refreshStorage(); });
window.electronAPI.onAnalysisJobsUpdated(renderQueue);
document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        urlInput.focus();
        urlInput.select();
    }
});

renderEmpty();
updateStatusBar();
refreshQueue();
refreshStorage();
