const { normalizeText } = require('../policyKnowledge');

const DECISION_SOURCES = Object.freeze(['PRECHECK', 'DETERMINISTIC_POLICY_ENGINE', 'MODEL_FAILURE_FALLBACK']);

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

module.exports = { DECISION_SOURCES, decideFromFindings, exceptionSupported };
