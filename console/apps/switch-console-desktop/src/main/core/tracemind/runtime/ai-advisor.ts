import { randomUUID } from 'node:crypto';
import type {
  TraceMindAIModelResponse,
  TraceMindEvidenceBundle,
  TraceMindEvidenceItem,
  TraceMindRuntimeAIAdvisory,
} from '@shared/core/tracemind/ai-investigation';
import { generateTraceMindAIResponse } from '../ai/gateway';
import { redactOutboundText } from '../ai/redaction';
import type { RuntimeIncident, RuntimeSnapshot } from './model';

export const RUNTIME_AI_MAX_INCIDENTS_PER_REQUEST = 10;

export type TraceMindAIGenerate = (
  bundle: TraceMindEvidenceBundle,
  signal?: AbortSignal
) => Promise<{ model: string; response: TraceMindAIModelResponse }>;

export function createRuntimeEvidenceBundle(
  snapshot: RuntimeSnapshot,
  incidents: readonly RuntimeIncident[]
): TraceMindEvidenceBundle {
  if (incidents.length === 0)
    throw new Error('No new runtime incidents are available for analysis.');
  if (incidents.length > RUNTIME_AI_MAX_INCIDENTS_PER_REQUEST) {
    throw new Error('Too many new runtime incidents for one AI request.');
  }
  const snapshotIncidentIds = new Set(snapshot.incidents.map((incident) => incident.id));
  const seen = new Set<string>();
  for (const incident of incidents) {
    if (!snapshotIncidentIds.has(incident.id) || seen.has(incident.id)) {
      throw new Error('Runtime incident is not part of the current local snapshot.');
    }
    seen.add(incident.id);
  }

  const evidence: TraceMindEvidenceItem[] = incidents.map((incident, index) => {
    const title = redactOutboundText(incident.title.slice(0, 500));
    const serviceName = redactOutboundText(incident.serviceName.slice(0, 256));
    const explanation = redactOutboundText(incident.explanation.slice(0, 1_000));
    return {
      id: incident.id,
      kind: 'runtime',
      label: `Runtime incident ${index + 1}: ${title}`,
      excerpt: [
        `Severity: ${incident.severity}`,
        `Service: ${serviceName}`,
        `Correlation: ${incident.correlation}`,
        `Signal count: ${incident.signalCount}`,
        `First observed: ${new Date(incident.firstSeenAt).toISOString()}`,
        `Last observed: ${new Date(incident.lastSeenAt).toISOString()}`,
        `Local correlation note: ${explanation}`,
      ].join('\n'),
      path: null,
      startLine: null,
      endLine: null,
      revision: snapshot.auditRevision,
      freshness: snapshot.auditRevision ? 'fresh' : 'unknown',
      certainty: 'heuristic',
      provenance: 'Locally correlated runtime incident; raw logs and attributes are excluded.',
      extractionMethod: 'TraceMind runtime incident summary v1',
    };
  });

  return {
    projectId: snapshot.locationId,
    issueId: snapshot.auditId,
    issueVersion: snapshot.acceptedCount,
    currentRevision: snapshot.auditRevision,
    issue: {
      title: 'Runtime incident review',
      description:
        'Review only the supplied local incident summaries. The underlying runtime payload, logs, attributes, source code, and project files are not included.',
      status: 'investigating',
      priority: incidents.some((incident) => incident.severity === 'error') ? 'high' : 'medium',
      investigationState: 'runtime_monitoring',
    },
    evidence,
    limitations: [
      'This analysis is advisory and cannot establish root cause or prove an intrusion.',
      'Only allow-listed incident summary fields were selected; raw runtime messages, trace IDs, attributes, and code were excluded.',
      ...(snapshot.truncated ? ['The local runtime snapshot is truncated or incomplete.'] : []),
    ],
  };
}

export async function generateRuntimeAIAdvisory(
  snapshot: RuntimeSnapshot,
  incidents: readonly RuntimeIncident[],
  generate: TraceMindAIGenerate = (bundle, signal) =>
    generateTraceMindAIResponse(bundle, { signal }),
  signal?: AbortSignal
): Promise<TraceMindRuntimeAIAdvisory> {
  const bundle = createRuntimeEvidenceBundle(snapshot, incidents);
  const { model, response } = await generate(bundle, signal);
  const allowedIds = new Set(bundle.evidence.map((item) => item.id));
  const citations = [
    ...response.summaryEvidenceIds,
    ...response.hypotheses.flatMap((hypothesis) => hypothesis.evidenceIds),
    ...response.recommendations.flatMap((recommendation) => recommendation.evidenceIds),
  ];
  if (citations.some((id) => !allowedIds.has(id))) {
    throw new Error('AI provider cited runtime evidence outside the current snapshot.');
  }
  return {
    ...response,
    schemaVersion: 1,
    id: randomUUID(),
    provider: 'openai-compatible',
    model,
    generatedAt: Date.now(),
    projectId: snapshot.locationId,
    auditId: snapshot.auditId,
    evidenceRevision: snapshot.auditRevision,
    incidentIds: incidents.map((incident) => incident.id),
  };
}
