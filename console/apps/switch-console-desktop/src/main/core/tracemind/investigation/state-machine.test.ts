import { describe, expect, it } from 'vitest';
import {
  getAllowedInvestigationTransitions,
  investigationStates,
  transitionInvestigation,
  type InvestigationState,
} from './state-machine';

describe('investigation transitions', () => {
  it('exposes every canonical transition row for UI consumers', () => {
    const expected: Record<InvestigationState, readonly InvestigationState[]> = {
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
    for (const state of investigationStates) {
      expect(getAllowedInvestigationTransitions(state)).toEqual(expected[state]);
    }
    expect(() => getAllowedInvestigationTransitions('invalid' as never)).toThrow(
      'Invalid investigation state'
    );
  });

  it('allows a documented transition and rejects an invalid one', () => {
    expect(transitionInvestigation('reported', 'queued')).toBe('queued');
    expect(() => transitionInvestigation('reported', 'verified')).toThrow(
      'Invalid investigation transition'
    );
    expect(() => transitionInvestigation('invalid' as never, 'queued')).toThrow(
      'Invalid investigation transition'
    );
  });

  it('requires a passed check to verify', () => {
    for (const outcome of ['failed', 'timed_out', 'cancelled', 'denied', 'interrupted'] as const) {
      expect(() => transitionInvestigation('verification', 'verified', outcome)).toThrow();
    }
    expect(() => transitionInvestigation('verification', 'verified')).toThrow();
    expect(transitionInvestigation('verification', 'verified', 'passed')).toBe('verified');
  });

  it('distinguishes failed and inconclusive checks', () => {
    expect(transitionInvestigation('verification', 'failed', 'failed')).toBe('failed');
    expect(transitionInvestigation('verification', 'unverified', 'timed_out')).toBe('unverified');
    expect(() => transitionInvestigation('verification', 'failed', 'passed')).toThrow();
  });
});
