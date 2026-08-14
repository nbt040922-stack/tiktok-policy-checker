const DEFAULT_SEGMENT_OPTIONS = Object.freeze({
  minDurationSeconds: 12,
  maxDurationSeconds: 45,
  maxTextLength: 500,
  maxGapSeconds: 2.5
});

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function timestampToSeconds(value) {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return NaN;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

function parseVtt(input) {
  const blocks = String(input || '').replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex === -1) continue;
    const match = lines[timingIndex].match(/^(\S+)\s+-->\s+(\S+)/);
    if (!match) continue;
    const startSeconds = timestampToSeconds(match[1]);
    const endSeconds = timestampToSeconds(match[2]);
    const text = cleanText(lines.slice(timingIndex + 1).join(' '));
    if (Number.isFinite(startSeconds) && endSeconds > startSeconds && text) {
      cues.push({ startSeconds, endSeconds, text });
    }
  }
  if (!cues.length) throw new Error('Invalid or empty VTT subtitle.');
  return cues;
}

function parseJson3(input) {
  let data;
  try {
    data = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (_) {
    throw new Error('Invalid JSON subtitle.');
  }
  if (!Array.isArray(data?.events)) throw new Error('Invalid JSON3 subtitle.');
  const cues = data.events.flatMap(event => {
    const startSeconds = Number(event.tStartMs) / 1000;
    const durationSeconds = Number(event.dDurationMs) / 1000;
    const text = cleanText((event.segs || []).map(segment => segment.utf8 || '').join(''));
    return Number.isFinite(startSeconds) && durationSeconds > 0 && text
      ? [{ startSeconds, endSeconds: startSeconds + durationSeconds, text }]
      : [];
  });
  if (!cues.length) throw new Error('Invalid or empty JSON3 subtitle.');
  return cues;
}

function normalizeCues(rawCues) {
  const sorted = rawCues
    .map(cue => ({
      startSeconds: Number(cue.startSeconds),
      endSeconds: Number(cue.endSeconds),
      text: cleanText(cue.text)
    }))
    .filter(cue => Number.isFinite(cue.startSeconds) && cue.endSeconds > cue.startSeconds && cue.text)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);

  const result = [];
  for (const cue of sorted) {
    const previous = result[result.length - 1];
    if (!previous) {
      result.push(cue);
      continue;
    }
    const overlaps = cue.startSeconds <= previous.endSeconds + 0.25;
    if (overlaps && cue.text === previous.text) {
      previous.endSeconds = Math.max(previous.endSeconds, cue.endSeconds);
    } else if (overlaps && cue.text.startsWith(previous.text + ' ')) {
      previous.text = cue.text;
      previous.endSeconds = Math.max(previous.endSeconds, cue.endSeconds);
    } else if (overlaps && previous.text.startsWith(cue.text + ' ')) {
      previous.endSeconds = Math.max(previous.endSeconds, cue.endSeconds);
    } else {
      result.push(cue);
    }
  }
  return result;
}

function segmentTranscript(cues, options = {}) {
  const settings = { ...DEFAULT_SEGMENT_OPTIONS, ...options };
  const segments = [];
  let current = null;
  const flush = () => {
    if (current) segments.push(current);
    current = null;
  };

  for (const cue of normalizeCues(cues)) {
    const gap = current ? cue.startSeconds - current.endSeconds : 0;
    const combinedDuration = current ? cue.endSeconds - current.startSeconds : 0;
    const combinedLength = current ? current.text.length + 1 + cue.text.length : 0;
    if (current && (gap > settings.maxGapSeconds || combinedDuration > settings.maxDurationSeconds || combinedLength > settings.maxTextLength)) flush();

    if (!current) current = { ...cue };
    else {
      current.endSeconds = Math.max(current.endSeconds, cue.endSeconds);
      current.text += ` ${cue.text}`;
    }

    if (current.endSeconds - current.startSeconds >= settings.minDurationSeconds && /[.!?]["']?$/.test(cue.text)) flush();
  }
  flush();
  return segments;
}

module.exports = {
  DEFAULT_SEGMENT_OPTIONS,
  cleanText,
  normalizeCues,
  parseJson3,
  parseVtt,
  segmentTranscript,
  timestampToSeconds
};
