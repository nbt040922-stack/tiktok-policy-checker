(function exposePolicyAnalysis(globalScope) {
    /** @typedef {'KEEP' | 'REVIEW' | 'REMOVE'} PolicyDecision */
    /** @typedef {'metadata' | 'transcript' | 'policy' | 'safe_windows' | 'complete'} AnalysisStage */
    /**
     * @typedef {Object} PolicySegment
     * @property {string} id
     * @property {number} startSeconds
     * @property {number} endSeconds
     * @property {string} startLabel
     * @property {string} endLabel
     * @property {PolicyDecision} decision
     * @property {number} riskScore
     * @property {string=} category
     * @property {string=} reason
     * @property {string=} transcript
     */
    /**
     * @typedef {Object} PolicyAnalysisResult
     * @property {string} videoId
     * @property {string} url
     * @property {string} title
     * @property {number} durationSeconds
     * @property {PolicyDecision} overallDecision
     * @property {PolicySegment[]} segments
     * @property {PolicySegment[]} recommendedClips
     */

    const POLICY_DECISIONS = Object.freeze(['KEEP', 'REVIEW', 'REMOVE']);
    const ANALYSIS_STAGES = Object.freeze(['metadata', 'transcript', 'policy', 'safe_windows', 'complete']);

    function parseYouTubeUrl(value) {
        try {
            const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
            return new URL(candidate);
        } catch (_) {
            return null;
        }
    }

    function isValidYouTubeUrl(value) {
        if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim())) return false;
        const url = parseYouTubeUrl(value.trim());
        if (!url) return false;
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean).length === 1;
        if (!['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return false;
        if (url.pathname === '/watch') return Boolean(url.searchParams.get('v'));
        return /^\/(shorts|live|embed)\/[^/]+\/?$/.test(url.pathname);
    }

    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

    /** @returns {PolicyAnalysisResult} */
    function createMockResult(url) {
        const segments = [
            { id: 'keep-1', startSeconds: 0, endSeconds: 137, startLabel: '00:00', endLabel: '02:17', decision: 'KEEP', riskScore: 0.08 },
            { id: 'remove-1', startSeconds: 137, endSeconds: 230, startLabel: '02:17', endLabel: '03:50', decision: 'REMOVE', riskScore: 0.91, category: 'Sensitive content', reason: 'Self-harm / sensitive content' },
            { id: 'keep-2', startSeconds: 230, endSeconds: 350, startLabel: '03:50', endLabel: '05:50', decision: 'KEEP', riskScore: 0.12 },
            { id: 'remove-2', startSeconds: 380, endSeconds: 478, startLabel: '06:20', endLabel: '07:58', decision: 'REMOVE', riskScore: 0.88, category: 'Harassment', reason: 'Harassment / profanity' },
            { id: 'review-1', startSeconds: 538, endSeconds: 658, startLabel: '08:58', endLabel: '10:58', decision: 'REVIEW', riskScore: 0.48, reason: 'Review context before publishing' }
        ];
        return {
            videoId: 'phase1-mock-video',
            url,
            title: 'Sample YouTube Video — Policy Analysis Preview',
            durationSeconds: 692,
            overallDecision: 'REVIEW',
            segments,
            recommendedClips: [segments[0], segments[2], segments[4]]
        };
    }

    /**
     * Mock implementation of the future PolicyAnalysisService boundary.
     * @param {string} url
     * @param {(stage: AnalysisStage) => void=} onStageChange
     * @param {number=} delayMs
     * @returns {Promise<PolicyAnalysisResult>}
     */
    async function analyzeVideo(url, onStageChange = () => {}, delayMs = 300) {
        if (!isValidYouTubeUrl(url)) throw new Error('Invalid YouTube video URL.');
        for (const stage of ANALYSIS_STAGES.slice(0, -1)) {
            onStageChange(stage);
            await wait(delayMs);
        }
        onStageChange('complete');
        return createMockResult(url);
    }

    const service = { POLICY_DECISIONS, ANALYSIS_STAGES, isValidYouTubeUrl, createMockResult, analyzeVideo };
    globalScope.PolicyAnalysis = service;
    if (typeof module !== 'undefined' && module.exports) module.exports = service;
})(typeof window === 'undefined' ? globalThis : window);
