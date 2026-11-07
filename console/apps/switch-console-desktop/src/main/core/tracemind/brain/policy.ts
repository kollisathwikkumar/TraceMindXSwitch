import { z } from 'zod';
import type {
  TraceMindEvidenceBundle,
  TraceMindEvidenceItem,
} from '@shared/core/tracemind/ai-investigation';
import { redactOutboundText } from '../ai/redaction';
import { isExcludedPathEntry } from '../audit/exclusions';

export function isBrainPath(path: string): boolean {
  if (!path || path.length > 4096 || /[\\\x00-\x1f\x7f:]/.test(path) || path.startsWith('/'))
    return false;
  const parts = path.split('/');
  return parts.every(
    (part, index) =>
      part !== '' &&
      part !== '.' &&
      part !== '..' &&
      !isExcludedPathEntry(part, index < parts.length - 1, parts.slice(0, index + 1).join('/'))
  );
}
export const brainPolicySchema = z.strictObject({
  enabled: z.boolean(),
  bridgeEnabled: z.boolean(),
  shareNotes: z.boolean(),
  allowedPaths: z.array(z.string().refine(isBrainPath)).max(200),
  endpoint: z.string().max(2048),
  model: z.string().max(100),
  root: z.string().min(1).max(4096),
  identity: z.string().regex(/^\d{1,40}:\d{1,40}$/),
});
export type BrainPolicy = z.infer<typeof brainPolicySchema>;

/** One egress boundary for brain, investigation and runtime calls. No spreads from local records. */
export function projectForModel(
  bundle: TraceMindEvidenceBundle,
  input: BrainPolicy
): TraceMindEvidenceBundle {
  const policy = brainPolicySchema.parse(input);
  if (!policy.enabled) throw new Error('Project model sharing is disabled.');
  const paths = new Set(policy.allowedPaths);
  const clean = (value: string, limit: number) => redactOutboundText(value).slice(0, limit);
  const evidence: TraceMindEvidenceItem[] = bundle.evidence
    .filter((item) =>
      item.path
        ? isBrainPath(item.path) && paths.has(item.path)
        : policy.shareNotes && ['issue', 'timeline', 'check', 'runtime'].includes(item.kind)
    )
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.path ? clean(item.path, 1000) : item.kind,
      excerpt:
        policy.shareNotes && item.kind !== 'source_excerpt'
          ? clean(item.excerpt, 6000)
          : 'Local evidence exists; content was not shared.',
      path: item.path ? clean(item.path, 1000) : null,
      startLine: item.startLine,
      endLine: item.endLine,
      revision: null,
      freshness: item.freshness,
      certainty: item.certainty,
      provenance: 'Project-scoped local evidence',
      extractionMethod: 'allowlisted-brain-context',
    }));
  if (!evidence.length) throw new Error('No project evidence is approved for model sharing.');
  return {
    projectId: bundle.projectId,
    issueId: bundle.issueId,
    issueVersion: bundle.issueVersion,
    currentRevision: null,
    issue: {
      title: clean(bundle.issue.title, 1000),
      description: clean(bundle.issue.description, 8000),
      status: bundle.issue.status,
      priority: bundle.issue.priority,
      investigationState: 'advisory',
    },
    evidence,
    limitations: [
      'Only approved paths and optionally redacted notes are shared. Source contents, local roots, credentials, and other project records are excluded. Missing context is unknown, not evidence of absence.',
    ],
  };
}
