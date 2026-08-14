const analyzeBtn = document.getElementById('analyzeBtn');
const urlInput = document.getElementById('urlInput');
const policyResult = document.getElementById('policyResult');
const engineLabel = document.getElementById('engineLabel');

const analysisState = { queue: 0, analyzing: 0, checked: 0 };
let lastUrl = '';
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
    return `
        <article class="segment-row">
            <div class="segment-marker ${segment.decision.toLowerCase()}">${segment.decision === 'REMOVE' ? '×' : segment.decision === 'REVIEW' ? '!' : '✓'}</div>
            <div class="segment-main">
                <strong>${escapeHtml(segment.startLabel)} → ${escapeHtml(segment.endLabel)}</strong>
                <span>Duration: ${formatDuration(segment.endSeconds - segment.startSeconds)}</span>
                ${segment.reason ? `<small>${escapeHtml(segment.reason)}</small>` : ''}
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
    const url = rawUrl.trim();
    lastUrl = url;
    if (!window.PolicyAnalysis.isValidYouTubeUrl(url)) {
        renderError('Enter a valid single YouTube video URL.');
        return;
    }

    const activeRequest = requestGuard.next();
    analysisState.analyzing = 1;
    analyzeBtn.disabled = true;
    updateStatusBar();
    renderAnalyzing('metadata');

    try {
        const result = await window.PolicyAnalysis.analyzeVideo(url, stage => {
            if (requestGuard.isCurrent(activeRequest)) renderAnalyzing(stage);
        });
        if (!requestGuard.isCurrent(activeRequest)) return;
        analysisState.checked += 1;
        renderSuccess(result);
    } catch (error) {
        if (requestGuard.isCurrent(activeRequest)) renderError(error.message || 'Unknown error.');
    } finally {
        if (requestGuard.isCurrent(activeRequest)) {
            analysisState.analyzing = 0;
            analyzeBtn.disabled = false;
            updateStatusBar();
        }
    }
}

analyzeBtn.addEventListener('click', () => analyzeVideo());
urlInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        analyzeVideo();
    }
});
document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        urlInput.focus();
        urlInput.select();
    }
});

renderEmpty();
updateStatusBar();
