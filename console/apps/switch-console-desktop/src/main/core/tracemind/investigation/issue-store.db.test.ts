import { openFixture } from '@tooling/utils/db';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import * as schema from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));

const {
  MAX_ISSUE_EVENTS,
  appendIssueEvent,
  appendIssueCheckResult,
  createIssue,
  getIssue,
  listIssueEvents,
  listIssues,
  markIssueEvidenceStale,
  reviewIssueEvidence,
  recordAIInvestigation,
  transitionIssue,
  transitionIssueInvestigation,
  updateIssue,
  updateIssueMetadata,
} = await import('./issue-store');
const { saveAudit } = await import('../audit/audit-store');
const { appendGraphRecordBounded, getGraphSnapshot, markGraphStale, saveGraphSnapshot } =
  await import('../graph/graph-store');
const { generateInvestigationReport } = await import('./report');

describe('TraceMind issue persistence', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('links an issue only to an audit in the same project and persists edits', async () => {
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const issue = await createIssue('project-1', {
      title: 'Bug',
      description: '',
      auditId: audit.id,
    });
    expect((await getIssue('project-1', issue.id))?.auditId).toBe(audit.id);
    await expect(
      createIssue('project-2', { title: 'Bug', description: '', auditId: audit.id })
    ).rejects.toThrow('audit');
    await expect(
      updateIssue('project-2', issue.id, 1, { title: 'Bug', description: '', auditId: audit.id })
    ).rejects.toThrow();
    await expect(
      updateIssue('project-1', issue.id, 1, {
        title: 'Bug',
        description: '',
        auditId: '00000000-0000-4000-8000-000000000000',
      })
    ).rejects.toThrow('audit');
    expect((await getIssue('project-1', issue.id))?.auditId).toBe(audit.id);
    const unlinked = await updateIssue('project-1', issue.id, 1, {
      title: 'Bug',
      description: '',
      auditId: null,
    });
    expect(unlinked.auditId).toBeNull();
    expect((await listIssues('project-1'))[0]?.auditId).toBeNull();
  });

  it('persists, lists and edits a project-scoped issue', async () => {
    const created = await createIssue('project-1', {
      title: 'Broken test',
      description: 'Expected success',
    });
    expect(created).toMatchObject({ locationId: 'project-1', title: 'Broken test', version: 1 });
    expect(await getIssue('project-1', created.id)).toEqual(created);
    expect(await listIssues('project-1')).toEqual([created]);
    expect(await listIssues('project-2')).toEqual([]);
    expect(await getIssue('project-2', created.id)).toBeNull();
    const edited = await updateIssue('project-1', created.id, 1, {
      title: 'Updated',
      description: 'Observed failure',
    });
    expect(edited).toMatchObject({ id: created.id, title: 'Updated', version: 2 });
    expect(await getIssue('project-1', created.id)).toEqual(edited);
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await getIssue('project-1', created.id)).toEqual(edited);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });

  it('persists a cited AI investigation snapshot without changing issue lifecycle or resolution', async () => {
    const issue = await createIssue('project-1', {
      title: 'Slow response',
      description: 'A request sometimes takes too long.',
    });
    const evidenceId = 'ev_issue_description';
    const result = {
      schemaVersion: 1 as const,
      id: '70000000-0000-4000-8000-000000000042',
      provider: 'openai-compatible' as const,
      model: 'example-model',
      generatedAt: 123,
      evidenceRevision: null,
      freshness: 'unknown' as const,
      summary: 'The issue description points to intermittent latency.',
      summaryEvidenceIds: [evidenceId],
      hypotheses: [
        {
          rank: 1,
          statement: 'A downstream request may be slow.',
          confidence: 'low' as const,
          rationale: 'The issue is intermittent, but no trace is attached.',
          evidenceIds: [evidenceId],
        },
      ],
      recommendations: [
        {
          rank: 1,
          action: 'Capture a request trace during a slow occurrence.',
          rationale: 'A trace would distinguish local delay from downstream latency.',
          evidenceIds: [evidenceId],
        },
      ],
      limitations: ['No runtime trace was available.'],
      evidenceReferences: [
        {
          id: evidenceId,
          kind: 'issue' as const,
          label: 'Issue description',
          path: null,
          startLine: null,
          endLine: null,
          revision: null,
          freshness: 'unknown' as const,
          certainty: 'recorded' as const,
          provenance: 'issue-store',
          extractionMethod: 'structured issue record',
        },
      ],
    };
    const recorded = await recordAIInvestigation(
      'project-1',
      issue.id,
      issue.version,
      issue.currentRevision,
      result
    );
    expect(recorded.issue).toMatchObject({
      id: issue.id,
      version: issue.version + 1,
      status: 'open',
      investigationState: 'reported',
      resolutionRationale: null,
      resolvedAt: null,
    });
    expect(recorded.event).toMatchObject({
      type: 'ai_investigation',
      evidenceKind: 'inference',
      aiInvestigation: result,
    });
    await expect(
      recordAIInvestigation('project-1', issue.id, issue.version, issue.currentRevision, result)
    ).rejects.toThrow('changed');

    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      const storedEvents = await listIssueEvents('project-1', issue.id);
      expect(storedEvents.at(-1)?.aiInvestigation).toEqual(result);
      const report = await generateInvestigationReport('project-1', issue.id);
      expect(report?.aiInvestigations).toHaveLength(1);
      expect(report?.markdown).toContain('AI-generated investigation suggestions (advisory only)');
      expect(report?.markdown).toContain('A downstream request may be slow.');
      expect(report?.markdown).toContain(evidenceId);
      expect(report?.markdown).toContain('not proof or an issue resolution');
      expect((await getIssue('project-1', issue.id))?.status).toBe('open');
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });

  it('rejects stale edits and invalid project identifiers', async () => {
    const issue = await createIssue('project-1', { title: 'Bug', description: '' });
    await updateIssue('project-1', issue.id, 1, { title: 'First', description: '' });
    await expect(
      updateIssue('project-1', issue.id, 1, { title: 'Second', description: '' })
    ).rejects.toThrow('changed');
    await expect(createIssue('bad:scope', { title: 'Bug', description: '' })).rejects.toThrow();
    await expect(createIssue('project-1', { title: ' ', description: '' })).rejects.toThrow();
  });

  it('reads legacy KV records with lifecycle defaults and appends versioned events atomically', async () => {
    const now = 10;
    const legacy = {
      id: '70000000-0000-4000-8000-000000000001',
      locationId: 'project-1',
      title: 'Legacy issue',
      description: 'Written before lifecycle support',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await fixture.db.insert(schema.kv).values({
      key: `tracemind:issue:project-1:${legacy.id}`,
      value: JSON.stringify(legacy),
      updatedAt: now,
    });
    const migrated = await getIssue('project-1', legacy.id);
    expect(migrated).toMatchObject({
      status: 'open',
      priority: 'medium',
      staleEvidence: false,
      currentRevision: null,
      investigationState: 'reported',
    });
    const [legacyRow] = await fixture.db
      .select()
      .from(schema.kv)
      .where(eq(schema.kv.key, `tracemind:issue:project-1:${legacy.id}`));
    expect(JSON.parse(legacyRow?.value ?? '{}')).toEqual(legacy);

    const issue = await createIssue('project-1', { title: 'Lifecycle', description: '' });
    expect(await listIssueEvents('project-1', issue.id)).toHaveLength(1);
    const metadata = await updateIssueMetadata('project-1', issue.id, 1, {
      priority: 'high',
      owner: 'team',
    });
    expect(metadata).toMatchObject({ version: 2, priority: 'high', owner: 'team' });
    const recorded = await appendIssueEvent('project-1', issue.id, 2, {
      type: 'observation',
      body: 'Observed output',
      evidenceKind: 'observation',
      revision: 'rev-a',
    });
    expect(recorded.issue).toMatchObject({
      version: 3,
      currentRevision: 'rev-a',
      staleEvidence: false,
    });
    await expect(
      appendIssueEvent('project-1', issue.id, 2, { type: 'finding', body: 'stale write' })
    ).rejects.toThrow('changed');
    const resolved = await transitionIssue(
      'project-1',
      issue.id,
      3,
      'resolved',
      'The behavior was corrected and reproduced as expected.'
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      version: 4,
      resolutionRationale: 'The behavior was corrected and reproduced as expected.',
    });
    await expect(transitionIssue('project-1', issue.id, 4, 'open', 'Reopen')).rejects.toThrow(
      'Invalid issue transition'
    );
    const reopened = await transitionIssue(
      'project-1',
      issue.id,
      4,
      'investigating',
      'New reproduction contradicts the prior result.'
    );
    expect(reopened).toMatchObject({
      status: 'investigating',
      version: 5,
      resolutionRationale: null,
    });
    await expect(transitionIssue('project-1', issue.id, 5, 'resolved', ' ')).rejects.toThrow();
    expect(await listIssueEvents('project-1', issue.id)).toHaveLength(5);
    await markIssueEvidenceStale(
      'project-1',
      issue.id,
      5,
      'The source changed after the observation.'
    );
    expect((await getIssue('project-1', issue.id))?.staleEvidence).toBe(true);
    expect((await listIssueEvents('project-1', issue.id)).at(-1)?.type).toBe('stale_marked');
  });

  it('persists legal investigation phases to the issue timeline and report across database reopen', async () => {
    const revision = 'a'.repeat(40);
    await saveGraphSnapshot(
      {
        projectId: 'project-1',
        revision,
        nodes: [
          {
            id: 'workflow-root',
            projectId: 'project-1',
            revision,
            kind: 'repository_revision',
            label: revision,
            source: null,
            extractionMethod: 'audit',
            provenance: 'audit',
            stale: false,
            createdAt: 1,
          },
        ],
        relationships: [],
        retrievalReasons: [],
        parserFailures: [],
      },
      1
    );
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    const issue = await createIssue('project-1', {
      title: 'Persisted workflow',
      description: 'Track investigation phases separately from issue resolution.',
      auditId: audit.id,
    });
    expect(issue).toMatchObject({ status: 'open', investigationState: 'reported' });
    await expect(
      transitionIssueInvestigation('project-1', issue.id, issue.version, {
        nextState: 'verified',
        rationale: 'Illegal shortcut',
        outcome: 'passed',
        checkRunId: '70000000-0000-4000-8000-000000000099',
      })
    ).rejects.toThrow('Invalid investigation transition');
    expect(await getIssue('project-1', issue.id)).toMatchObject({
      version: issue.version,
      status: 'open',
      investigationState: 'reported',
    });
    expect(await listIssueEvents('project-1', issue.id)).toHaveLength(1);

    let current = issue;
    for (const nextState of ['queued', 'gathering_evidence', 'forming_hypotheses'] as const) {
      const result = await transitionIssueInvestigation('project-1', issue.id, current.version, {
        nextState,
        rationale: `Advance to ${nextState}.`,
      });
      current = result.issue;
      expect(result.event).toMatchObject({
        type: 'investigation_transition',
        investigationState: nextState,
        investigationOutcome: null,
      });
    }

    const hypothesis = await appendIssueEvent('project-1', issue.id, current.version, {
      type: 'hypothesis',
      body: 'Acceptance criterion: the request handler returns HTTP 200 for a valid payload.',
      evidenceKind: 'inference',
      auditId: audit.id,
      revision,
    });
    current = hypothesis.issue;
    for (const nextState of [
      'planning_checks',
      'awaiting_approval',
      'planning_checks',
      'executing_checks',
    ] as const) {
      const result = await transitionIssueInvestigation('project-1', issue.id, current.version, {
        nextState,
        rationale: `Advance to ${nextState}.`,
      });
      current = result.issue;
    }

    const unrelatedRunId = '70000000-0000-4000-8000-000000000098';
    const unrelatedCheck = await appendIssueCheckResult('project-1', issue.id, current.version, {
      auditId: audit.id,
      note: 'An otherwise passing check with no issue criterion binding.',
      outcome: {
        runId: unrelatedRunId,
        state: 'finished',
        status: 'exited',
        verified: true,
        exitCode: 0,
        signal: null,
        effectiveLimits: { processCount: false, memory: false },
      },
    });
    current = unrelatedCheck.issue;
    expect(current).toMatchObject({ status: 'open', investigationState: 'executing_checks' });
    await expect(
      appendIssueCheckResult('project-1', issue.id, current.version, {
        auditId: audit.id,
        criterionId: '70000000-0000-4000-8000-000000000097',
        note: 'Reject a fabricated criterion id.',
        outcome: {
          runId: '70000000-0000-4000-8000-000000000096',
          state: 'finished',
          status: 'exited',
          verified: true,
          exitCode: 0,
          signal: null,
          effectiveLimits: { processCount: false, memory: false },
        },
      })
    ).rejects.toThrow('persisted issue hypothesis');
    await expect(
      transitionIssueInvestigation('project-1', issue.id, current.version, {
        nextState: 'evaluating_evidence',
        rationale: 'Reject a fabricated success link.',
        outcome: 'passed',
        checkRunId: '70000000-0000-4000-8000-000000000097',
      })
    ).rejects.toThrow('does not match the linked check run');

    const evaluating = await transitionIssueInvestigation('project-1', issue.id, current.version, {
      nextState: 'evaluating_evidence',
      rationale: 'Evaluate the target-specific check.',
    });
    current = evaluating.issue;
    await expect(
      transitionIssueInvestigation('project-1', issue.id, current.version, {
        nextState: 'supported_finding',
        rationale: 'Reject a finding without persisted support.',
      })
    ).rejects.toThrow('persisted issue finding');
    const finding = await appendIssueEvent('project-1', issue.id, current.version, {
      type: 'finding',
      body: 'Observed response status 200 for the valid payload.',
      evidenceKind: 'observation',
      auditId: audit.id,
      revision,
      criterionId: hypothesis.event.id,
    });
    current = finding.issue;
    const supported = await transitionIssueInvestigation('project-1', issue.id, current.version, {
      nextState: 'supported_finding',
      rationale: 'The finding supports the recorded acceptance criterion.',
    });
    current = supported.issue;
    const runId = '70000000-0000-4000-8000-000000000095';
    const targetedCheck = await appendIssueCheckResult('project-1', issue.id, current.version, {
      auditId: audit.id,
      revision,
      criterionId: hypothesis.event.id,
      note: 'The approved check exercised the issue-specific valid-payload criterion.',
      outcome: {
        runId,
        state: 'finished',
        status: 'exited',
        verified: true,
        exitCode: 0,
        signal: null,
        effectiveLimits: { processCount: false, memory: false },
      },
    });
    current = targetedCheck.issue;
    const verification = await transitionIssueInvestigation(
      'project-1',
      issue.id,
      current.version,
      { nextState: 'verification', rationale: 'Review the finding and linked check.' }
    );
    current = verification.issue;
    await expect(
      transitionIssueInvestigation('project-1', issue.id, current.version, {
        nextState: 'verified',
        rationale: 'An unrelated passing check is not sufficient.',
        outcome: 'passed',
        checkRunId: unrelatedRunId,
      })
    ).rejects.toThrow('linked issue-specific hypothesis/criterion');
    const verified = await transitionIssueInvestigation('project-1', issue.id, current.version, {
      nextState: 'verified',
      rationale: 'The linked completed check met its recorded criterion.',
      outcome: 'passed',
      checkRunId: runId,
    });
    expect(verified).toMatchObject({
      issue: { status: 'open', investigationState: 'verified' },
      event: {
        type: 'investigation_transition',
        checkRunId: runId,
        investigationOutcome: 'passed',
      },
    });

    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      const persisted = await getIssue('project-1', issue.id);
      const events = await listIssueEvents('project-1', issue.id);
      const report = await generateInvestigationReport('project-1', issue.id);
      expect(persisted).toMatchObject({ status: 'open', investigationState: 'verified' });
      expect(events.filter((event) => event.type === 'investigation_transition')).toHaveLength(11);
      expect(report).toMatchObject({
        status: 'open',
        investigationState: 'verified',
        investigationHistory: [
          { investigationState: 'queued' },
          { investigationState: 'gathering_evidence' },
          { investigationState: 'forming_hypotheses' },
          { investigationState: 'planning_checks' },
          { investigationState: 'awaiting_approval' },
          { investigationState: 'planning_checks' },
          { investigationState: 'executing_checks' },
          { investigationState: 'evaluating_evidence' },
          { investigationState: 'supported_finding' },
          { investigationState: 'verification' },
          { investigationState: 'verified', checkRunId: runId, investigationOutcome: 'passed' },
        ],
      });
      expect(report?.markdown).toContain('- Status: open');
      expect(report?.markdown).toContain('- Investigation phase: verified');
      expect(report?.markdown).toContain('## Investigation phase history');
      expect(report?.markdown).toContain(`check run ${runId}`);
      expect(report?.markdown).toContain(`criterion ${hypothesis.event.id}`);
      expect(report?.events.find((event) => event.type === 'finding')).toMatchObject({
        criterionId: hypothesis.event.id,
        body: 'Observed response status 200 for the valid payload.',
      });
      expect(report?.markdown).toContain(
        'A passed or recorded check does not automatically resolve this issue.'
      );
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });

  it('refuses verification when a newer graph revision exists than the linked finding and check', async () => {
    const revision = 'b'.repeat(40);
    await saveGraphSnapshot(
      {
        projectId: 'project-1',
        revision,
        nodes: [
          {
            id: 'verification-root-a',
            projectId: 'project-1',
            revision,
            kind: 'repository_revision',
            label: revision,
            source: null,
            extractionMethod: 'audit',
            provenance: 'audit',
            stale: false,
            createdAt: 1,
          },
        ],
        relationships: [],
        retrievalReasons: [],
        parserFailures: [],
      },
      1
    );
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    let issue = await createIssue('project-1', {
      title: 'Stale check cannot verify',
      description: '',
      auditId: audit.id,
    });
    for (const nextState of ['queued', 'gathering_evidence', 'forming_hypotheses'] as const) {
      issue = (
        await transitionIssueInvestigation('project-1', issue.id, issue.version, {
          nextState,
          rationale: `Advance to ${nextState}.`,
        })
      ).issue;
    }
    const hypothesis = await appendIssueEvent('project-1', issue.id, issue.version, {
      type: 'hypothesis',
      body: 'The valid request path returns 200.',
      evidenceKind: 'inference',
      auditId: audit.id,
      revision,
    });
    issue = hypothesis.issue;
    for (const nextState of [
      'planning_checks',
      'awaiting_approval',
      'planning_checks',
      'executing_checks',
      'evaluating_evidence',
    ] as const) {
      issue = (
        await transitionIssueInvestigation('project-1', issue.id, issue.version, {
          nextState,
          rationale: `Advance to ${nextState}.`,
        })
      ).issue;
    }
    issue = (
      await appendIssueEvent('project-1', issue.id, issue.version, {
        type: 'finding',
        body: 'Observed a 200 response for the valid request.',
        auditId: audit.id,
        revision,
        criterionId: hypothesis.event.id,
      })
    ).issue;
    issue = (
      await transitionIssueInvestigation('project-1', issue.id, issue.version, {
        nextState: 'supported_finding',
        rationale: 'Finding supports the criterion.',
      })
    ).issue;
    const runId = '70000000-0000-4000-8000-000000000031';
    issue = (
      await appendIssueCheckResult('project-1', issue.id, issue.version, {
        auditId: audit.id,
        revision,
        criterionId: hypothesis.event.id,
        note: 'The targeted check passed.',
        outcome: {
          runId,
          state: 'finished',
          status: 'exited',
          verified: true,
          exitCode: 0,
          signal: null,
          effectiveLimits: { processCount: false, memory: false },
        },
      })
    ).issue;
    issue = (
      await transitionIssueInvestigation('project-1', issue.id, issue.version, {
        nextState: 'verification',
        rationale: 'Review the target-specific check.',
      })
    ).issue;
    const latestRevision = 'c'.repeat(40);
    await saveGraphSnapshot(
      {
        projectId: 'project-1',
        revision: latestRevision,
        nodes: [
          {
            id: 'verification-root-b',
            projectId: 'project-1',
            revision: latestRevision,
            kind: 'repository_revision',
            label: latestRevision,
            source: null,
            extractionMethod: 'audit',
            provenance: 'audit',
            stale: false,
            createdAt: 2,
          },
        ],
        relationships: [],
        retrievalReasons: [],
        parserFailures: [],
      },
      2
    );

    await expect(
      transitionIssueInvestigation('project-1', issue.id, issue.version, {
        nextState: 'verified',
        rationale: 'The old check cannot verify against a newer graph revision.',
        outcome: 'passed',
        checkRunId: runId,
      })
    ).rejects.toThrow('latest graph revision');
    expect(await getIssue('project-1', issue.id)).toMatchObject({
      version: issue.version,
      investigationState: 'verification',
    });
  });

  it('caps persisted issue timeline events and rejects writes without changing issue state', async () => {
    const issue = await createIssue('project-1', { title: 'Bounded history', description: '' });
    let version = issue.version;
    for (let index = 1; index < MAX_ISSUE_EVENTS; index++) {
      const result = await appendIssueEvent('project-1', issue.id, version, {
        type: 'observation',
        body: `Bounded event ${index}`,
        evidenceKind: 'observation',
      });
      version = result.issue.version;
    }
    expect(await listIssueEvents('project-1', issue.id)).toHaveLength(MAX_ISSUE_EVENTS);
    await expect(
      appendIssueEvent('project-1', issue.id, version, {
        type: 'finding',
        body: 'This event must not be written',
      })
    ).rejects.toThrow(`${MAX_ISSUE_EVENTS}-event limit`);
    expect(await getIssue('project-1', issue.id)).toMatchObject({ version });
    expect(await listIssueEvents('project-1', issue.id)).toHaveLength(MAX_ISSUE_EVENTS);
  });

  it('commits graph entry, issue version, and issue-linked event together with project and revision checks', async () => {
    const base = {
      projectId: 'project-1',
      revision: 'revision-a',
      nodes: [
        {
          id: 'root',
          projectId: 'project-1',
          revision: 'revision-a',
          kind: 'repository_revision' as const,
          label: 'revision-a',
          source: null,
          extractionMethod: 'audit',
          provenance: 'audit',
          stale: false,
          createdAt: 1,
        },
      ],
      relationships: [],
      retrievalReasons: [],
      parserFailures: [],
    };
    await saveGraphSnapshot(base, 1);
    const issue = await createIssue('project-1', { title: 'Linked issue', description: '' });
    const nodeId = await appendGraphRecordBounded(
      'project-1',
      'revision-a',
      {
        kind: 'observation',
        label: 'Observed graph evidence',
        reason: 'Attached to the issue investigation.',
      },
      { issueId: issue.id, expectedVersion: issue.version }
    );
    const updated = await getIssue('project-1', issue.id);
    const events = await listIssueEvents('project-1', issue.id);
    expect(updated).toMatchObject({ version: 2, currentRevision: 'revision-a' });
    expect(events.at(-1)).toMatchObject({
      type: 'observation',
      revision: 'revision-a',
      graphNodeId: nodeId,
    });
    expect(
      (await getGraphSnapshot('project-1', 'revision-a'))?.nodes.find((node) => node.id === nodeId)
        ?.issueId
    ).toBe(issue.id);
    const linkedReport = await generateInvestigationReport('project-1', issue.id);
    expect(linkedReport?.events.at(-1)?.graphEvidence).toMatchObject({
      kind: 'observation',
      label: 'Observed graph evidence',
      extractionMethod: 'user-recorded',
      provenance: 'investigation-entry',
    });

    await appendGraphRecordBounded(
      'project-1',
      'revision-a',
      { kind: 'command_run', label: 'Manual command note', reason: 'Recorded by a user.' },
      { issueId: issue.id, expectedVersion: 2 }
    );
    expect((await listIssueEvents('project-1', issue.id)).at(-1)).toMatchObject({
      type: 'graph_entry',
      evidenceKind: 'record',
      checkOutcome: null,
    });

    const otherProjectIssue = await createIssue('project-2', {
      title: 'Other project',
      description: '',
    });
    await expect(
      appendGraphRecordBounded(
        'project-1',
        'revision-a',
        {
          kind: 'observation',
          label: 'Wrong project',
          reason: 'Should not be linked.',
        },
        { issueId: otherProjectIssue.id, expectedVersion: 1 }
      )
    ).rejects.toThrow('Issue not found');
    await expect(
      appendGraphRecordBounded(
        'project-1',
        'revision-a',
        {
          kind: 'observation',
          label: 'Stale issue version',
          reason: 'Should roll back.',
        },
        { issueId: issue.id, expectedVersion: 1 }
      )
    ).rejects.toThrow('changed');
    expect((await getGraphSnapshot('project-1', 'revision-a'))?.nodes).toHaveLength(3);
    expect(await listIssueEvents('project-1', issue.id)).toHaveLength(3);
  });

  it('reports stale and partial evidence without treating a check result as issue resolution', async () => {
    const revisionA = 'a'.repeat(40);
    const audit = await saveAudit({
      locationId: 'project-1',
      root: '/fixture',
      revision: revisionA,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    });
    await saveGraphSnapshot(
      {
        projectId: 'project-1',
        revision: revisionA,
        nodes: [
          {
            id: 'audit-root-a',
            projectId: 'project-1',
            revision: revisionA,
            kind: 'repository_revision',
            label: 'revision-a',
            source: null,
            extractionMethod: 'audit',
            provenance: 'audit',
            stale: false,
            createdAt: 1,
          },
        ],
        relationships: [],
        retrievalReasons: [],
        parserFailures: [],
      },
      1
    );
    const issue = await createIssue('project-1', {
      title: 'Revision changed',
      description: 'Needs review',
      auditId: audit.id,
    });
    await appendIssueCheckResult('project-1', issue.id, 1, {
      auditId: audit.id,
      note: 'The targeted check completed.',
      revision: revisionA,
      outcome: {
        runId: '70000000-0000-4000-8000-000000000002',
        state: 'finished',
        status: 'exited',
        verified: false,
        exitCode: 0,
        signal: null,
        effectiveLimits: { processCount: false, memory: false },
      },
    });
    await transitionIssue(
      'project-1',
      issue.id,
      2,
      'resolved',
      'Manual review confirmed expected behavior.'
    );
    await saveGraphSnapshot(
      {
        projectId: 'project-1',
        revision: 'revision-b',
        nodes: [
          {
            id: 'new-root',
            projectId: 'project-1',
            revision: 'revision-b',
            kind: 'repository_revision',
            label: 'revision-b',
            source: null,
            extractionMethod: 'audit',
            provenance: 'audit',
            stale: false,
            createdAt: 2,
          },
        ],
        relationships: [],
        retrievalReasons: [],
        parserFailures: [],
      },
      2
    );
    const staleIssue = await getIssue('project-1', issue.id);
    if (!staleIssue) throw new Error('Expected issue after resolution');
    const reviewed = await reviewIssueEvidence(
      'project-1',
      issue.id,
      staleIssue.version,
      'revision-b',
      'Reviewed the current graph and reproduced the behavior.'
    );
    expect(reviewed).toMatchObject({
      status: 'resolved',
      staleEvidence: false,
      currentRevision: 'revision-b',
    });
    const report = await generateInvestigationReport('project-1', issue.id);
    expect(report).toMatchObject({
      status: 'resolved',
      latestGraphRevision: 'revision-b',
      coverage: { status: 'partial' },
    });
    expect(report?.events.find((event) => event.type === 'check_result')).toMatchObject({
      stale: true,
      checkOutcome: { status: 'exited', verified: false, exitCode: 0 },
    });
    expect(report?.markdown).toContain('runner finished/exited · verified=false · exit=0');
    expect(report?.markdown).toContain(
      'Resolution recorded. Rationale: Manual review confirmed expected behavior.'
    );
    expect(report?.markdown).toContain(
      'A passed or recorded check does not automatically resolve this issue.'
    );
    expect(report?.markdown).toContain('Coverage\nPartial');
  });

  it('reports source-invalidated linked graph evidence as stale even after an issue revision review', async () => {
    const revision = 'source-revision';
    await saveGraphSnapshot(
      {
        projectId: 'project-1',
        revision,
        nodes: [
          {
            id: 'source-root',
            projectId: 'project-1',
            revision,
            kind: 'repository_revision',
            label: revision,
            source: null,
            extractionMethod: 'audit',
            provenance: 'audit',
            stale: false,
            createdAt: 1,
          },
        ],
        relationships: [],
        retrievalReasons: [],
        parserFailures: [],
      },
      1
    );
    const issue = await createIssue('project-1', { title: 'Stale graph node', description: '' });
    await appendGraphRecordBounded(
      'project-1',
      revision,
      {
        kind: 'observation',
        label: 'Observed source',
        source: { path: 'src/file.ts', startLine: 1, endLine: 2 },
        reason: 'Captured against the source revision.',
      },
      { issueId: issue.id, expectedVersion: issue.version }
    );
    await markGraphStale('project-1', ['src/file.ts']);
    const current = await getIssue('project-1', issue.id);
    if (!current) throw new Error('Expected issue after graph invalidation');
    const reviewed = await reviewIssueEvidence(
      'project-1',
      issue.id,
      current.version,
      revision,
      'Reviewed the current graph revision.'
    );
    expect(reviewed.staleEvidence).toBe(false);
    const report = await generateInvestigationReport('project-1', issue.id);
    const linked = report?.events.find((event) => event.graphNodeId !== null);
    expect(linked).toMatchObject({
      stale: true,
      graphEvidence: { stale: true, label: 'Observed source' },
    });
  });

  it('reports unversioned issue evidence as freshness-unknown and preserves that uncertainty after resolution', async () => {
    const issue = await createIssue('project-1', {
      title: 'Unversioned evidence',
      description: 'Evidence without a graph revision must remain explicitly uncertain.',
    });
    const evidence = await appendIssueEvent('project-1', issue.id, issue.version, {
      type: 'evidence',
      body: 'A user supplied this evidence without a repository revision.',
      evidenceKind: 'record',
    });
    await transitionIssue(
      'project-1',
      issue.id,
      evidence.issue.version,
      'resolved',
      'Manually resolved after review.'
    );

    const report = await generateInvestigationReport('project-1', issue.id);
    expect(report?.events.find((event) => event.id === evidence.event.id)).toMatchObject({
      revision: null,
      revisionUnknown: true,
      stale: false,
    });
    expect(report?.coverage.reasons).toContain(
      '1 evidence event(s) have no bound graph revision and cannot be freshness-checked.'
    );
    expect(report?.markdown).toContain('revision unknown');
    expect(report?.markdown).toContain(
      'Resolution recorded, but evidence is stale or revision-unbound and requires review.'
    );
    expect(report?.uncertainty).toContain(
      'Evidence without a graph revision cannot be compared for freshness.'
    );
  });
});
