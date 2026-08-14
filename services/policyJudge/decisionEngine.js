const { normalizeText } = require('../policyKnowledge');

const DECISION_SOURCES = Object.freeze(['PRECHECK', 'DETERMINISTIC_POLICY_ENGINE', 'MULTIMODAL_POLICY_ENGINE', 'MODEL_FAILURE_FALLBACK']);

const VISUAL_POLICY_IDS = Object.freeze({
  weapon: 'TT25_CG_WEAPONS_001', blood: 'TT25_CG_GRAPHIC_002', graphic_injury: 'TT25_CG_GRAPHIC_001',
  nudity: 'TT25_CG_NUDITY_001', sexual_content: 'TT25_CG_SEXUAL_001', violent_act: 'TT25_CG_VIOLENCE_001',
  self_harm_visual: 'TT25_CG_SUICIDE_001', drug_or_regulated_goods: 'TT25_CG_REGULATED_001',
  personal_information: 'TT25_CG_PRIVACY_001', shocking_content: 'TT25_CG_SHOCKING_001'
});

function exceptionSupported(policy, finding, overallContext) {
  if (!finding.exceptionApplies) return false;
  const context = normalizeText(`${finding.context} ${overallContext}`).replace(/_/g, ' ');
  return [...policy.contextualAllowances, ...policy.exceptions]
    .some(value => context.includes(normalizeText(value)) || normalizeText(value).includes(context));
}

function result(decision, code, details = {}) {
  return { decision, decisionSource: 'DETERMINISTIC_POLICY_ENGINE', mappingReason: code, ...details };
}

function decideFromFindings(findingsOutput, candidatePolicies, config) {
  const byId = new Map(candidatePolicies.map(policy => [policy.id, policy]));
  const applicable = findingsOutput.findings
    .filter(finding => finding.applies)
    .map(finding => ({ finding, policy: byId.get(finding.policyId) }))
    .filter(item => item.policy)
    .map(item => ({ ...item, exceptionSupported: exceptionSupported(item.policy, item.finding, findingsOutput.overallContext) }));
  const publicInterestSupport = candidatePolicies.some(policy => policy.id === 'TT25_CG_PUBLIC_INTEREST_001')
    && ['news_reporting', 'documentary', 'educational', 'medical', 'prevention', 'recovery', 'quotation', 'criticism', 'counterspeech', 'satire', 'artistic'].includes(findingsOutput.overallContext)
    && findingsOutput.contextConfidence >= config.keepConfidence;
  const active = applicable.filter(item => !(
    item.policy.outcome.postability === 'PROHIBIT' && (item.exceptionSupported || publicInterestSupport)
  ));
  const forcedReviewCandidates = candidatePolicies.filter(policy =>
    ['graphic_content', 'shocking_content'].includes(policy.category)
    || (policy.outcome.postability === 'UNKNOWN' && policy.matchScore >= config.candidateMinScore)
  );
  const tracePolicies = [...new Map([...applicable.map(item => item.policy), ...forcedReviewCandidates].map(policy => [policy.id, policy])).values()];
  const categories = [...new Set(tracePolicies.map(policy => policy.category))];
  const policyIds = [...new Set(tracePolicies.map(policy => policy.id))];
  const confidence = applicable.length ? Math.min(...applicable.map(item => item.finding.applicabilityConfidence)) : findingsOutput.contextConfidence;
  const requiresVisualReview = findingsOutput.requiresVisualReview
    || applicable.some(item => item.finding.requiresVisualReview)
    || forcedReviewCandidates.some(policy => ['graphic_content', 'shocking_content'].includes(policy.category));
  const ageRestricted = active.some(item => item.policy.platformTreatment?.ageRestricted === true) || null;
  const detail = {
    confidence, categories, policyIds, appliedPolicies: applicable.map(item => ({
      policyId: item.policy.id,
      applicabilityConfidence: item.finding.applicabilityConfidence,
      exceptionApplied: item.exceptionSupported
    })),
    contextType: findingsOutput.overallContext,
    requiresVisualReview,
    postability: active.some(item => item.policy.outcome.postability === 'PROHIBIT') ? 'PROHIBIT'
      : active.some(item => item.policy.outcome.postability === 'RESTRICT') ? 'RESTRICT'
        : active.some(item => item.policy.outcome.postability === 'ALLOW') ? 'ALLOW' : 'UNKNOWN',
    fypEligibility: active.some(item => item.policy.outcome.fypEligibility === 'PROHIBIT') ? 'PROHIBIT'
      : active.some(item => item.policy.outcome.fypEligibility === 'RESTRICT') ? 'RESTRICT'
        : active.some(item => item.policy.outcome.fypEligibility === 'ALLOW') ? 'ALLOW' : 'UNKNOWN',
    monetization: active.some(item => item.policy.outcome.monetization === 'PROHIBIT') ? 'PROHIBIT'
      : active.some(item => item.policy.outcome.monetization === 'RESTRICT') ? 'RESTRICT'
        : active.some(item => item.policy.outcome.monetization === 'ALLOW') ? 'ALLOW' : 'UNKNOWN',
    ageRestricted
  };

  if (requiresVisualReview) return result('REVIEW', 'VISUAL_REVIEW_REQUIRED', detail);
  if (findingsOutput.insufficientEvidence || findingsOutput.overallContext === 'unclear' || findingsOutput.contextConfidence < 0.65) {
    return result('REVIEW', 'INSUFFICIENT_CONTEXT', detail);
  }
  if (forcedReviewCandidates.some(policy => policy.outcome.postability === 'UNKNOWN')) {
    return result('REVIEW', 'POSTABILITY_UNRESOLVED', detail);
  }
  if (applicable.some(item => item.policy.outcome.postability === 'UNKNOWN')) {
    return result('REVIEW', 'POSTABILITY_UNRESOLVED', detail);
  }

  const prohibited = active.filter(item => item.policy.outcome.postability === 'PROHIBIT');
  const allowed = active.filter(item => item.policy.outcome.postability === 'ALLOW');
  const conflict = prohibited.some(blocked => allowed.some(permitted => permitted.policy.category === blocked.policy.category));
  if (conflict) return result('REVIEW', 'CONFLICTING_POLICY_FINDINGS', detail);
  if (prohibited.some(item => item.finding.applicabilityConfidence >= config.removeConfidence)) {
    return result('REMOVE', 'POSTABILITY_PROHIBITED', detail);
  }
  if (prohibited.length) return result('REVIEW', 'PROHIBITED_POLICY_UNCERTAIN', detail);
  if (active.some(item => item.policy.outcome.fypEligibility === 'PROHIBIT')) return result('REVIEW', 'FYF_PROHIBITED', detail);
  if (ageRestricted) return result('REVIEW', 'AGE_RESTRICTED', detail);
  if (active.some(item => ['RESTRICT', 'UNKNOWN'].includes(item.policy.outcome.postability))) return result('REVIEW', 'POSTABILITY_UNRESOLVED', detail);
  if (active.some(item => item.finding.applicabilityConfidence < config.keepConfidence)) return result('REVIEW', 'APPLICABILITY_UNCERTAIN', detail);
  return result('KEEP', applicable.length ? 'NO_PROHIBITED_POLICY_APPLIES' : 'NO_POLICY_APPLIES', detail);
}

function mergeVisualFindings(textJudgment, frames, repository, config, visualStatus = 'AVAILABLE') {
  const visualFindings = frames.flatMap(frame => frame.findings.map(finding => ({
    ...finding, timestamp: frame.timestamp, frameId: frame.frameId
  })));
  const riskyOcr = frames.filter(frame => frame.ocr?.risk?.requiresJudge && !frame.ocr.duplicate);
  const unreadableOcr = frames.filter(frame => frame.ocrRequiredUnavailable);
  const ocrPolicies = [...new Map(riskyOcr.flatMap(frame => frame.ocr.policyCandidates || []).map(policy => [policy.id, policy])).values()];
  const evidence = {
    text: [...(textJudgment.policyIds || [])],
    visual: visualFindings.map(({ timestamp, frameId, category, confidence, severity }) => ({ timestamp, frameId, category, confidence, severity })),
    onScreenText: riskyOcr.map(frame => ({
      timestamp: frame.timestamp, frameId: frame.frameId, normalizedText: frame.ocr.normalizedText,
      categories: frame.ocr.risk.categories, policyIds: (frame.ocr.policyCandidates || []).map(policy => policy.id)
    }))
  };
  if (visualStatus !== 'AVAILABLE') {
    return {
      ...textJudgment, visualStatus, visualFindings, evidence,
      decision: textJudgment.requiresVisualReview ? 'REVIEW' : textJudgment.decision,
      reason: textJudgment.requiresVisualReview ? 'Visual verification unavailable.' : textJudgment.reason
    };
  }
  if (!visualFindings.length && (riskyOcr.length || unreadableOcr.length)) {
    return {
      ...textJudgment, decision: 'REVIEW', decisionSource: 'MULTIMODAL_POLICY_ENGINE',
      mappingReason: unreadableOcr.length ? 'OCR_REQUIRED_UNAVAILABLE' : 'ON_SCREEN_TEXT_REVIEW_REQUIRED',
      reason: unreadableOcr.length ? 'Material on-screen text could not be read locally.' : 'Potentially risky on-screen text requires policy review.',
      requiresVisualReview: true,
      policyIds: [...new Set([...(textJudgment.policyIds || []), ...ocrPolicies.map(policy => policy.id)])],
      categories: [...new Set([...(textJudgment.categories || []), ...ocrPolicies.map(policy => policy.category)])],
      visualStatus, visualFindings, evidence
    };
  }
  if (!visualFindings.length) {
    if (textJudgment.mappingReason !== 'VISUAL_REVIEW_REQUIRED') return { ...textJudgment, visualStatus, visualFindings, evidence };
    return {
      ...textJudgment, decision: 'KEEP', decisionSource: 'MULTIMODAL_POLICY_ENGINE', mappingReason: 'VISUAL_SAMPLE_CLEAR',
      reason: 'Sampled frames did not establish the transcript-indicated visual risk.', requiresVisualReview: false,
      visualStatus, visualFindings, evidence
    };
  }

  const records = visualFindings.map(finding => ({ finding, policy: repository.getPolicyById(VISUAL_POLICY_IDS[finding.category]) })).filter(item => item.policy);
  const uncertain = visualFindings.some(item => item.requiresHumanReview || item.severity === 'uncertain' || item.confidence < config.visualPolicyConfidence);
  const severe = records.filter(({ finding, policy }) =>
    policy.outcome.postability === 'PROHIBIT'
    && ['severe', 'extreme'].includes(finding.severity)
    && finding.confidence >= config.visualPolicyConfidence
    && !finding.requiresHumanReview
  );
  const controlledContext = ['news_reporting', 'documentary', 'educational', 'medical', 'prevention', 'recovery'].includes(textJudgment.contextType);
  const decision = textJudgment.decision === 'REMOVE' || (severe.length && !controlledContext) ? 'REMOVE' : 'REVIEW';
  const policyIds = [...new Set([...(textJudgment.policyIds || []), ...records.map(item => item.policy.id)])];
  const categories = [...new Set([...(textJudgment.categories || []), ...records.map(item => item.policy.category)])];
  return {
    ...textJudgment, decision, decisionSource: 'MULTIMODAL_POLICY_ENGINE',
    mappingReason: decision === 'REMOVE' ? 'VISUAL_POLICY_PROHIBITED' : uncertain ? 'VISUAL_EVIDENCE_UNCERTAIN' : 'VISUAL_POLICY_REVIEW',
    reason: decision === 'REMOVE' ? 'High-confidence prohibited visual evidence.' : 'Visual evidence requires policy or human review.',
    confidence: Math.min(textJudgment.confidence ?? 1, ...visualFindings.map(item => item.confidence)),
    requiresVisualReview: decision === 'REVIEW', policyIds, categories, visualStatus, visualFindings, evidence
  };
}

module.exports = { DECISION_SOURCES, VISUAL_POLICY_IDS, decideFromFindings, exceptionSupported, mergeVisualFindings };
