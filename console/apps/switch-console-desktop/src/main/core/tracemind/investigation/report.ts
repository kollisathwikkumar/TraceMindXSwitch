import { z } from 'zod';
import { getGraphNode, getLatestGraphSnapshot } from '../graph/graph-store';
import { getIssue, listIssueEvents, type IssueEvent } from './issue-store';
import type { InvestigationState } from './state-machine';

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const issueIdSchema = z.string().uuid();

export interface InvestigationReportEvent extends IssueEvent {
  stale: boolean;
  revisionUnknown: boolean;
  graphEvidence: {
    kind: string;
    label: string;
    source: { path: string; startLine: number; endLine: number } | null;
    extractionMethod: string;
    provenance: string;
    stale: boolean;
  } | null;
}

export interface InvestigationReport {
  schemaVersion: 1;
  generatedAt: number;
  projectId: string;
  issueId: string;
  status: 'open' | 'investigating' | 'resolved';
  investigationState: InvestigationState;
  resolutionRationale: string | null;
  resolvedAt: number | null;
  latestGraphRevision: string | null;
  issueRevision: string | null;
  coverage: { status: 'partial'; reasons: string[] };
  observations: InvestigationReportEvent[];
  inferences: InvestigationReportEvent[];
  investigationHistory: InvestigationReportEvent[];
  events: InvestigationReportEvent[];
  aiInvestigations: InvestigationReportEvent[];
  uncertainty: string[];
  markdown: string;
}

function formatEvent(event: InvestigationReportEvent): string {
  const refs = [
    event.revision
      ? `revision ${event.revision}${event.stale ? ' (stale)' : ''}`
      : event.revisionUnknown
        ? 'revision unknown'
        : null,
    event.auditId ? `audit ${event.auditId}` : null,
    event.graphNodeId ? `graph node ${event.graphNodeId}` : null,
    event.checkRunId ? `check run ${event.checkRunId}` : null,
    event.criterionId ? `criterion ${event.criterionId}` : null,
  ].filter((part): part is string => part !== null);
  const graph = event.graphEvidence
    ? `graph evidence ${event.graphEvidence.kind}: ${event.graphEvidence.label}${event.graphEvidence.source ? ` at ${event.graphEvidence.source.path}:${event.graphEvidence.source.startLine}-${event.graphEvidence.source.endLine}` : ''} · ${event.graphEvidence.provenance} · ${event.graphEvidence.extractionMethod}${event.graphEvidence.stale ? ' · graph node marked stale' : ''}`
    : null;
  const outcome = event.checkOutcome
    ? `runner ${event.checkOutcome.state}/${event.checkOutcome.status} · verified=${event.checkOutcome.verified} · exit=${event.checkOutcome.exitCode ?? 'none'} · signal=${event.checkOutcome.signal ?? 'none'} · processCount=${event.checkOutcome.effectiveLimits.processCount} · memory=${event.checkOutcome.effectiveLimits.memory}`
    : null;
  const details = [...refs, graph, outcome].filter((part): part is string => part !== null);
  return `- ${new Date(event.createdAt).toISOString()} · ${event.type} · ${event.body}${details.length ? ` · ${details.join(' · ')}` : ''}`;
}

/** Builds a distinct issue dossier; it never transitions an issue or equates check success with resolution. */
export async function generateInvestigationReport(
  projectId: string,
  issueId: string
): Promise<InvestigationReport | null> {
  const project = projectIdSchema.parse(projectId);
  const id = issueIdSchema.parse(issueId);
  const [issue, eventRows, latestGraph] = await Promise.all([
    getIssue(project, id),
    listIssueEvents(project, id),
    getLatestGraphSnapshot(project),
  ]);
  if (!issue) return null;

  const generatedAt = Date.now();
  const latestRevision = latestGraph?.revision ?? null;
  const events: InvestigationReportEvent[] = [];
  for (let offset = 0; offset < eventRows.length; offset += 8) {
    const batch = await Promise.all(
      eventRows.slice(offset, offset + 8).map(async (event) => {
        const graphNode =
          event.graphNodeId && event.revision
            ? await getGraphNode(project, event.revision, event.graphNodeId)
            : null;
        const graphEvidence =
          graphNode &&
          graphNode.projectId === project &&
          graphNode.revision === event.revision &&
          graphNode.issueId === id
            ? {
                kind: graphNode.kind,
                label: graphNode.label,
                source: graphNode.source,
                extractionMethod: graphNode.extractionMethod,
                provenance: graphNode.provenance,
                stale: graphNode.stale,
              }
            : null;
        const revisionStale =
          event.revision !== null &&
          ((latestRevision !== null && event.revision !== latestRevision) ||
            (issue.currentRevision !== null && event.revision !== issue.currentRevision));
        return {
          ...event,
          stale: revisionStale || graphEvidence?.stale === true,
          revisionUnknown:
            event.revision === null &&
            (event.type === 'observation' ||
              event.type === 'hypothesis' ||
              event.type === 'finding' ||
              event.type === 'evidence' ||
              event.type === 'graph_revision' ||
              event.type === 'graph_entry' ||
              event.type === 'check_result'),
          graphEvidence,
        };
      })
    );
    events.push(...batch);
  }
  const observations = events.filter((event) => event.evidenceKind === 'observation');
  const inferences = events.filter((event) => event.evidenceKind === 'inference');
  const investigationHistory = events.filter((event) => event.type === 'investigation_transition');
  const aiInvestigations = events.filter(
    (event) => event.type === 'ai_investigation' && event.aiInvestigation !== null
  );
  const staleCount = events.filter((event) => event.stale).length;
  const revisionUnknownCount = events.filter((event) => event.revisionUnknown).length;
  const staleGraphCount = events.filter((event) => event.graphEvidence?.stale).length;
  const evidenceReviewedAtLatestRevision = events.some(
    (event) =>
      event.type === 'evidence_reviewed' &&
      latestRevision !== null &&
      event.revision === latestRevision
  );
  const reasons = [
    'The dossier is a recorded investigation timeline, not proof of exhaustive coverage.',
  ];
  if (!latestRevision) reasons.push('No graph revision is available for comparison.');
  if (events.length === 0) reasons.push('No issue-linked evidence events have been recorded.');
  if (staleCount > 0)
    reasons.push(
      `${staleCount} event(s) reference a revision older than the latest graph revision.`
    );
  if (revisionUnknownCount > 0)
    reasons.push(
      `${revisionUnknownCount} evidence event(s) have no bound graph revision and cannot be freshness-checked.`
    );
  if (staleGraphCount > 0)
    reasons.push(`${staleGraphCount} linked graph node(s) are marked stale.`);
  if (issue.staleEvidence)
    reasons.push('The issue was explicitly marked with stale evidence or moved across revisions.');
  if (!issue.auditId) reasons.push('No related project audit is attached to this issue.');

  const resolution =
    issue.status === 'resolved'
      ? issue.staleEvidence ||
        staleGraphCount > 0 ||
        revisionUnknownCount > 0 ||
        (staleCount > 0 && !evidenceReviewedAtLatestRevision)
        ? `Resolution recorded, but evidence is stale or revision-unbound and requires review. Rationale: ${issue.resolutionRationale ?? '(not recorded)'}`
        : `Resolution recorded. Rationale: ${issue.resolutionRationale ?? '(not recorded)'}`
      : 'No resolution is recorded.';
  const uncertainty = [
    'Graph relationships are heuristic links, not causal proof.',
    'A passed or recorded check does not automatically resolve this issue.',
    ...(staleCount > 0 || issue.staleEvidence
      ? [
          'Revision changes can make prior evidence stale; review it before relying on the resolution.',
        ]
      : []),
    ...(revisionUnknownCount > 0
      ? ['Evidence without a graph revision cannot be compared for freshness.']
      : []),
    'Unrecorded behavior and evidence remain outside this report.',
  ];
  const markdown = [
    `# Investigation report: ${issue.title}`,
    '',
    `- Issue: ${issue.id}`,
    `- Project: ${project}`,
    `- Status: ${issue.status}`,
    `- Investigation phase: ${issue.investigationState}`,
    `- Priority: ${issue.priority}`,
    `- Current issue revision: ${issue.currentRevision ?? 'not set'}`,
    `- Latest graph revision: ${latestRevision ?? 'not available'}`,
    `- Generated: ${new Date(generatedAt).toISOString()}`,
    '',
    '## Description',
    issue.description || '(empty)',
    '',
    '## Resolution state',
    resolution,
    '',
    '## Observations (recorded)',
    observations.length ? observations.map(formatEvent).join('\n') : '- None recorded.',
    '',
    '## Inferences and hypotheses (not established facts)',
    inferences.length ? inferences.map(formatEvent).join('\n') : '- None recorded.',
    '',
    '## Investigation phase history',
    investigationHistory.length
      ? investigationHistory.map(formatEvent).join('\n')
      : '- No phase transitions recorded; current phase is shown above.',
    '',
    '## AI-generated investigation suggestions (advisory only)',
    aiInvestigations.length
      ? aiInvestigations
          .map((event) => {
            const result = event.aiInvestigation;
            if (!result) return '';
            const byId = new Map(
              result.evidenceReferences.map((reference) => [reference.id, reference])
            );
            const cite = (ids: string[]) =>
              ids.length
                ? ids
                    .map((id) => {
                      const reference = byId.get(id);
                      return reference
                        ? `${id} (${reference.label}${reference.path ? ` · ${reference.path}${reference.startLine ? `:${reference.startLine}` : ''}` : ''}${reference.freshness === 'stale' ? ' · stale' : ''})`
                        : `${id} (unavailable reference)`;
                    })
                    .join(', ')
                : 'no cited evidence';
            return [
              `### ${new Date(result.generatedAt).toISOString()} · ${result.provider}/${result.model}${event.stale ? ' · stale snapshot' : ''}`,
              '',
              '**AI output is a hypothesis and recommendation aid, not proof or an issue resolution.**',
              '',
              `Summary: ${result.summary} [${cite(result.summaryEvidenceIds)}]`,
              '',
              'Ranked hypotheses:',
              ...(result.hypotheses.length
                ? result.hypotheses.map(
                    (hypothesis) =>
                      `${hypothesis.rank}. ${hypothesis.statement} (${hypothesis.confidence} confidence) — ${hypothesis.rationale} [${cite(hypothesis.evidenceIds)}]`
                  )
                : ['- None returned.']),
              '',
              'Ranked recommendations:',
              ...(result.recommendations.length
                ? result.recommendations.map(
                    (recommendation) =>
                      `${recommendation.rank}. ${recommendation.action} — ${recommendation.rationale} [${cite(recommendation.evidenceIds)}]`
                  )
                : ['- None returned.']),
              '',
              'Limitations:',
              ...result.limitations.map((limitation) => `- ${limitation}`),
              ...result.evidenceReferences
                .filter((reference) => reference.freshness !== 'fresh')
                .map(
                  (reference) =>
                    `- ${reference.id} is ${reference.freshness}; certainty=${reference.certainty}; ${reference.provenance}/${reference.extractionMethod}.`
                ),
            ].join('\n');
          })
          .filter(Boolean)
          .join('\n\n')
      : '- No AI investigation snapshots have been generated.',
    '',
    '## Other timeline events',
    events.length
      ? events
          .filter(
            (event) => event.evidenceKind !== 'observation' && event.evidenceKind !== 'inference'
          )
          .map(formatEvent)
          .join('\n')
      : '- None recorded.',
    '',
    '## Coverage',
    'Partial —',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    '## Uncertainty',
    ...uncertainty.map((item) => `- ${item}`),
    '',
  ].join('\n');

  return {
    schemaVersion: 1,
    generatedAt,
    projectId: project,
    issueId: id,
    status: issue.status,
    investigationState: issue.investigationState,
    resolutionRationale: issue.resolutionRationale,
    resolvedAt: issue.resolvedAt,
    latestGraphRevision: latestRevision,
    issueRevision: issue.currentRevision,
    coverage: { status: 'partial', reasons },
    observations,
    inferences,
    investigationHistory,
    events,
    aiInvestigations,
    uncertainty,
    markdown,
  };
}
