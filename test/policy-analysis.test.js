const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policyAnalysis = require('../services/policyAnalysis');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('valid YouTube video URLs start mock analysis', async () => {
  const stages = [];
  const result = await policyAnalysis.analyzeVideo(
    'https://www.youtube.com/watch?v=phase1-test',
    stage => stages.push(stage),
    0
  );
  assert.equal(result.url, 'https://www.youtube.com/watch?v=phase1-test');
  assert.deepEqual(stages, policyAnalysis.ANALYSIS_STAGES);
});

test('invalid and non-video URLs are rejected', async () => {
  for (const url of ['not a URL', 'https://example.com/video', 'https://youtube.com/playlist?list=123']) {
    assert.equal(policyAnalysis.isValidYouTubeUrl(url), false);
    await assert.rejects(policyAnalysis.analyzeVideo(url, undefined, 0), /Invalid YouTube/);
  }
});

test('mock result uses only KEEP, REVIEW, and REMOVE decisions', () => {
  const result = policyAnalysis.createMockResult('https://youtu.be/phase1-test');
  assert.equal(result.overallDecision, 'REVIEW');
  assert.deepEqual(new Set(result.segments.map(segment => segment.decision)), new Set(['KEEP', 'REVIEW', 'REMOVE']));
  assert.ok(result.recommendedClips.length > 1);
});

test('renderer supports policy states and Enter triggers analysis', () => {
  const renderer = source('renderer.js');
  assert.match(renderer, /renderEmpty\(\)/);
  assert.match(renderer, /renderAnalyzing\('metadata'\)/);
  assert.match(renderer, /renderSuccess\(result\)/);
  assert.match(renderer, /renderError\(/);
  assert.match(renderer, /event\.key === 'Enter'[\s\S]*?analyzeVideo\(\)/);
  assert.match(renderer, /decision-\$\{decision\.toLowerCase\(\)\}/);
});

test('status bar is driven by analysis state', () => {
  const renderer = source('renderer.js');
  assert.match(renderer, /Queue: \$\{analysisState\.queue\} \| Analyzing: \$\{analysisState\.analyzing\} \| Checked: \$\{analysisState\.checked\}/);
  assert.match(renderer, /analysisState\.checked \+= 1/);
});
