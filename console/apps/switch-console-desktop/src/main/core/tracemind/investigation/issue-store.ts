import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DrizzleTx } from '@main/db/client';
import { kv, tracemindGraphRevisions } from '@main/db/schema';
import type { TraceMindAIInvestigation } from '@shared/core/tracemind/ai-investigation';
import { getAudit } from '../audit/audit-store';
import {
  checkOutcomes,
  investigationStates,
  transitionInvestigation,
  type CheckOutcome,
  type InvestigationState,
} from './state-machine';

const locationSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const idSchema = z.string().uuid();
const revisionSchema = z.string().min(1).max(128);
const contentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000),
    auditId: idSchema.nullable().optional(),
  })
  .strict();
const statusSchema = z.enum(['open', 'investigating', 'resolved']);
const prioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
const investigationStateSchema = z.enum(investigationStates);
const investigationOutcomeSchema = z.enum(checkOutcomes);
export const MAX_ISSUE_EVENTS = 100;
export const MAX_ISSUE_EVENT_RECORD_BYTES = 96 * 1024;
export const MAX_ISSUE_EVENT_TOTAL_BYTES = 4 * 1024 * 1024;
const checkOutcomeSchema = z
  .object({
    runId: idSchema,
    state: z.enum(['finished', 'refused']),
    status: z.enum([
      'exited',
      'timed_out',
      'cancelled',
      'crashed',
      'output_limit',
      'spawn_error',
      'resource_limit_refused',
    ]),
    verified: z.boolean(),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(128).nullable(),
    effectiveLimits: z
      .object({
        processCount: z.union([z.literal(false), z.number().int().positive()]),
        memory: z.union([z.literal(false), z.number().int().positive()]),
      })
      .strict(),
  })
  .strict()
  .refine((value) => (value.state === 'refused') === (value.status === 'resource_limit_refused'))
  .refine((value) => value.state !== 'refused' || !value.verified);
const issueSchema = contentSchema
  .extend({
    id: idSchema,
    locationId: locationSchema,
    version: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    // Defaults keep records written before lifecycle support readable.
    status: statusSchema.default('open'),
    priority: prioritySchema.default('medium'),
    owner: z.string().trim().max(200).nullable().default(null),
    currentRevision: revisionSchema.nullable().default(null),
    staleEvidence: z.boolean().default(false),
    resolutionRationale: z.string().max(5000).nullable().default(null),
    resolvedAt: z.number().int().nonnegative().nullable().default(null),
    // Defaults preserve the readable shape of legacy issue records.
    investigationState: investigationStateSchema.default('reported'),
  })
  .strict();
const eventTypeSchema = z.enum([
  'issue_created',
  'issue_updated',
  'status_changed',
  'resolution',
  'investigation_transition',
  'observation',
  'hypothesis',
  'finding',
  'evidence',
  'graph_revision',
  'check_result',
  'stale_marked',
  'evidence_reviewed',
  'graph_entry',
  'ai_investigation',
]);
const aiInvestigationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    provider: z.literal('openai-compatible'),
    model: z.string().min(1).max(128),
    generatedAt: z.number().int().nonnegative(),
    evidenceRevision: revisionSchema.nullable(),
    freshness: z.enum(['fresh', 'stale', 'unknown']),
    summary: z.string().min(1).max(12_000),
    summaryEvidenceIds: z.array(z.string().min(1).max(256)).max(32),
    hypotheses: z
      .array(
        z
          .object({
            rank: z.number().int().positive().max(10),
            statement: z.string().min(1).max(4_000),
            confidence: z.enum(['low', 'medium', 'high']),
            rationale: z.string().min(1).max(4_000),
            evidenceIds: z.array(z.string().min(1).max(256)).max(32),
          })
          .strict()
      )
      .min(1)
      .max(10),
    recommendations: z
      .array(
        z
          .object({
            rank: z.number().int().positive().max(10),
            action: z.string().min(1).max(4_000),
            rationale: z.string().min(1).max(4_000),
            evidenceIds: z.array(z.string().min(1).max(256)).max(32),
          })
          .strict()
      )
      .min(1)
      .max(10),
    limitations: z.array(z.string().min(1).max(2_000)).max(32),
    evidenceReferences: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            kind: z.enum(['issue', 'timeline', 'graph', 'audit', 'check', 'source_excerpt']),
            label: z.string().min(1).max(500),
            path: z.string().max(4096).nullable(),
            startLine: z.number().int().positive().nullable(),
            endLine: z.number().int().positive().nullable(),
            revision: z.string().max(128).nullable(),
            freshness: z.enum(['fresh', 'stale', 'unknown']),
            certainty: z.enum(['direct', 'heuristic', 'ambiguous', 'recorded']),
            provenance: z.string().min(1).max(500),
            extractionMethod: z.string().min(1).max(200),
          })
          .strict()
      )
      .max(48),
  })
  .strict()
  .superRefine((value, context) => {
    const known = new Set(value.evidenceReferences.map((reference) => reference.id));
    const citations = [
      ...value.summaryEvidenceIds,
      ...value.hypotheses.flatMap((hypothesis) => hypothesis.evidenceIds),
      ...value.recommendations.flatMap((recommendation) => recommendation.evidenceIds),
    ];
    for (const citation of citations) {
      if (!known.has(citation))
        context.addIssue({ code: 'custom', message: 'AI citation is missing from evidence refs' });
    }
  });
const issueEventSchema = z
  .object({
    id: idSchema,
    projectId: locationSchema,
    issueId: idSchema,
    issueVersion: z.number().int().positive(),
    type: eventTypeSchema,
    body: z.string().min(1).max(20_000),
    evidenceKind: z.enum(['observation', 'inference', 'execution', 'record']).default('record'),
    auditId: idSchema.nullable().default(null),
    revision: revisionSchema.nullable().default(null),
    graphNodeId: z.string().min(1).max(512).nullable().default(null),
    checkRunId: idSchema.nullable().default(null),
    // A check can be cited as verification only when it names an issue-local criterion.
    criterionId: idSchema.nullable().default(null),
    checkOutcome: checkOutcomeSchema.nullable().default(null),
    investigationState: investigationStateSchema.nullable().default(null),
    investigationOutcome: investigationOutcomeSchema.nullable().default(null),
    // AI investigation output is persisted as a cited advisory snapshot, never as a resolution.
    aiInvestigation: aiInvestigationSchema.nullable().default(null),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
const appendEventInputSchema = z
  .object({
    type: z.enum(['observation', 'hypothesis', 'finding', 'evidence']),
    body: z.string().trim().min(1).max(20_000),
    evidenceKind: z.enum(['observation', 'inference', 'record']).default('record'),
    auditId: idSchema.nullable().optional(),
    revision: revisionSchema.nullable().optional(),
    criterionId: idSchema.nullable().optional(),
  })
  .strict();
const investigationTransitionInputSchema = z
  .object({
    nextState: investigationStateSchema,
    rationale: z.string().trim().min(1).max(5000),
    outcome: investigationOutcomeSchema.optional(),
    checkRunId: idSchema.optional(),
  })
  .strict();

export type IssueInput = z.infer<typeof contentSchema>;
export type IssueStatus = z.infer<typeof statusSchema>;
export type IssuePriority = z.infer<typeof prioritySchema>;
export type TraceMindIssue = z.infer<typeof issueSchema>;
export type IssueEvent = z.infer<typeof issueEventSchema>;
export type IssueEventInput = z.input<typeof appendEventInputSchema>;
export type IssueCheckOutcome = z.infer<typeof checkOutcomeSchema>;
export type IssueInvestigationState = InvestigationState;
export type IssueInvestigationOutcome = CheckOutcome;

function prefix(locationId: string): string {
  return `tracemind:issue:${locationSchema.parse(locationId)}:`;
}

function key(locationId: string, id: string): string {
  return `${prefix(locationId)}${idSchema.parse(id)}`;
}

function eventPrefix(locationId: string, issueId: string): string {
  return `tracemind:issue-event:${locationSchema.parse(locationId)}:${idSchema.parse(issueId)}:`;
}

function eventKey(locationId: string, issueId: string, id: string): string {
  return `${eventPrefix(locationId, issueId)}${idSchema.parse(id)}`;
}

function parseIssue(raw: string, locationId: string): TraceMindIssue {
  const issue = issueSchema.parse(JSON.parse(raw));
  if (issue.locationId !== locationId) throw new Error('Stored issue project mismatch');
  return issue;
}

function parseEvent(raw: string, locationId: string, issueId: string): IssueEvent {
  const event = issueEventSchema.parse(JSON.parse(raw));
  if (event.projectId !== locationId || event.issueId !== issueId)
    throw new Error('Stored issue event project mismatch');
  return event;
}

async function validateAudit(
  locationId: string,
  auditId: string | null | undefined
): Promise<void> {
  if (auditId && !(await getAudit(locationId, auditId))) throw new Error('Related audit not found');
}

function getIssueInTransaction(
  tx: DrizzleTx,
  locationId: string,
  id: string
): { issue: TraceMindIssue; raw: string } {
  const issueKey = key(locationId, id);
  const row = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, issueKey)).get();
  if (!row) throw new Error('Issue not found');
  const issue = parseIssue(row.value, locationId);
  if (issue.id !== id) throw new Error('Stored issue identity mismatch');
  return { issue, raw: row.value };
}

function assertEventCapacityInTransaction(
  tx: DrizzleTx,
  locationId: string,
  issueId: string,
  nextEventBytes: number
): void {
  const start = eventPrefix(locationId, issueId);
  const summary = tx
    .select({
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(length(cast(${kv.value} as blob))), 0)`,
    })
    .from(kv)
    .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)))
    .get();
  if ((summary?.count ?? 0) >= MAX_ISSUE_EVENTS)
    throw new Error(`Issue timeline reached its ${MAX_ISSUE_EVENTS}-event limit`);
  if (
    nextEventBytes > MAX_ISSUE_EVENT_RECORD_BYTES ||
    (summary?.bytes ?? 0) + nextEventBytes > MAX_ISSUE_EVENT_TOTAL_BYTES
  ) {
    throw new Error('Issue timeline reached its 4 MiB serialized event limit');
  }
}

function persistVersionAndEvent(
  tx: DrizzleTx,
  current: TraceMindIssue,
  raw: string,
  input: {
    type: IssueEvent['type'];
    body: string;
    evidenceKind?: IssueEvent['evidenceKind'];
    auditId?: string | null;
    revision?: string | null;
    graphNodeId?: string | null;
    checkRunId?: string | null;
    criterionId?: string | null;
    checkOutcome?: IssueCheckOutcome | null;
    investigationOutcome?: CheckOutcome | null;
    aiInvestigation?: TraceMindAIInvestigation | null;
  },
  patch: Partial<
    Pick<
      TraceMindIssue,
      | 'title'
      | 'description'
      | 'auditId'
      | 'status'
      | 'priority'
      | 'owner'
      | 'currentRevision'
      | 'staleEvidence'
      | 'resolutionRationale'
      | 'resolvedAt'
      | 'investigationState'
    >
  > = {}
): { issue: TraceMindIssue; event: IssueEvent } {
  const now = Date.now();
  const updated = issueSchema.parse({
    ...current,
    ...patch,
    version: current.version + 1,
    updatedAt: now,
  });
  const issueKey = key(current.locationId, current.id);
  const result = tx
    .update(kv)
    .set({ value: JSON.stringify(updated), updatedAt: now })
    .where(and(eq(kv.key, issueKey), eq(kv.value, raw)))
    .returning({ key: kv.key })
    .all();
  if (result.length !== 1) throw new Error('Issue has changed');
  const event = issueEventSchema.parse({
    id: randomUUID(),
    projectId: current.locationId,
    issueId: current.id,
    issueVersion: updated.version,
    type: input.type,
    body: input.body,
    evidenceKind: input.evidenceKind ?? 'record',
    auditId: input.auditId === undefined ? (updated.auditId ?? null) : input.auditId,
    revision: input.revision ?? null,
    graphNodeId: input.graphNodeId ?? null,
    checkRunId: input.checkRunId ?? null,
    criterionId: input.criterionId ?? null,
    checkOutcome: input.checkOutcome ?? null,
    investigationState: updated.investigationState,
    investigationOutcome: input.investigationOutcome ?? null,
    aiInvestigation:
      input.aiInvestigation == null ? null : aiInvestigationSchema.parse(input.aiInvestigation),
    createdAt: now,
  });
  const serializedEvent = JSON.stringify(event);
  assertEventCapacityInTransaction(
    tx,
    current.locationId,
    current.id,
    Buffer.byteLength(serializedEvent, 'utf8')
  );
  tx.insert(kv)
    .values({
      key: eventKey(current.locationId, current.id, event.id),
      value: serializedEvent,
      updatedAt: now,
    })
    .run();
  return { issue: updated, event };
}

export async function createIssue(locationId: string, input: IssueInput): Promise<TraceMindIssue> {
  const validated = contentSchema.parse(input);
  locationSchema.parse(locationId);
  await validateAudit(locationId, validated.auditId);
  const now = Date.now();
  const issue = issueSchema.parse({
    ...validated,
    id: randomUUID(),
    locationId,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  db.transaction((tx) => {
    tx.insert(kv)
      .values({ key: key(locationId, issue.id), value: JSON.stringify(issue), updatedAt: now })
      .run();
    const event = issueEventSchema.parse({
      id: randomUUID(),
      projectId: locationId,
      issueId: issue.id,
      issueVersion: issue.version,
      type: 'issue_created',
      body: `Issue created: ${issue.title}`,
      evidenceKind: 'record',
      auditId: issue.auditId ?? null,
      investigationState: issue.investigationState,
      createdAt: now,
    });
    tx.insert(kv)
      .values({
        key: eventKey(locationId, issue.id, event.id),
        value: JSON.stringify(event),
        updatedAt: now,
      })
      .run();
  });
  return issue;
}

export async function getIssue(locationId: string, id: string): Promise<TraceMindIssue | null> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, key(locationId, id)))
    .limit(1);
  return row ? parseIssue(row.value, locationId) : null;
}

export async function listIssues(locationId: string): Promise<TraceMindIssue[]> {
  const start = prefix(locationId);
  const rows = await db
    .select({ value: kv.value })
    .from(kv)
    .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)));
  return rows
    .map((row) => parseIssue(row.value, locationId))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function listIssueEvents(locationId: string, issueId: string): Promise<IssueEvent[]> {
  locationSchema.parse(locationId);
  idSchema.parse(issueId);
  return db.transaction((tx) => {
    const start = eventPrefix(locationId, issueId);
    const where = and(gte(kv.key, start), lt(kv.key, `${start}\uffff`));
    const summary = tx
      .select({
        count: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(length(cast(${kv.value} as blob))), 0)`,
      })
      .from(kv)
      .where(where)
      .get();
    if ((summary?.count ?? 0) > MAX_ISSUE_EVENTS)
      throw new Error(`Stored issue timeline exceeds its ${MAX_ISSUE_EVENTS}-event limit`);
    if ((summary?.bytes ?? 0) > MAX_ISSUE_EVENT_TOTAL_BYTES)
      throw new Error('Stored issue timeline exceeds its 4 MiB serialized event limit');
    const rows = tx.select({ value: kv.value }).from(kv).where(where).all();
    return rows
      .map((row) => parseEvent(row.value, locationId, issueId))
      .sort(
        (a, b) =>
          a.issueVersion - b.issueVersion || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
      );
  });
}

export async function updateIssue(
  locationId: string,
  id: string,
  version: number,
  input: IssueInput
): Promise<TraceMindIssue> {
  const validated = contentSchema.parse(input);
  idSchema.parse(id);
  await validateAudit(locationId, validated.auditId);
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== version) throw new Error('Issue has changed');
    const updatedContent = contentSchema.parse({
      title: validated.title,
      description: validated.description,
      auditId: validated.auditId === undefined ? issue.auditId : validated.auditId,
    });
    return persistVersionAndEvent(
      tx,
      issue,
      raw,
      {
        type: 'issue_updated',
        body: 'Issue details updated',
        auditId: updatedContent.auditId ?? null,
      },
      {
        title: updatedContent.title,
        description: updatedContent.description,
        auditId: updatedContent.auditId,
      }
    ).issue;
  });
}

export async function updateIssueMetadata(
  locationId: string,
  id: string,
  version: number,
  input: { priority: IssuePriority; owner: string | null }
): Promise<TraceMindIssue> {
  const metadata = z
    .object({ priority: prioritySchema, owner: z.string().trim().max(200).nullable() })
    .strict()
    .parse(input);
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== version) throw new Error('Issue has changed');
    return persistVersionAndEvent(
      tx,
      issue,
      raw,
      { type: 'issue_updated', body: 'Issue priority or owner updated' },
      metadata
    ).issue;
  });
}

export async function transitionIssue(
  locationId: string,
  id: string,
  version: number,
  nextStatus: IssueStatus,
  rationale: string
): Promise<TraceMindIssue> {
  const next = statusSchema.parse(nextStatus);
  const reason = z.string().trim().min(1).max(5000).parse(rationale);
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== version) throw new Error('Issue has changed');
    const allowed: Record<IssueStatus, readonly IssueStatus[]> = {
      open: ['investigating', 'resolved'],
      investigating: ['open', 'resolved'],
      resolved: ['investigating'],
    };
    if (!allowed[issue.status].includes(next))
      throw new Error(`Invalid issue transition: ${issue.status} -> ${next}`);
    const body =
      next === 'resolved'
        ? `Resolved: ${reason}`
        : issue.status === 'resolved'
          ? `Reopened for investigation: ${reason}`
          : `Status changed to ${next}: ${reason}`;
    return persistVersionAndEvent(
      tx,
      issue,
      raw,
      { type: next === 'resolved' ? 'resolution' : 'status_changed', body },
      {
        status: next,
        resolutionRationale: next === 'resolved' ? reason : null,
        resolvedAt: next === 'resolved' ? Date.now() : null,
      }
    ).issue;
  });
}

/** Persists one legal investigation phase transition with the issue version and timeline event. */
export async function transitionIssueInvestigation(
  locationId: string,
  id: string,
  version: number,
  input: z.input<typeof investigationTransitionInputSchema>
): Promise<{ issue: TraceMindIssue; event: IssueEvent }> {
  locationSchema.parse(locationId);
  idSchema.parse(id);
  const value = investigationTransitionInputSchema.parse(input);
  const next = value.nextState;
  const reason = value.rationale;
  const checkedOutcome = value.outcome;
  const checkRunId = value.checkRunId;
  if ((checkedOutcome === undefined) !== (checkRunId === undefined))
    throw new Error('Check outcome and linked check run must be supplied together');
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== version) throw new Error('Issue has changed');
    const transitioned = transitionInvestigation(issue.investigationState, next, checkedOutcome);
    const start = eventPrefix(locationId, id);
    const rows =
      next === 'supported_finding' ||
      next === 'verification' ||
      next === 'verified' ||
      checkRunId !== undefined
        ? tx
            .select({ value: kv.value })
            .from(kv)
            .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)))
            .all()
        : [];
    const events = rows.map((row) => parseEvent(row.value, locationId, id));
    if (
      (next === 'supported_finding' || next === 'verification' || next === 'verified') &&
      !events.some((event) => event.type === 'finding')
    ) {
      throw new Error('This investigation phase requires a persisted issue finding');
    }
    if (checkRunId !== undefined && checkedOutcome !== undefined) {
      const checkEvent = events.find(
        (event) => event.type === 'check_result' && event.checkRunId === checkRunId
      );
      const observed = checkEvent?.checkOutcome;
      const outcomeMatches =
        checkedOutcome === 'passed'
          ? observed?.state === 'finished' &&
            observed.status === 'exited' &&
            observed.verified &&
            observed.exitCode === 0 &&
            observed.signal === null
          : checkedOutcome === 'failed'
            ? observed?.state === 'finished' &&
              observed.status === 'exited' &&
              observed.exitCode !== null &&
              observed.exitCode !== 0
            : checkedOutcome === 'timed_out'
              ? observed?.status === 'timed_out'
              : checkedOutcome === 'cancelled'
                ? observed?.status === 'cancelled'
                : checkedOutcome === 'denied'
                  ? observed?.status === 'resource_limit_refused'
                  : observed !== undefined &&
                    observed !== null &&
                    (observed.status === 'crashed' || observed.signal !== null);
      if (!outcomeMatches)
        throw new Error(
          `Investigation outcome ${checkedOutcome} does not match the linked check run`
        );
      if (next === 'verified') {
        const criterion = checkEvent?.criterionId
          ? events.find(
              (event) => event.id === checkEvent.criterionId && event.type === 'hypothesis'
            )
          : null;
        if (!criterion) {
          throw new Error('Verification requires a linked issue-specific hypothesis/criterion');
        }
        const supportedFinding = events.find(
          (event) => event.type === 'finding' && event.criterionId === criterion.id
        );
        if (!supportedFinding) {
          throw new Error('Verification requires a finding linked to the checked hypothesis');
        }
        const latestGraph = tx
          .select({ revision: tracemindGraphRevisions.revision })
          .from(tracemindGraphRevisions)
          .where(eq(tracemindGraphRevisions.projectId, locationId))
          .orderBy(desc(tracemindGraphRevisions.capturedAt), desc(tracemindGraphRevisions.revision))
          .limit(1)
          .get();
        if (
          !checkEvent?.revision ||
          !latestGraph ||
          latestGraph.revision !== checkEvent.revision ||
          criterion.auditId !== issue.auditId ||
          criterion.revision !== checkEvent?.revision ||
          supportedFinding.auditId !== checkEvent?.auditId ||
          supportedFinding.revision !== checkEvent?.revision ||
          issue.currentRevision !== checkEvent?.revision ||
          issue.staleEvidence
        ) {
          throw new Error(
            'Verification criterion is stale or does not match the latest graph revision and check evidence'
          );
        }
      }
    }
    return persistVersionAndEvent(
      tx,
      issue,
      raw,
      {
        type: 'investigation_transition',
        body: `Investigation phase changed: ${issue.investigationState} → ${transitioned}. ${reason}`,
        checkRunId,
        investigationOutcome: checkedOutcome,
      },
      { investigationState: transitioned }
    );
  });
}

export async function appendIssueEvent(
  locationId: string,
  id: string,
  version: number,
  input: IssueEventInput
): Promise<{ issue: TraceMindIssue; event: IssueEvent }> {
  locationSchema.parse(locationId);
  idSchema.parse(id);
  const value = appendEventInputSchema.parse(input);
  await validateAudit(locationId, value.auditId);
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== version) throw new Error('Issue has changed');
    if (value.auditId && value.auditId !== issue.auditId)
      throw new Error('Related audit does not match the issue');
    const revision = value.revision ?? null;
    const changedRevision =
      revision !== null && issue.currentRevision !== null && revision !== issue.currentRevision;
    const criterionId = value.criterionId == null ? null : idSchema.parse(value.criterionId);
    if (criterionId !== null) {
      if (value.type !== 'finding')
        throw new Error('Only an issue finding can be linked to an acceptance criterion');
      const start = eventPrefix(locationId, id);
      const rows = tx
        .select({ value: kv.value })
        .from(kv)
        .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)))
        .all();
      const criterion = rows
        .map((row) => parseEvent(row.value, locationId, id))
        .find((event) => event.id === criterionId && event.type === 'hypothesis');
      if (!criterion)
        throw new Error('Finding criterion must reference a persisted issue hypothesis');
      const eventAuditId = value.auditId === undefined ? (issue.auditId ?? null) : value.auditId;
      if (criterion.auditId !== eventAuditId || criterion.revision !== revision)
        throw new Error('Finding criterion does not match the audited revision');
    }
    return persistVersionAndEvent(
      tx,
      issue,
      raw,
      {
        type: value.type,
        body: value.body,
        evidenceKind: value.evidenceKind,
        auditId: value.auditId,
        revision,
        criterionId,
      },
      {
        ...(revision ? { currentRevision: revision } : {}),
        ...(changedRevision ? { staleEvidence: true } : {}),
      }
    );
  });
}

/**
 * Persists one generated AI snapshot as a timeline record. The snapshot is advisory:
 * only the issue version changes, while its lifecycle/status/resolution remain untouched.
 */
export async function recordAIInvestigation(
  locationId: string,
  id: string,
  expectedVersion: number,
  expectedCurrentRevision: string | null,
  investigation: TraceMindAIInvestigation
): Promise<{ issue: TraceMindIssue; event: IssueEvent }> {
  locationSchema.parse(locationId);
  idSchema.parse(id);
  z.number().int().positive().parse(expectedVersion);
  const validated = aiInvestigationSchema.parse(investigation) as TraceMindAIInvestigation;
  const expectedRevision =
    expectedCurrentRevision === null ? null : revisionSchema.parse(expectedCurrentRevision);
  const summary = z.string().trim().min(1).max(12_000).parse(validated.summary);
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== expectedVersion) throw new Error('Issue has changed');
    if (issue.currentRevision !== expectedRevision)
      throw new Error('Issue evidence revision changed during AI investigation');
    return persistVersionAndEvent(tx, issue, raw, {
      type: 'ai_investigation',
      body: `AI-generated advisory snapshot · ${validated.hypotheses.length} ranked hypotheses · ${validated.recommendations.length} recommendations · ${summary}`,
      evidenceKind: 'inference',
      revision: validated.evidenceRevision,
      aiInvestigation: validated,
    });
  });
}

/** Records a terminal runner result using a summary supplied by the trusted main process. */
export async function appendIssueCheckResult(
  locationId: string,
  id: string,
  version: number,
  input: {
    auditId: string;
    outcome: IssueCheckOutcome;
    note: string;
    revision?: string | null;
    criterionId?: string | null;
  }
): Promise<{ issue: TraceMindIssue; event: IssueEvent }> {
  locationSchema.parse(locationId);
  idSchema.parse(id);
  const auditId = idSchema.parse(input.auditId);
  const outcome = checkOutcomeSchema.parse(input.outcome);
  const note = z.string().trim().min(1).max(20_000).parse(input.note);
  const revision = input.revision == null ? null : revisionSchema.parse(input.revision);
  const criterionId = input.criterionId == null ? null : idSchema.parse(input.criterionId);
  await validateAudit(locationId, auditId);
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== version) throw new Error('Issue has changed');
    if (issue.auditId !== auditId) throw new Error('Check result audit does not match the issue');
    if (criterionId !== null) {
      const start = eventPrefix(locationId, id);
      const rows = tx
        .select({ value: kv.value })
        .from(kv)
        .where(and(gte(kv.key, start), lt(kv.key, `${start}\uffff`)))
        .all();
      const criterion = rows
        .map((row) => parseEvent(row.value, locationId, id))
        .find((event) => event.id === criterionId && event.type === 'hypothesis');
      if (!criterion)
        throw new Error('Check criterion must reference a persisted issue hypothesis');
      if (criterion.auditId !== auditId || criterion.revision !== revision)
        throw new Error('Check criterion does not match the audited revision');
    }
    const changedRevision =
      revision !== null && issue.currentRevision !== null && revision !== issue.currentRevision;
    return persistVersionAndEvent(
      tx,
      issue,
      raw,
      {
        type: 'check_result',
        body: note,
        evidenceKind: 'execution',
        auditId,
        revision,
        checkRunId: outcome.runId,
        criterionId,
        checkOutcome: outcome,
      },
      {
        ...(revision ? { currentRevision: revision } : {}),
        ...(changedRevision ? { staleEvidence: true } : {}),
      }
    );
  });
}

export async function markIssueEvidenceStale(
  locationId: string,
  id: string,
  version: number,
  rationale: string
): Promise<TraceMindIssue> {
  const reason = z.string().trim().min(1).max(5000).parse(rationale);
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== version) throw new Error('Issue has changed');
    if (issue.staleEvidence) throw new Error('Issue evidence is already marked stale');
    return persistVersionAndEvent(
      tx,
      issue,
      raw,
      { type: 'stale_marked', body: `Evidence marked stale: ${reason}` },
      { staleEvidence: true }
    ).issue;
  });
}

export async function reviewIssueEvidence(
  locationId: string,
  id: string,
  version: number,
  revision: string,
  rationale: string
): Promise<TraceMindIssue> {
  const currentRevision = revisionSchema.parse(revision);
  const reason = z.string().trim().min(1).max(5000).parse(rationale);
  return db.transaction((tx) => {
    const { issue, raw } = getIssueInTransaction(tx, locationId, id);
    if (issue.version !== version) throw new Error('Issue has changed');
    return persistVersionAndEvent(
      tx,
      issue,
      raw,
      {
        type: 'evidence_reviewed',
        body: `Evidence reviewed as current for revision ${currentRevision}: ${reason}`,
        revision: currentRevision,
      },
      { currentRevision, staleEvidence: false }
    ).issue;
  });
}

/** Called inside the graph transaction so the graph node, issue version, and timeline event commit together. */
export function recordGraphRevisionEventInTransaction(
  tx: DrizzleTx,
  input: {
    projectId: string;
    issueId: string;
    expectedVersion: number;
    revision: string;
    graphNodeId: string;
    kind: 'observation' | 'command_run' | 'hypothesis' | 'evidence' | 'finding';
    label: string;
  }
): TraceMindIssue {
  const projectId = locationSchema.parse(input.projectId);
  const issueId = idSchema.parse(input.issueId);
  const revision = revisionSchema.parse(input.revision);
  const { issue, raw } = getIssueInTransaction(tx, projectId, issueId);
  if (issue.version !== input.expectedVersion) throw new Error('Issue has changed');
  if (!input.graphNodeId || input.graphNodeId.length > 512)
    throw new Error('Invalid graph node ID');
  const type = input.kind === 'command_run' ? 'graph_entry' : input.kind;
  const changedRevision = issue.currentRevision !== null && issue.currentRevision !== revision;
  return persistVersionAndEvent(
    tx,
    issue,
    raw,
    {
      type,
      body: input.label,
      evidenceKind:
        input.kind === 'observation'
          ? 'observation'
          : input.kind === 'hypothesis'
            ? 'inference'
            : 'record',
      revision,
      graphNodeId: input.graphNodeId,
    },
    { currentRevision: revision, ...(changedRevision ? { staleEvidence: true } : {}) }
  ).issue;
}
