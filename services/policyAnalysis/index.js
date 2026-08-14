(function exposePolicyAnalysis(globalScope) {
    /** @typedef {'KEEP' | 'REVIEW' | 'REMOVE'} PolicyDecision */
    const POLICY_DECISIONS = Object.freeze(['KEEP', 'REVIEW', 'REMOVE']);
    const ANALYSIS_STAGES = Object.freeze(['metadata', 'transcript', 'policy', 'safe_windows', 'complete']);

    function extractVideoId(url) {
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
        if (url.pathname === '/watch') return url.searchParams.get('v') || '';
        return url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1] || '';
    }

    function normalizeYouTubeUrl(value) {
        if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim())) return null;
        try {
            const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
            const url = new URL(candidate);
            const host = url.hostname.toLowerCase().replace(/^www\./, '');
            if (!['youtu.be', 'youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return null;
            const videoId = extractVideoId(url);
            if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) return null;
            return `https://www.youtube.com/watch?v=${videoId}`;
        } catch (_) {
            return null;
        }
    }

    function isValidYouTubeUrl(value) {
        return Boolean(normalizeYouTubeUrl(value));
    }

    function formatTimestamp(seconds) {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const remainder = total % 60;
        return hours
            ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
            : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    }

    function analyzeTranscriptSegments(transcriptSegments) {
        return transcriptSegments.map((segment, index) => {
            const decision = (index + 1) % 29 === 0 ? 'REMOVE' : (index + 1) % 13 === 0 ? 'REVIEW' : 'KEEP';
            return {
                id: `segment-${index + 1}`,
                startSeconds: segment.startSeconds,
                endSeconds: segment.endSeconds,
                startLabel: formatTimestamp(segment.startSeconds),
                endLabel: formatTimestamp(segment.endSeconds),
                decision,
                riskScore: decision === 'REMOVE' ? 0.85 : decision === 'REVIEW' ? 0.45 : 0.08,
                category: decision === 'KEEP' ? undefined : 'Phase 2 placeholder',
                reason: decision === 'KEEP' ? undefined : 'Deterministic placeholder — not a policy verdict',
                transcript: segment.text
            };
        });
    }

    function findSafeWindows(segments, options = {}) {
        const { minDurationSeconds = 120, maxDurationSeconds = 180, maxGapSeconds = 2.5 } = options;
        const clips = [];
        let index = 0;
        while (index < segments.length) {
            if (segments[index].decision !== 'KEEP') {
                index += 1;
                continue;
            }
            const run = [segments[index++]];
            while (index < segments.length && segments[index].decision === 'KEEP' && segments[index].startSeconds - run[run.length - 1].endSeconds <= maxGapSeconds) {
                run.push(segments[index++]);
            }
            for (let start = 0; start < run.length;) {
                let end = start;
                while (end + 1 < run.length && run[end].endSeconds - run[start].startSeconds < minDurationSeconds && run[end + 1].endSeconds - run[start].startSeconds <= maxDurationSeconds) end += 1;
                if (run[end].endSeconds - run[start].startSeconds < minDurationSeconds) break;
                while (end + 1 < run.length && run[end + 1].endSeconds - run[start].startSeconds <= maxDurationSeconds) end += 1;
                const first = run[start];
                const last = run[end];
                clips.push({
                    id: `clip-${clips.length + 1}`,
                    startSeconds: first.startSeconds,
                    endSeconds: last.endSeconds,
                    startLabel: formatTimestamp(first.startSeconds),
                    endLabel: formatTimestamp(last.endSeconds),
                    decision: 'KEEP',
                    riskScore: 0,
                    transcript: run.slice(start, end + 1).map(segment => segment.transcript).join(' ')
                });
                start = end + 1;
            }
        }
        return clips;
    }

    function createRequestGuard() {
        let current = 0;
        return {
            next: () => ++current,
            isCurrent: request => request === current,
            cancel: () => ++current
        };
    }

    function buildResult(ingestion) {
        const segments = analyzeTranscriptSegments(ingestion.transcriptSegments);
        const removeCount = segments.filter(segment => segment.decision === 'REMOVE').length;
        const reviewCount = segments.filter(segment => segment.decision === 'REVIEW').length;
        return {
            videoId: ingestion.metadata.videoId,
            url: ingestion.metadata.url,
            title: ingestion.metadata.title,
            durationSeconds: ingestion.metadata.durationSeconds,
            overallDecision: removeCount > segments.length / 4 ? 'REMOVE' : removeCount || reviewCount ? 'REVIEW' : 'KEEP',
            segments,
            recommendedClips: findSafeWindows(segments),
            transcriptSegments: ingestion.transcriptSegments,
            transcriptLanguage: ingestion.transcriptLanguage,
            transcriptSource: ingestion.transcriptSource,
            channelName: ingestion.metadata.channelName,
            thumbnailUrl: ingestion.metadata.thumbnailUrl
        };
    }

    async function analyzeVideo(value, onStageChange = () => {}, options = {}) {
        const url = normalizeYouTubeUrl(value);
        if (!url) throw Object.assign(new Error('Enter a valid single YouTube video URL.'), { code: 'INVALID_URL' });
        const api = options.api || globalScope.electronAPI;
        const requestId = options.requestId || `analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let unsubscribe = () => {};
        if (!options.ingest && typeof api?.onAnalysisStage === 'function') {
            unsubscribe = api.onAnalysisStage(update => {
                if (update?.requestId === requestId) onStageChange(update.stage);
            });
        }
        try {
            const response = options.ingest
                ? await options.ingest(url, { requestId, onStage: onStageChange })
                : await api.analyzeYouTubeVideo(url, requestId);
            if (!options.ingest && !response?.ok) throw Object.assign(new Error(response?.error?.message || 'Unable to analyze video.'), { code: response?.error?.code || 'INGESTION_ERROR' });
            const ingestion = options.ingest ? response : response.data;
            if (!options.ingest && /^local-qwen-v\d+$/.test(ingestion?.analysisVersion || '')) return ingestion;
            onStageChange('policy');
            const result = buildResult(ingestion);
            onStageChange('safe_windows');
            onStageChange('complete');
            return result;
        } finally {
            unsubscribe();
        }
    }

    const service = {
        POLICY_DECISIONS,
        ANALYSIS_STAGES,
        analyzeTranscriptSegments,
        analyzeVideo,
        buildResult,
        createRequestGuard,
        findSafeWindows,
        formatTimestamp,
        isValidYouTubeUrl,
        normalizeYouTubeUrl
    };
    globalScope.PolicyAnalysis = service;
    if (typeof module !== 'undefined' && module.exports) module.exports = service;
})(typeof window === 'undefined' ? globalThis : window);
