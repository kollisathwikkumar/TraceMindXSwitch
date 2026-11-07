/** Investigation states describe recorded progress, not confidence in model output. */
export const investigationStates = [
  'reported',
  'queued',
  'gathering_evidence',
  'forming_hypotheses',
  'planning_checks',
  'awaiting_approval',
  'executing_checks',
  'evaluating_evidence',
  'supported_finding',
  'verification',
  'verified',
  'failed',
  'unverified',
  'cancelled',
] as const;
export type InvestigationState = (typeof investigationStates)[number];

export const checkOutcomes = [
  'passed',
  'failed',
  'timed_out',
  'cancelled',
  'denied',
  'interrupted',
] as const;
export type CheckOutcome = (typeof checkOutcomes)[number];

const investigationStateSet: ReadonlySet<string> = new Set(investigationStates);

const transitions: Record<InvestigationState, readonly InvestigationState[]> = {
  reported: ['queued', 'cancelled'],
  queued: ['gathering_evidence', 'cancelled'],
  gathering_evidence: ['forming_hypotheses', 'unverified', 'cancelled'],
  forming_hypotheses: ['planning_checks', 'unverified', 'cancelled'],
  planning_checks: ['awaiting_approval', 'executing_checks', 'unverified', 'cancelled'],
  awaiting_approval: ['planning_checks', 'unverified', 'cancelled'],
  executing_checks: ['evaluating_evidence', 'unverified', 'cancelled'],
  evaluating_evidence: ['forming_hypotheses', 'supported_finding', 'unverified', 'cancelled'],
  supported_finding: ['verification', 'unverified', 'cancelled'],
  verification: ['verified', 'failed', 'unverified', 'cancelled'],
  verified: [],
  failed: [],
  unverified: [],
  cancelled: [],
};

/** Exposes the canonical legal next phases to UI code without duplicating the transition table. */
export function getAllowedInvestigationTransitions(
  current: InvestigationState
): readonly InvestigationState[] {
  if (!investigationStateSet.has(current)) {
    throw new Error(`Invalid investigation state: ${current}`);
  }
  return transitions[current];
}

/** The caller must derive check outcomes from recorded execution and explicit criteria. */
export function transitionInvestigation(
  current: InvestigationState,
  next: InvestigationState,
  outcome?: CheckOutcome
): InvestigationState {
  if (
    !investigationStateSet.has(current) ||
    !investigationStateSet.has(next) ||
    !transitions[current].includes(next)
  ) {
    throw new Error(`Invalid investigation transition: ${current} -> ${next}`);
  }
  if (next === 'verified' && outcome !== 'passed') {
    throw new Error('Verification requires a passed check');
  }
  if (next === 'failed' && outcome !== 'failed') {
    throw new Error('A failed verification requires a failed check');
  }
  return next;
}
