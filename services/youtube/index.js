const { normalizeCues, parseJson3, parseVtt, segmentTranscript } = require('./transcript');

const ERROR_MESSAGES = Object.freeze({
  VIDEO_UNAVAILABLE: 'Video is unavailable.',
  TRANSCRIPT_UNAVAILABLE: 'Transcript unavailable for this video.',
  AUTH_REQUIRED: 'YouTube sign-in is required for this video.',
  NETWORK_ERROR: 'Unable to reach YouTube. Check your connection and retry.',
  INGESTION_ERROR: 'Unable to read video data.',
  CANCELLED: 'Analysis was cancelled.'
});

class YouTubeIngestionError extends Error {
  constructor(code, message = ERROR_MESSAGES[code]) {
    super(message || ERROR_MESSAGES.INGESTION_ERROR);
    this.name = 'YouTubeIngestionError';
    this.code = code;
  }
}

function classifyIngestionError(error) {
  if (error instanceof YouTubeIngestionError) return error;
  const message = String(error?.message || error || '');
  if (error?.name === 'AbortError' || /cancelled|canceled/i.test(message)) return new YouTubeIngestionError('CANCELLED');
  if (/sign in|login required|authentication|required cookies|private video|age.restrict/i.test(message)) return new YouTubeIngestionError('AUTH_REQUIRED');
  if (/unavailable|removed|does not exist|not available/i.test(message)) return new YouTubeIngestionError('VIDEO_UNAVAILABLE');
  if (/network|timed? out|ENOTFOUND|ECONN|unable to download|HTTP Error 429/i.test(message)) return new YouTubeIngestionError('NETWORK_ERROR');
  return new YouTubeIngestionError('INGESTION_ERROR');
}

function normalizeMetadata(raw, requestedUrl) {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.title || !Number.isFinite(Number(raw.duration))) {
    throw new YouTubeIngestionError('INGESTION_ERROR', 'YouTube metadata was malformed.');
  }
  return {
    videoId: String(raw.id),
    url: raw.webpage_url || requestedUrl,
    title: String(raw.title),
    durationSeconds: Number(raw.duration),
    channelName: String(raw.channel || raw.uploader || ''),
    thumbnailUrl: String(raw.thumbnail || '')
  };
}

function languageOrder(language) {
  const value = language.toLowerCase();
  if (value === 'en') return 0;
  if (/^en[-_]/.test(value)) return 1;
  return 2;
}

function bestFormat(formats) {
  const supported = (formats || []).filter(format => format?.url && ['json3', 'vtt'].includes(format.ext));
  return supported.sort((a, b) => (a.ext === 'json3' ? 0 : 1) - (b.ext === 'json3' ? 0 : 1))[0] || null;
}

function selectSubtitleTrack(rawMetadata) {
  const groups = [
    { tracks: rawMetadata.subtitles, source: 'manual', englishOnly: true },
    { tracks: rawMetadata.automatic_captions, source: 'automatic', englishOnly: true },
    { tracks: rawMetadata.subtitles, source: 'manual', englishOnly: false },
    { tracks: rawMetadata.automatic_captions, source: 'automatic', englishOnly: false }
  ];
  for (const group of groups) {
    const languages = Object.keys(group.tracks || {})
      .filter(language => !group.englishOnly || /^en(?:[-_]|$)/i.test(language))
      .sort((a, b) => languageOrder(a) - languageOrder(b) || a.localeCompare(b));
    for (const language of languages) {
      const format = bestFormat(group.tracks[language]);
      if (format) return { language, source: group.source, ext: format.ext, url: format.url };
    }
  }
  throw new YouTubeIngestionError('TRANSCRIPT_UNAVAILABLE');
}

async function fetchSubtitle(track, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(track.url, { signal });
  } catch (error) {
    throw classifyIngestionError(error);
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new YouTubeIngestionError('AUTH_REQUIRED');
    throw new YouTubeIngestionError(response.status >= 500 ? 'NETWORK_ERROR' : 'TRANSCRIPT_UNAVAILABLE');
  }
  const body = await response.text();
  try {
    return track.ext === 'json3' ? parseJson3(body) : parseVtt(body);
  } catch (_) {
    throw new YouTubeIngestionError('INGESTION_ERROR', 'Transcript data was malformed.');
  }
}

class YouTubeIngestionService {
  constructor({ getRawMetadata, fetchImpl = globalThis.fetch, segmentOptions } = {}) {
    if (typeof getRawMetadata !== 'function') throw new TypeError('getRawMetadata is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');
    this.getRawMetadata = getRawMetadata;
    this.fetchImpl = fetchImpl;
    this.segmentOptions = segmentOptions;
  }

  async ingest(url, { cookiesPath, onStage = () => {}, signal } = {}) {
    try {
      onStage('metadata');
      const rawMetadata = await this.getRawMetadata(url, cookiesPath, signal);
      const metadata = normalizeMetadata(rawMetadata, url);
      const track = selectSubtitleTrack(rawMetadata);
      onStage('transcript');
      const transcriptCues = normalizeCues(await fetchSubtitle(track, this.fetchImpl, signal));
      const transcriptSegments = segmentTranscript(transcriptCues, this.segmentOptions);
      if (!transcriptSegments.length) throw new YouTubeIngestionError('TRANSCRIPT_UNAVAILABLE');
      return { metadata, transcriptCues, transcriptSegments, transcriptLanguage: track.language, transcriptSource: track.source };
    } catch (error) {
      throw classifyIngestionError(error);
    }
  }
}

module.exports = {
  ERROR_MESSAGES,
  YouTubeIngestionError,
  YouTubeIngestionService,
  classifyIngestionError,
  fetchSubtitle,
  normalizeMetadata,
  selectSubtitleTrack
};
