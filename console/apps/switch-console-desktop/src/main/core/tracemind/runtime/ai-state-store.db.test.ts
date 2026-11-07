import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TraceMindRuntimeAIAdvisory } from '@shared/core/tracemind/ai-investigation';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const {
  clearAllRuntimeAIEnabled,
  getRuntimeAILastFailureAt,
  getRuntimeAIEnabled,
  recordRuntimeAIAnalysisFailure,
  setRuntimeAIEnabled,
  getLatestRuntimeAIAdvisory,
  recordRuntimeAIAdvisory,
} = await import('./ai-state-store');

const auditId = '00000000-0000-4000-8000-000000000101';
const advisory: TraceMindRuntimeAIAdvisory = {
  schemaVersion: 1,
  id: '00000000-0000-4000-8000-000000000201',
  provider: 'openai-compatible',
  model: 'fixture-model',
  generatedAt: 1_730_000_000_000,
  projectId: 'project-1',
  auditId,
  evidenceRevision: 'rev-1',
  incidentIds: ['b'.repeat(64)],
  summary: 'An error cluster was observed.',
  summaryEvidenceIds: ['b'.repeat(64)],
  hypotheses: [
    {
      rank: 1,
      statement: 'A service returned an error.',
      confidence: 'low',
      rationale: 'One error was observed.',
      evidenceIds: ['b'.repeat(64)],
    },
  ],
  recommendations: [
    {
      rank: 1,
      action: 'Review the trace locally.',
      rationale: 'It may provide more evidence.',
      evidenceIds: ['b'.repeat(64)],
    },
  ],
  limitations: ['Advisory, not proof.'],
};

describe('TraceMind runtime AI state persistence', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('keeps provider egress disabled by default and scopes explicit consent to one audit', async () => {
    expect(await getRuntimeAIEnabled('project-1', auditId)).toBe(false);
    await setRuntimeAIEnabled('project-1', auditId, true);
    expect(await getRuntimeAIEnabled('project-1', auditId)).toBe(true);
    expect(await getRuntimeAIEnabled('project-1', '00000000-0000-4000-8000-000000000102')).toBe(
      false
    );
    await setRuntimeAIEnabled('project-1', auditId, false);
    expect(await getRuntimeAIEnabled('project-1', auditId)).toBe(false);
  });

  it('persists only a schema-valid latest advisory under the matching project and audit', async () => {
    expect(await getLatestRuntimeAIAdvisory('project-1', auditId)).toBeNull();
    await recordRuntimeAIAdvisory('project-1', auditId, advisory);
    expect(await getLatestRuntimeAIAdvisory('project-1', auditId)).toEqual(advisory);
    await expect(recordRuntimeAIAdvisory('project-2', auditId, advisory)).rejects.toThrow(
      'Runtime AI advisory project identity mismatch'
    );
    const unlinkedCitation: TraceMindRuntimeAIAdvisory = {
      ...advisory,
      summaryEvidenceIds: ['c'.repeat(64)],
    };
    await expect(recordRuntimeAIAdvisory('project-1', auditId, unlinkedCitation)).rejects.toThrow(
      /unlinked incident/
    );
  });

  it('revokes all persisted per-audit runtime consent when the provider is cleared', async () => {
    const otherAuditId = '00000000-0000-4000-8000-000000000102';
    await setRuntimeAIEnabled('project-1', auditId, true);
    await setRuntimeAIEnabled('project-2', otherAuditId, true);

    await clearAllRuntimeAIEnabled();

    expect(await getRuntimeAIEnabled('project-1', auditId)).toBe(false);
    expect(await getRuntimeAIEnabled('project-2', otherAuditId)).toBe(false);
  });

  it('stores only a bounded failure timestamp and clears it after a successful advisory', async () => {
    await recordRuntimeAIAnalysisFailure('project-1', auditId, 1_730_000_000_000);
    expect(await getRuntimeAILastFailureAt('project-1', auditId)).toBe(1_730_000_000_000);

    await recordRuntimeAIAdvisory('project-1', auditId, advisory);

    expect(await getRuntimeAILastFailureAt('project-1', auditId)).toBeNull();
  });
});
