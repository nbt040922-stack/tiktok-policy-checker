const test = require('node:test');
const assert = require('node:assert/strict');

const {
  YouTubeIngestionService,
  fetchSubtitle,
  normalizeMetadata,
  selectSubtitleTrack
} = require('../services/youtube');
const {
  normalizeCues,
  parseJson3,
  parseVtt,
  segmentTranscript
} = require('../services/youtube/transcript');

const json3 = JSON.stringify({ events: [
  { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world.' }] },
  { tStartMs: 3500, dDurationMs: 1500, segs: [{ utf8: 'Next cue.' }] }
] });

test('metadata parser returns required normalized fields', () => {
  assert.deepEqual(normalizeMetadata({ id: 'abc', title: 'Title', duration: 92.5, channel: 'Channel', thumbnail: 'thumb' }, 'url'), {
    videoId: 'abc', url: 'url', title: 'Title', durationSeconds: 92.5, channelName: 'Channel', thumbnailUrl: 'thumb'
  });
  assert.throws(() => normalizeMetadata({ id: 'abc' }, 'url'), /malformed/);
});

test('subtitle priority prefers manual English then automatic English', () => {
  const manual = { subtitles: { en: [{ ext: 'vtt', url: 'manual' }] }, automatic_captions: { en: [{ ext: 'json3', url: 'auto' }] } };
  assert.deepEqual(selectSubtitleTrack(manual), { language: 'en', source: 'manual', ext: 'vtt', url: 'manual' });
  const automatic = { automatic_captions: { 'en-US': [{ ext: 'json3', url: 'auto' }] } };
  assert.equal(selectSubtitleTrack(automatic).source, 'automatic');
  assert.throws(() => selectSubtitleTrack({}), error => error.code === 'TRANSCRIPT_UNAVAILABLE');
});

test('JSON3 and VTT subtitle parsers preserve timestamps and wording', () => {
  assert.deepEqual(parseJson3(json3)[0], { startSeconds: 1, endSeconds: 3, text: 'Hello world.' });
  const vtt = `WEBVTT\n\n00:01.000 --> 00:03.500\nHello   world.\n\n00:04.000 --> 00:05.000 align:start\nNext cue.`;
  assert.deepEqual(parseVtt(vtt), [
    { startSeconds: 1, endSeconds: 3.5, text: 'Hello world.' },
    { startSeconds: 4, endSeconds: 5, text: 'Next cue.' }
  ]);
});

test('rolling auto-caption duplicates collapse without paraphrasing', () => {
  const cues = normalizeCues([
    { startSeconds: 0, endSeconds: 2, text: 'hello' },
    { startSeconds: 1.5, endSeconds: 3, text: 'hello world' },
    { startSeconds: 2.8, endSeconds: 4, text: 'hello world' },
    { startSeconds: 4.5, endSeconds: 6, text: 'next sentence' }
  ]);
  assert.deepEqual(cues, [
    { startSeconds: 0, endSeconds: 4, text: 'hello world' },
    { startSeconds: 4.5, endSeconds: 6, text: 'next sentence' }
  ]);
});

test('segmentation honors sentence, continuity, duration, and text bounds', () => {
  const cues = Array.from({ length: 10 }, (_, index) => ({
    startSeconds: index * 5,
    endSeconds: index * 5 + 4,
    text: index % 3 === 2 ? `Sentence ${index}.` : `words ${index}`
  }));
  const segments = segmentTranscript(cues, { minDurationSeconds: 10, maxDurationSeconds: 20, maxTextLength: 80, maxGapSeconds: 2 });
  assert.ok(segments.length >= 3);
  assert.ok(segments.every(segment => segment.endSeconds - segment.startSeconds <= 20));
  assert.ok(segments.every(segment => segment.text.length <= 80));
});

test('malformed subtitle becomes safe ingestion error', async () => {
  const response = { ok: true, status: 200, text: async () => 'not json' };
  await assert.rejects(fetchSubtitle({ ext: 'json3', url: 'subtitle' }, async () => response), error => {
    assert.equal(error.code, 'INGESTION_ERROR');
    assert.match(error.message, /malformed/);
    return true;
  });
});

test('temporary subtitle rate limit remains retryable', async () => {
  await assert.rejects(fetchSubtitle(
    { ext: 'json3', url: 'subtitle' },
    async () => ({ ok: false, status: 429 })
  ), error => error.code === 'YOUTUBE_RATE_LIMITED' && error.httpStatus === 429 && error.retryableTranscriptTransport);
});

test('ingestion reports no transcript without downloading media', async () => {
  const service = new YouTubeIngestionService({
    getRawMetadata: async () => ({ id: 'abc', title: 'Title', duration: 100 }),
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  await assert.rejects(service.ingest('url'), error => error.code === 'TRANSCRIPT_UNAVAILABLE');
});

test('ingestion returns normalized cues and analysis segments', async () => {
  const stages = [];
  const service = new YouTubeIngestionService({
    getRawMetadata: async () => ({
      id: 'abc', title: 'Title', duration: 100,
      subtitles: { en: [{ ext: 'json3', url: 'subtitle' }] }
    }),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => json3 })
  });
  const result = await service.ingest('url', { onStage: stage => stages.push(stage) });
  assert.deepEqual(stages, ['metadata', 'transcript']);
  assert.equal(result.transcriptSource, 'manual');
  assert.equal(result.transcriptCues.length, 2);
  assert.ok(result.transcriptSegments.length > 0);
});
