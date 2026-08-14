const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policyAnalysis = require('../services/policyAnalysis');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function ingestionFixture() {
  return {
    metadata: { videoId: 'abc123xyz', url: 'https://www.youtube.com/watch?v=abc123xyz', title: 'Real title', durationSeconds: 600, channelName: 'Channel', thumbnailUrl: 'https://example.com/thumb.jpg' },
    transcriptSegments: Array.from({ length: 30 }, (_, index) => ({ startSeconds: index * 20, endSeconds: (index + 1) * 20, text: `Spoken segment ${index + 1}.` })),
    transcriptLanguage: 'en',
    transcriptSource: 'manual'
  };
}

test('YouTube URL normalization accepts video forms and removes extra parameters', () => {
  for (const value of [
    'youtu.be/abc123xyz?t=10',
    'https://youtube.com/shorts/abc123xyz?feature=share',
    'https://m.youtube.com/watch?v=abc123xyz&list=ignored'
  ]) assert.equal(policyAnalysis.normalizeYouTubeUrl(value), 'https://www.youtube.com/watch?v=abc123xyz');
  for (const value of ['not a URL', 'https://example.com/video', 'https://youtube.com/playlist?list=123']) {
    assert.equal(policyAnalysis.normalizeYouTubeUrl(value), null);
  }
});

test('real ingestion result keeps metadata and transcript timestamps', async () => {
  const stages = [];
  const result = await policyAnalysis.analyzeVideo('https://youtu.be/abc123xyz', stage => stages.push(stage), {
    ingest: async (url, { onStage }) => {
      onStage('metadata');
      onStage('transcript');
      return ingestionFixture();
    }
  });
  assert.equal(result.videoId, 'abc123xyz');
  assert.equal(result.title, 'Real title');
  assert.equal(result.durationSeconds, 600);
  assert.equal(result.segments[0].transcript, 'Spoken segment 1.');
  assert.equal(result.segments[0].startSeconds, 0);
  assert.deepEqual(stages, policyAnalysis.ANALYSIS_STAGES);
  assert.deepEqual(new Set(result.segments.map(segment => segment.decision)), new Set(['KEEP', 'REVIEW', 'REMOVE']));
  assert.ok(result.recommendedClips.length > 0);
});

test('duration formatting supports minutes and hours', () => {
  assert.equal(policyAnalysis.formatTimestamp(81.9), '01:21');
  assert.equal(policyAnalysis.formatTimestamp(3661), '1:01:01');
});

test('safe-window baseline uses continuous KEEP segments only', () => {
  const segments = [
    { decision: 'KEEP', startSeconds: 0, endSeconds: 60, transcript: 'a' },
    { decision: 'KEEP', startSeconds: 60, endSeconds: 120, transcript: 'b' },
    { decision: 'KEEP', startSeconds: 120, endSeconds: 170, transcript: 'c' },
    { decision: 'REMOVE', startSeconds: 170, endSeconds: 190, transcript: 'risk' },
    { decision: 'KEEP', startSeconds: 190, endSeconds: 250, transcript: 'd' }
  ];
  const clips = policyAnalysis.findSafeWindows(segments);
  assert.equal(clips.length, 1);
  assert.deepEqual([clips[0].startSeconds, clips[0].endSeconds, clips[0].decision], [0, 170, 'KEEP']);
  assert.equal(policyAnalysis.findSafeWindows(segments.slice(3)).length, 0);
});

test('latest request guard prevents stale analysis overwrite', async () => {
  const guard = policyAnalysis.createRequestGuard();
  const rendered = [];
  const first = guard.next();
  const slow = new Promise(resolve => setTimeout(() => resolve('Video A'), 20)).then(value => {
    if (guard.isCurrent(first)) rendered.push(value);
  });
  const second = guard.next();
  const fast = Promise.resolve('Video B').then(value => {
    if (guard.isCurrent(second)) rendered.push(value);
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(rendered, ['Video B']);
});

test('renderer supports all states, Enter, and empty safe-window output', () => {
  const renderer = source('renderer.js');
  assert.match(renderer, /renderEmpty\(\)/);
  assert.match(renderer, /renderAnalyzing\('metadata'\)/);
  assert.match(renderer, /renderSuccess\(result\)/);
  assert.match(renderer, /renderError\(/);
  assert.match(renderer, /event\.key === 'Enter'[\s\S]*?analyzeVideo\(\)/);
  assert.match(renderer, /No 2–3 minute safe window found/);
  assert.match(renderer, /requestGuard\.isCurrent/);
});

test('main process reuses auth and keeps transcript ingestion media-free before the visual pass', () => {
  const main = source('main.js');
  const preload = source('preload.js');
  assert.match(main, /youtubeAuth\.withTemporaryCookies/);
  assert.match(main, /'--no-playlist', '--skip-download', '--dump-single-json'/);
  assert.match(main, /downloadVisualProxy[\s\S]*18\/best\[height<=360\]\/bestvideo\[height<=360\]/);
  assert.match(main, /downloadVisualProxy[\s\S]*jsRuntime: false/);
  assert.match(main, /ipcMain\.handle\('analyze-youtube-video'/);
  assert.match(main, /activeAnalysisControllers\.get\(senderId\)\?\.abort\(\)/);
  assert.match(preload, /analyzeYouTubeVideo/);
  assert.match(preload, /onAnalysisStage/);
});
