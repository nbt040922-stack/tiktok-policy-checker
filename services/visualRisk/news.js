const crypto = require('node:crypto');
const { rawRisk } = require('../policyJudge/riskScreen');

const NEWS_SCENE_TYPES = Object.freeze({
  ANCHOR: 'ANCHOR', INTERVIEW: 'INTERVIEW', B_ROLL: 'B_ROLL', DOCUMENT: 'DOCUMENT',
  SCREENSHOT: 'SCREENSHOT', TEXT_HEAVY: 'TEXT_HEAVY', CHART_GRAPHIC: 'CHART_GRAPHIC', UNKNOWN: 'UNKNOWN'
});

const PRIVACY_PATTERNS = Object.freeze({
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  phone: /(?<!\d)(?:\+?\d[\s().-]*){8,15}(?!\d)/,
  address: /\b\d{1,6}\s+[A-Z0-9.' -]{2,40}\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr)\b/i,
  accountId: /\b(?:account|passport|license|licence|national id|ssn)\s*(?:number|no\.?|#|:)?\s*[A-Z0-9-]{5,}\b/i
});

function hashText(text) {
  return crypto.createHash('sha256').update(text.toLowerCase()).digest('hex');
}

function normalizeOcrOutput(output, timestamp, seen = new Set(), minimumConfidence = 0.5) {
  const unique = new Set();
  const lines = (output?.lines || []).flatMap(line => {
    const text = String(line.text || '').replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (key.length < 2 || unique.has(key) || Number(line.confidence) < minimumConfidence) return [];
    unique.add(key);
    return [{ text, confidence: Number(Number(line.confidence).toFixed(4)), box: line.box }];
  });
  const normalizedText = lines.map(line => line.text).join(' ').replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1').slice(0, 2000);
  const hash = normalizedText ? hashText(normalizedText.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()) : null;
  const duplicate = Boolean(hash && seen.has(hash));
  if (hash) seen.add(hash);
  return { timestamp, lines, normalizedText, hash, duplicate };
}

function screenOcrRisk(text) {
  const value = String(text || '');
  const privacySignals = Object.entries(PRIVACY_PATTERNS).filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
  const risk = rawRisk(value);
  const requiresJudge = privacySignals.length > 0 || (risk.requiresJudge && (!risk.benignContext || risk.score >= 7));
  const categories = [...new Set([...risk.matchedCategories, ...(privacySignals.length ? ['personal_information', 'privacy'] : [])])];
  return { ...risk, privacySignals, categories, requiresJudge };
}

function refineTextScene(sceneType, ocr, signals = {}) {
  if (!ocr?.normalizedText) return sceneType;
  const text = ocr.normalizedText;
  if (/(?:https?:\/\/|www\.|@[a-z0-9_]{2,}|\b(?:tweet|posted|replied)\b)/i.test(text)) return NEWS_SCENE_TYPES.SCREENSHOT;
  if ((text.match(/(?:\$|%|\b\d+(?:\.\d+)?\b)/g) || []).length >= 4) return NEWS_SCENE_TYPES.CHART_GRAPHIC;
  if (ocr.lines.length >= 7 || text.length >= 240) return NEWS_SCENE_TYPES.DOCUMENT;
  if (signals.skinRatio >= 0.16) return NEWS_SCENE_TYPES.INTERVIEW;
  if (signals.skinRatio >= 0.08) return NEWS_SCENE_TYPES.ANCHOR;
  if (ocr.lines.length >= 3) return NEWS_SCENE_TYPES.TEXT_HEAVY;
  return sceneType;
}

function classifyNewsScene({ signals, hashDistance = null, overlayDistance = null, sceneCut = false, config }) {
  if (signals.textHeavy) return NEWS_SCENE_TYPES.TEXT_HEAVY;
  if (signals.skinRatio >= config.newsInterviewSkinMin) return NEWS_SCENE_TYPES.INTERVIEW;
  if (sceneCut || (hashDistance !== null && hashDistance > config.newsStateHashDistance)) return NEWS_SCENE_TYPES.B_ROLL;
  const stable = hashDistance !== null && hashDistance <= config.newsAnchorHashDistance
    && overlayDistance !== null && overlayDistance <= config.newsOverlayHashDistance;
  if (stable && signals.skinRatio >= config.newsAnchorSkinMin) {
    return signals.skinRatio >= config.newsInterviewSkinMin ? NEWS_SCENE_TYPES.INTERVIEW : NEWS_SCENE_TYPES.ANCHOR;
  }
  if (signals.complexObject && signals.skinRatio < config.newsAnchorSkinMin) return NEWS_SCENE_TYPES.B_ROLL;
  return NEWS_SCENE_TYPES.UNKNOWN;
}

function shouldRunGemma({ sceneType, cheapSignals, textNeedsVision, riskyOcr, ocrUnavailable, previousState, timestamp, sceneChanged, overlayChanged, middleFrame, config }) {
  if (textNeedsVision) return 'text policy requires visual confirmation';
  if (cheapSignals.possibleBlood || cheapSignals.possibleNudity) return 'potential graphic visual signal';
  if (riskyOcr) return 'risky on-screen text requires visual context';
  if (sceneType === NEWS_SCENE_TYPES.B_ROLL) return 'new B-roll or major visual change';
  if ([NEWS_SCENE_TYPES.DOCUMENT, NEWS_SCENE_TYPES.SCREENSHOT, NEWS_SCENE_TYPES.TEXT_HEAVY].includes(sceneType) && ocrUnavailable) return 'important on-screen text unavailable to OCR';
  if ([NEWS_SCENE_TYPES.ANCHOR, NEWS_SCENE_TYPES.INTERVIEW].includes(sceneType)) {
    if (!previousState?.lastSemanticReview) return 'first stable presenter representative';
    if (sceneChanged || overlayChanged) return 'stable presenter state invalidated';
    if (timestamp - previousState.lastSemanticReview >= config.newsAnchorRefreshSeconds) return 'stable presenter refresh interval';
    return null;
  }
  if ([NEWS_SCENE_TYPES.DOCUMENT, NEWS_SCENE_TYPES.SCREENSHOT, NEWS_SCENE_TYPES.TEXT_HEAVY, NEWS_SCENE_TYPES.CHART_GRAPHIC].includes(sceneType)) return null;
  return cheapSignals.escalate || middleFrame ? 'conservative UNKNOWN fallback' : null;
}

module.exports = {
  NEWS_SCENE_TYPES, classifyNewsScene, hashText, normalizeOcrOutput, refineTextScene,
  screenOcrRisk, shouldRunGemma
};
