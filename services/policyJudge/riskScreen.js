const { normalizeText } = require('../policyKnowledge');

const CATEGORY_SIGNALS = Object.freeze({
  violence: ['violent threat', 'physical harm', 'murder', 'shoot', 'stab', 'attack', 'kill'],
  graphic_content: ['graphic injury', 'dismemberment', 'dead body', 'violent death', 'blood', 'gore', 'torture'],
  self_harm: ['self harm', 'self injury', 'cut myself', 'hurt myself', 'recovery', 'warning signs', 'seek help'],
  suicide: ['suicide', 'suicidal', 'end my life', 'take my life'],
  harassment: ['targeted insult', 'sexual harassment', 'doxing', 'coordinated abuse', 'harassment'],
  bullying: ['bullying', 'private figure', 'targeted profanity', 'worthless'],
  hate_speech: ['hate speech', 'protected group', 'slur', 'dehumanize', 'supremacy', 'subhuman'],
  sexual_content: ['sexual activity', 'sexual service', 'sexual health', 'sexual abuse', 'sexualized behavior', 'sexualized framing', 'non consensual', 'fetish'],
  nudity: ['nudity', 'nude', 'intimate body parts', 'body exposure'],
  minor_safety: ['child abuse', 'youth exploitation', 'grooming', 'sextortion', 'minor safety', 'under 16', 'minor'],
  dangerous_activities: ['dangerous challenge', 'dangerous stunt', 'risky driving', 'harmful act'],
  weapons: ['firearm', 'gun', 'weapon', 'bomb', 'explosive'],
  regulated_goods: ['regulated goods', 'sell alcohol', 'sell firearms', 'gambling', 'counterfeit goods'],
  drugs: ['cannabis', 'marijuana', 'tobacco', 'cocaine', 'heroin', 'meth', 'drug'],
  fraud: ['scam', 'fraud', 'phishing', 'identity theft', 'money mule'],
  privacy: ['private data', 'personal data', 'privacy harm', 'stalking'],
  personal_information: ['personal information', 'home address', 'phone number', 'doxing'],
  misinformation: ['misinformation', 'fake cure', 'conspiracy theory', 'deepfake', 'fabricated claim'],
  civic_integrity: ['election misinformation', 'voter eligibility', 'vote location', 'election result', 'ballot', 'voter intimidation', 'election', 'voting'],
  illegal_activity: ['malware', 'hack account', 'steal login', 'human trafficking', 'human smuggling'],
  spam: ['fake engagement', 'bot accounts', 'buy followers', 'undisclosed ad'],
  unoriginal_content: ['unoriginal content', 'reused clip', 'watermark', 'minimal edit', 'repost'],
  intellectual_property: ['copyright', 'trademark', 'intellectual property', 'stolen content'],
  disordered_eating: ['disordered eating', 'starving', 'purging', 'extreme weight loss'],
  animal_abuse: ['animal abuse', 'animal cruelty', 'animal fight', 'poaching']
});

const GENERIC_SIGNALS = new Set(['attack', 'kill', 'gun', 'weapon', 'bomb', 'blood', 'drug', 'recovery', 'watermark', 'ballot', 'minor']);
const HIGH_SENSITIVITY_SIGNALS = new Set(['suicide', 'suicidal', 'grooming', 'nudity', 'phishing', 'doxing', 'sextortion']);
const ACTION_PATTERNS = [
  /\b(?:i will|i am going to|you should|we should)\s+(?:kill|shoot|stab|attack|hurt)\b/,
  /\b(?:how to|step by step|instructions?|method|plan)\b.*\b(?:suicide|self harm|kill|weapon|bomb|hack|fraud)\b/,
  /\b(?:buy|sell|ship|order)\b.*\b(?:gun|firearm|drug|cocaine|heroin|alcohol|counterfeit)\b/
];
const BENIGN_PATTERNS = [
  /\b(?:discuss|report|documentary|history|historical|educat|prevent|recover|support|awareness|critic|condemn|debunk|court|police|medical|news|quoted?|research)\w*\b/,
  /\b(?:without promoting|without instructions|seek help|professional advice|public interest)\b/
];

function rawRisk(text) {
  const normalized = normalizeText(text);
  const contains = signal => ` ${normalized} `.includes(` ${signal} `);
  const matchedCategories = [];
  const matchedSignals = [];
  let score = 0;
  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    const matches = signals.filter(contains);
    if (!matches.length) continue;
    matchedCategories.push(category);
    matchedSignals.push(...matches);
    score += Math.max(...matches.map(signal => signal.includes(' ') || HIGH_SENSITIVITY_SIGNALS.has(signal) ? 4 : GENERIC_SIGNALS.has(signal) ? 1 : 3));
  }
  if (ACTION_PATTERNS.some(pattern => pattern.test(normalized))) score += 4;
  const benignContext = BENIGN_PATTERNS.some(pattern => pattern.test(normalized));
  if (benignContext && score > 0) score = Math.max(1, score - 1);
  const riskSignal = score >= 7 ? 'HIGH' : score >= 3 ? 'MEDIUM' : score > 0 ? 'LOW' : 'NONE';
  return { riskSignal, matchedCategories: [...new Set(matchedCategories)], matchedSignals: [...new Set(matchedSignals)], score, benignContext, requiresJudge: score >= 3 };
}

function screenTranscript(segments) {
  const raw = segments.map(segment => rawRisk(segment.text));
  return raw.map((risk, index) => {
    if (risk.requiresJudge) return { ...risk, neighborRisk: false };
    const neighborRisk = [raw[index - 1], raw[index + 1]].some(item => ['MEDIUM', 'HIGH'].includes(item?.riskSignal));
    return neighborRisk
      ? { ...risk, riskSignal: risk.riskSignal === 'NONE' ? 'LOW' : risk.riskSignal, requiresJudge: true, neighborRisk: true }
      : { ...risk, neighborRisk: false };
  });
}

module.exports = { CATEGORY_SIGNALS, rawRisk, screenTranscript };
