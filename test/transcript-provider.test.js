const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ReportManager } = require('../analysis-jobs');
const { YouTubeIngestionService } = require('../services/youtube');
const { VisualMediaService } = require('../services/visualRisk');
const { EXTENSION_ID, ExtensionManager, HEALTH, PARTITION, inspectExtension } = require('../services/youtube/extensionTranscript/extensionManager');
const { parseDomSegments, transcriptForPage } = require('../services/youtube/extensionTranscript/transcriptBrowserManager');
const { TimedTextCircuitBreaker, TranscriptProviderChain } = require('../services/youtube/providerChain');

const metadata = { videoId: 'wxEpPin8MWw', url: 'https://www.youtube.com/watch?v=wxEpPin8MWw', durationSeconds: 70 };
const track = { language: 'en', source: 'automatic' };
const extensionResult = { transcriptCues: [{ startSeconds: 0, endSeconds: 4, text: 'hello' }],
  transcriptSegments: [{ startSeconds: 0, endSeconds: 4, text: 'hello' }], transcriptLanguage: 'en', transcriptSource: 'extension',
  transcriptProvider: { provider: 'EMBEDDED_EXTENSION', extensionId: EXTENSION_ID, extensionVersion: '2.3.1' } };

test('extension manager validates version, uses production partition, and loads once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-manager-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extensionPath = path.join(root, 'extension'); fs.mkdirSync(extensionPath);
  fs.writeFileSync(path.join(extensionPath, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '2.3.1', name: 'YouTube Summary with ChatGPT & Claude' }));
  assert.equal(inspectExtension(extensionPath).status, HEALTH.READY);
  let loads = 0; let partition;
  const manager = new ExtensionManager({ userDataPath: root, env: { YOUTUBE_TRANSCRIPT_EXTENSION_PATH: extensionPath },
    sessionFromPartition: value => { partition = value; return { loadExtension: async () => { loads++; return { id: EXTENSION_ID, version: '2.3.1' }; } }; } });
  await Promise.all([manager.load(), manager.load()]); await manager.load();
  assert.equal(partition, PARTITION); assert.equal(loads, 1); assert.equal(manager.health.status, HEALTH.READY);
});

test('extension health distinguishes missing and untested versions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-health-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(inspectExtension(root).status, HEALTH.NOT_FOUND);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '9.0.0' }));
  assert.equal(inspectExtension(root).status, HEALTH.VERSION_MISMATCH);
});

test('extension load failure is non-fatal health state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-load-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '2.3.1' }));
  const manager = new ExtensionManager({ userDataPath: root, env: { YOUTUBE_TRANSCRIPT_EXTENSION_PATH: root },
    sessionFromPartition: () => ({ loadExtension: async () => { throw new Error('loader failed'); } }) });
  await assert.rejects(manager.load(), error => error.code === 'EXTENSION_LOAD_FAILED');
  assert.equal(manager.health.status, HEALTH.LOAD_FAILED);
});

test('429 immediately falls back to extension with structured provider metadata', async () => {
  let direct = 0; let fallback = 0; const attempts = [];
  const chain = new TranscriptProviderChain({ fetchDirect: async () => { direct++; throw Object.assign(new Error('429'),
    { code: 'YOUTUBE_RATE_LIMITED', httpStatus: 429, retryableTranscriptTransport: true }); },
    extensionProvider: { extract: async () => { fallback++; return extensionResult; } } });
  const result = await chain.getTranscript({ track, metadata, onProviderAttempt: value => attempts.push(value) });
  assert.equal(direct, 1); assert.equal(fallback, 1); assert.deepEqual(attempts, ['DIRECT_CAPTION', 'EMBEDDED_EXTENSION']);
  assert.equal(result.transcriptProvider.provider, 'EMBEDDED_EXTENSION'); assert.equal(result.transcriptMetrics.directCaption429, 1);
});

test('non-transport no-caption result never invokes extension', async () => {
  let fallback = 0;
  const chain = new TranscriptProviderChain({ fetchDirect: async () => { throw Object.assign(new Error('none'), { code: 'TRANSCRIPT_UNAVAILABLE' }); },
    extensionProvider: { extract: async () => { fallback++; } } });
  await assert.rejects(chain.getTranscript({ track, metadata }), error => error.code === 'TRANSCRIPT_UNAVAILABLE');
  assert.equal(fallback, 0);
});

test('provider exhaustion includes both failures and cancellation stays cancellation', async () => {
  const directFailure = () => { throw Object.assign(new Error('network'), { code: 'NETWORK_ERROR', retryableTranscriptTransport: true }); };
  const chain = new TranscriptProviderChain({ fetchDirect: directFailure,
    extensionProvider: { extract: async () => { throw Object.assign(new Error('missing'), { code: 'EXTENSION_NOT_INSTALLED' }); } } });
  await assert.rejects(chain.getTranscript({ track, metadata }), error => error.code === 'TRANSCRIPT_PROVIDERS_EXHAUSTED' && error.providerFailures.length === 2);
  const cancelled = new TranscriptProviderChain({ fetchDirect: directFailure,
    extensionProvider: { extract: async () => { throw Object.assign(new Error('cancelled'), { code: 'ANALYSIS_CANCELLED' }); } } });
  await assert.rejects(cancelled.getTranscript({ track, metadata }), error => error.code === 'ANALYSIS_CANCELLED');
});

test('circuit breaker suppresses direct captions until cooldown probe', () => {
  let now = 1000; const breaker = new TimedTextCircuitBreaker({ threshold: 2, cooldownMs: 100, now: () => now });
  breaker.recordFailure({ httpStatus: 429 }); breaker.recordFailure({ httpStatus: 429 });
  assert.equal(breaker.shouldSkipDirect(), true); assert.equal(breaker.state().consecutive429, 2);
  now += 101; assert.equal(breaker.shouldSkipDirect(), false);
});

test('timestamp parsing handles hour form, derives ends, and rejects stale video DOM', () => {
  const rows = [{ timestamp: '0:05', text: ' First  words ' }, { timestamp: '1:02:15', text: 'Later' }];
  assert.deepEqual(parseDomSegments(rows, 3800), [
    { startSeconds: 5, endSeconds: 3735, text: 'First words' }, { startSeconds: 3735, endSeconds: 3800, text: 'Later' }
  ]);
  assert.deepEqual(transcriptForPage({ videoId: 'old', segments: rows }, metadata.videoId, 3800), []);
});

test('JSON report records transcript provider without raw transcript logging', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-report-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new ReportManager({ reportsDir: root });
  const output = manager.write({ videoId: 'abc123', revisionId: 'r1', sourceUrl: 'url', modelVersions: {}, analysisVersion: 'a', policyVersion: 'p' },
    { title: 'Title', durationSeconds: 5, overallDecision: 'KEEP', segmentJudgments: [], recommendedClips: [],
      transcriptProvider: extensionResult.transcriptProvider, visualStatus: 'READY', ocrStatus: 'READY' });
  assert.equal(output.report.transcriptProvider.provider, 'EMBEDDED_EXTENSION');
});

test('extension transcript preserves original YouTube URL for visual proxy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-visual-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chain = new TranscriptProviderChain({ fetchDirect: async () => { throw Object.assign(new Error('429'),
    { code: 'YOUTUBE_RATE_LIMITED', httpStatus: 429, retryableTranscriptTransport: true }); },
    extensionProvider: { extract: async () => extensionResult } });
  const ingestion = await new YouTubeIngestionService({ providerChain: chain, getRawMetadata: async () => ({
    id: metadata.videoId, title: 'Title', duration: 70, webpage_url: metadata.url,
    automatic_captions: { en: [{ ext: 'json3', url: 'timedtext' }] }
  }) }).ingest(metadata.url);
  let proxyUrl; let visualInvoked = false;
  const media = new VisualMediaService({ tempRoot: root, downloadProxy: async (url, workDir) => {
    proxyUrl = url; const file = path.join(workDir, 'proxy.mp4'); fs.writeFileSync(file, 'proxy'); return file;
  } });
  await media.withProxy(ingestion, {}, async () => { visualInvoked = true; });
  assert.equal(ingestion.metadata.videoId, metadata.videoId); assert.equal(ingestion.metadata.durationSeconds, 70);
  assert.equal(proxyUrl, metadata.url); assert.equal(visualInvoked, true);
});
