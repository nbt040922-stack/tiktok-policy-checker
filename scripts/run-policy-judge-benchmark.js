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
      categories: result.segmentJudgments[0].categories,
      expectedCategories: fixture.expectedCategories,
      metrics: result.metrics
    });
  }
  const after = gpuMemory();
  const agreement = results.filter(result => result.actual === result.expected).length;
  const falseKeep = results.filter(result => result.actual === 'KEEP' && result.expected !== 'KEEP').length;
  const falseRemove = results.filter(result => result.actual === 'REMOVE' && result.expected !== 'REMOVE').length;
  process.stdout.write(`${JSON.stringify({
    model: await service.provider.getModelInfo(),
    promptVersion: require('../services/policyJudge').POLICY_JUDGE_PROMPT_VERSION,
    benchmarkCount: results.length,
    agreementRate: agreement / results.length,
    falseKeep,
    falseRemove,
    reviewRate: results.filter(result => result.actual === 'REVIEW').length / results.length,
    gpuBefore: before,
    gpuAfter: after,
    peakVramMiBAtSample: after?.usedMiB || null,
    results
  }, null, 2)}\n`);
})().catch(error => {
  process.stderr.write(`${error.code || 'BENCHMARK_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});
