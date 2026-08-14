const { execFileSync } = require('node:child_process');
const fixtures = require('../test/fixtures/policy-judge-benchmark.json');
const { PolicyJudgeService, loadPolicyJudgeConfig } = require('../services/policyJudge');

function gpuMemory() {
  try {
    const output = execFileSync('nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim();
    const [totalMiB, usedMiB, freeMiB] = output.split(',').map(value => Number(value.trim()));
    return { totalMiB, usedMiB, freeMiB };
  } catch (_) { return null; }
}

(async () => {
  const service = new PolicyJudgeService({ config: loadPolicyJudgeConfig() });
  const health = await service.healthCheck();
  if (!health.ok) throw Object.assign(new Error(health.message), { code: health.code });
  const before = gpuMemory();
  let peakVramMiB = before?.usedMiB || 0;
  const results = [];
  for (const fixture of fixtures) {
    const result = await service.analyzeIngestion({
      metadata: { videoId: fixture.id, url: `benchmark:${fixture.id}`, title: fixture.id, durationSeconds: 30, channelName: '', thumbnailUrl: '' },
      transcriptSegments: [{ startSeconds: 0, endSeconds: 30, text: fixture.text }],
      transcriptLanguage: 'en', transcriptSource: 'synthetic-benchmark'
    }, { skipHealthCheck: true });
    results.push({
      id: fixture.id,
      expected: fixture.expectedDecision,
      actual: result.segmentJudgments[0].decision,
      decisionSource: result.segmentJudgments[0].decisionSource,
      categories: result.segmentJudgments[0].categories,
      expectedCategories: fixture.expectedCategories,
      metrics: result.metrics
    });
    peakVramMiB = Math.max(peakVramMiB, gpuMemory()?.usedMiB || 0);
  }
  const neutral = fixtures.filter(fixture => fixture.group === 'neutral').slice(0, 6);
  const safeProbe = await service.analyzeIngestion({
    metadata: { videoId: 'safe-window-probe', url: 'benchmark:safe-window-probe', title: 'Safe window probe', durationSeconds: 180, channelName: '', thumbnailUrl: '' },
    transcriptSegments: neutral.map((fixture, index) => ({ startSeconds: index * 30, endSeconds: (index + 1) * 30, text: fixture.text })),
    transcriptLanguage: 'en', transcriptSource: 'synthetic-benchmark'
  }, { skipHealthCheck: true });
  const after = gpuMemory();
  const agreement = results.filter(result => result.actual === result.expected).length;
  const falseKeep = results.filter(result => result.actual === 'KEEP' && result.expected !== 'KEEP').length;
  const falseRemove = results.filter(result => result.actual === 'REMOVE' && result.expected !== 'REMOVE').length;
  const falseReview = results.filter(result => result.actual === 'REVIEW' && result.expected !== 'REVIEW').length;
  const qwenCalls = results.reduce((sum, result) => sum + result.metrics.segmentsSentToQwen, 0);
  const latencies = results.flatMap(result => result.metrics.averageLatencyMs ? [result.metrics.averageLatencyMs] : []);
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : 0;
  const neutralResults = results.filter(result => fixtures.find(fixture => fixture.id === result.id)?.group === 'neutral');
  process.stdout.write(`${JSON.stringify({
    model: await service.provider.getModelInfo(),
    promptVersion: require('../services/policyJudge').POLICY_JUDGE_PROMPT_VERSION,
    benchmarkCount: results.length,
    agreementRate: agreement / results.length,
    falseKeep,
    falseRemove,
    falseReview,
    reviewRate: results.filter(result => result.actual === 'REVIEW').length / results.length,
    neutralBypassRate: neutralResults.filter(result => result.decisionSource === 'PRECHECK').length / neutralResults.length,
    qwenCalls,
    qwenCallReduction: 1 - qwenCalls / results.length,
    meanLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95),
    safeWindowProbe: { clips: safeProbe.recommendedClips.length, windows: safeProbe.recommendedClips.map(clip => ({ startSeconds: clip.startSeconds, endSeconds: clip.endSeconds })) },
    gpuBefore: before,
    gpuAfter: after,
    peakVramMiBAtSample: peakVramMiB || null,
    results: results.map(result => ({
      id: result.id, expected: result.expected, actual: result.actual,
      decisionSource: result.decisionSource, categories: result.categories,
      expectedCategories: result.expectedCategories,
      latencyMs: result.metrics.averageLatencyMs,
      qwenCalls: result.metrics.segmentsSentToQwen
    }))
  }, null, 2)}\n`);
})().catch(error => {
  process.stderr.write(`${error.code || 'BENCHMARK_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});
