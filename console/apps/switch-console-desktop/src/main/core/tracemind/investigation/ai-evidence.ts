import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { tracemindGraphRevisions } from '@main/db/schema';
import type {
  TraceMindEvidenceBundle,
  TraceMindEvidenceItem,
  TraceMindEvidenceKind,
} from '@shared/core/tracemind/ai-investigation';
import {
  getAudit,
  listAuditEvidence,
  type AuditEvidence,
  type AuditRecord,
} from '../audit/audit-store';
import {
  ensureGraphRevision,
  getGraphFileNodesPage,
  getGraphNode,
  getGraphOverview,
  searchGraphFiles,
} from '../graph/graph-store';
import type { PersistentGraphNode } from '../graph/model';
import { getIssue, listIssueEvents, type IssueEvent, type TraceMindIssue } from './issue-store';

export const AI_EVIDENCE_LIMITS = {
  items: 48,
  excerptBytes: 72 * 1024,
  perExcerptBytes: 1_200,
  issueExcerptBytes: 6_000,
  timelineEvents: 10,
  auditEvidencePages: 3,
  auditPageSize: 200,
  searchTerms: 4,
  graphFiles: 6,
  graphNodesPerFile: 4,
  sourceFiles: 4,
  sourceFileBytes: 4 * 1024 * 1024,
  sourceSampleBytes: 16 * 1024,
} as const;

const projectIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const safeRelativePath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 4096 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !/^[A-Za-z]:/.test(value) &&
  !/[\x00-\x1f\x7f]/.test(value) &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

function deterministicEvidenceId(
  projectId: string,
  issueId: string,
  kind: TraceMindEvidenceKind,
  stableSource: string
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([projectId, issueId, kind, stableSource]))
    .digest('hex')
    .slice(0, 32);
  return `evidence:${hash}`;
}

function utf8Limit(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maximumBytes) return value;
  return buffer
    .subarray(0, maximumBytes)
    .toString('utf8')
    .replace(/\uFFFD?$/, '…');
}

function issueTokens(issue: TraceMindIssue): string[] {
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'from',
    'that',
    'this',
    'when',
    'where',
    'what',
    'how',
    'why',
    'are',
    'was',
    'were',
    'has',
    'have',
    'had',
    'not',
    'but',
    'can',
    'could',
    'should',
    'would',
    'into',
    'onto',
    'about',
    'after',
    'before',
    'then',
    'than',
    'there',
    'their',
    'issue',
    'error',
    'bug',
    'fix',
    'trace',
    'mind',
    'please',
    'need',
    'want',
    'does',
    'did',
  ]);
  return [
    ...new Set(`${issue.title} ${issue.description}`.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []),
  ]
    .filter((token) => !stopWords.has(token) && token.length <= 128)
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, 20);
}

function relevanceScore(path: string, tokens: readonly string[]): number {
  const lowered = path.toLowerCase();
  return tokens.reduce(
    (score, token) => score + (lowered.includes(token) ? token.length + 2 : 0),
    0
  );
}

function mergeCandidatePaths(
  auditPaths: readonly AuditEvidence[],
  graphPaths: readonly { path: string; stale: boolean }[],
  eventPaths: readonly string[],
  tokens: readonly string[]
): string[] {
  const candidates = new Map<string, number>();
  for (const path of eventPaths) candidates.set(path, 1_000 + relevanceScore(path, tokens));
  for (const item of graphPaths) {
    const score = relevanceScore(item.path, tokens) + 100;
    candidates.set(item.path, Math.max(score, candidates.get(item.path) ?? 0));
  }
  for (const item of auditPaths) {
    const score = relevanceScore(item.path, tokens);
    if (score > 0) candidates.set(item.path, Math.max(score, candidates.get(item.path) ?? 0));
  }
  if (candidates.size === 0) {
    for (const item of auditPaths.slice(0, AI_EVIDENCE_LIMITS.graphFiles))
      candidates.set(item.path, 0);
  }
  return [...candidates]
    .sort(
      ([leftPath, leftScore], [rightPath, rightScore]) =>
        rightScore - leftScore || leftPath.localeCompare(rightPath)
    )
    .slice(0, AI_EVIDENCE_LIMITS.graphFiles)
    .map(([path]) => path);
}

function freshnessAgainstRevision(
  observedRevision: string | null,
  currentRevision: string | null
): TraceMindEvidenceItem['freshness'] {
  if (!observedRevision || !currentRevision) return 'unknown';
  return observedRevision === currentRevision ? 'fresh' : 'stale';
}

/** Reads only the graph revision header; loading a full project snapshot can be very large. */
async function getLatestGraphRevision(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ revision: tracemindGraphRevisions.revision })
    .from(tracemindGraphRevisions)
    .where(eq(tracemindGraphRevisions.projectId, projectId))
    .orderBy(desc(tracemindGraphRevisions.capturedAt), desc(tracemindGraphRevisions.revision))
    .limit(1);
  return rows[0]?.revision ?? null;
}

function sourceExcerptLines(
  content: string,
  tokens: readonly string[]
): {
  excerpt: string;
  startLine: number;
  endLine: number;
} {
  const lines = content.split(/\r?\n/);
  const matches = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const lowered = lines[index]!.toLowerCase();
    if (tokens.some((token) => lowered.includes(token))) {
      for (
        let nearby = Math.max(0, index - 2);
        nearby <= Math.min(lines.length - 1, index + 2);
        nearby += 1
      ) {
        matches.add(nearby);
      }
    }
  }
  const selected = matches.size
    ? [...matches].sort((a, b) => a - b).slice(0, 36)
    : lines.slice(0, 36).map((_, index) => index);
  if (selected.length === 0) return { excerpt: '', startLine: 1, endLine: 1 };
  const chunks: string[] = [];
  let previous = selected[0]! - 1;
  for (const index of selected) {
    if (index !== previous + 1) chunks.push('…');
    chunks.push(`${index + 1}: ${lines[index]}`);
    previous = index;
  }
  return {
    excerpt: utf8Limit(chunks.join('\n'), AI_EVIDENCE_LIMITS.perExcerptBytes),
    startLine: selected[0]! + 1,
    endLine: selected.at(-1)! + 1,
  };
}

async function readSafeSourceExcerpt(
  rootPath: string,
  relativePath: string,
  tokens: readonly string[],
  expectedFingerprint: string | undefined,
  auditCapturedAt: number | undefined
): Promise<{
  excerpt: string;
  freshness: TraceMindEvidenceItem['freshness'];
  startLine: number | null;
  endLine: number | null;
  limitation?: string;
} | null> {
  if (!safeRelativePath(relativePath)) return null;
  const root = await realpath(rootPath);
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) return null;

  const candidate = resolve(root, ...relativePath.split('/'));
  const pathFromRoot = relative(root, candidate);
  if (
    !pathFromRoot ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  )
    return null;
  try {
    const beforeLink = await lstat(candidate);
    if (beforeLink.isSymbolicLink() || !beforeLink.isFile()) return null;
    const resolved = await realpath(candidate);
    const resolvedFromRoot = relative(root, resolved);
    if (
      resolvedFromRoot === '..' ||
      resolvedFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(resolvedFromRoot)
    )
      return null;
    const before = await stat(resolved);
    let excerpt = '';
    let startLine: number | null = null;
    let endLine: number | null = null;
    let observedFingerprint: string | undefined;
    let limitation: string | undefined;

    if (before.size <= AI_EVIDENCE_LIMITS.sourceFileBytes) {
      const bytes = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await bytes.stat()).isFile()) return null;
        const content = await bytes.readFile();
        if (content.includes(0)) return null;
        observedFingerprint = createHash('sha256').update(content).digest('hex');
        const selected = sourceExcerptLines(content.toString('utf8'), tokens);
        excerpt = selected.excerpt;
        startLine = selected.startLine;
        endLine = selected.endLine;
      } finally {
        await bytes.close();
      }
    } else {
      const bytes = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await bytes.stat()).isFile()) return null;
        const sampleSize = Math.min(AI_EVIDENCE_LIMITS.sourceSampleBytes, before.size);
        const head = Buffer.alloc(sampleSize);
        const headRead = await bytes.read(head, 0, sampleSize, 0);
        if (head.subarray(0, headRead.bytesRead).includes(0)) return null;
        const headText = head.subarray(0, headRead.bytesRead).toString('utf8');
        const headExcerpt = sourceExcerptLines(headText, tokens);
        const tailOffset = Math.max(0, before.size - sampleSize);
        const tail = Buffer.alloc(sampleSize);
        const tailRead = await bytes.read(tail, 0, sampleSize, tailOffset);
        const tailText = tail.subarray(0, tailRead.bytesRead).toString('utf8');
        excerpt = utf8Limit(
          `${utf8Limit(headExcerpt.excerpt, 850)}\n… middle omitted; tail sample at byte ${tailOffset} (line range unknown) …\n${utf8Limit(tailText, 850)}`,
          AI_EVIDENCE_LIMITS.perExcerptBytes
        );
        startLine = headExcerpt.startLine;
        endLine = headExcerpt.endLine;
        limitation = `Source file exceeds ${AI_EVIDENCE_LIMITS.sourceFileBytes} bytes; only bounded head/tail samples were read, so the tail line numbers and full-file freshness were not verified.`;
      } finally {
        await bytes.close();
      }
    }

    const after = await stat(resolved);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      return {
        excerpt,
        freshness: 'unknown',
        startLine,
        endLine,
        limitation: 'Source changed while the excerpt was being read; freshness is unknown.',
      };
    }
    const freshness =
      observedFingerprint && expectedFingerprint
        ? observedFingerprint === expectedFingerprint
          ? 'fresh'
          : 'stale'
        : auditCapturedAt !== undefined && before.mtimeMs > auditCapturedAt
          ? 'stale'
          : 'unknown';
    return { excerpt, freshness, startLine, endLine, ...(limitation ? { limitation } : {}) };
  } catch {
    return null;
  }
}

function issueEvidence(projectId: string, issue: TraceMindIssue): TraceMindEvidenceItem {
  const excerpt = utf8Limit(
    `Status: ${issue.status}; priority: ${issue.priority}; investigation phase: ${issue.investigationState}.\n${issue.description}`,
    AI_EVIDENCE_LIMITS.issueExcerptBytes
  );
  return {
    id: deterministicEvidenceId(projectId, issue.id, 'issue', `issue:${issue.version}`),
    kind: 'issue',
    label: issue.title,
    excerpt,
    path: null,
    startLine: null,
    endLine: null,
    revision: issue.currentRevision,
    freshness: issue.staleEvidence ? 'stale' : issue.currentRevision ? 'fresh' : 'unknown',
    certainty: 'recorded',
    provenance: `TraceMind issue record version ${issue.version}`,
    extractionMethod: 'persisted-issue-record',
  };
}

function timelineEvidence(
  projectId: string,
  issue: TraceMindIssue,
  event: IssueEvent
): TraceMindEvidenceItem {
  const outcome = event.checkOutcome
    ? `\nCheck: ${event.checkOutcome.state}/${event.checkOutcome.status}; verified=${event.checkOutcome.verified}; exitCode=${event.checkOutcome.exitCode ?? 'unknown'}.`
    : '';
  const excerpt = utf8Limit(`${event.body}${outcome}`, AI_EVIDENCE_LIMITS.perExcerptBytes);
  const kind: TraceMindEvidenceKind = event.type === 'check_result' ? 'check' : 'timeline';
  return {
    id: deterministicEvidenceId(projectId, issue.id, kind, `event:${event.id}`),
    kind,
    label: `${event.type} · version ${event.issueVersion}`,
    excerpt,
    path: null,
    startLine: null,
    endLine: null,
    revision: event.revision,
    freshness: issue.staleEvidence
      ? 'stale'
      : freshnessAgainstRevision(event.revision, issue.currentRevision),
    certainty: event.type === 'hypothesis' || event.type === 'finding' ? 'heuristic' : 'recorded',
    provenance: `TraceMind issue timeline event ${event.id}`,
    extractionMethod: 'persisted-issue-event',
  };
}

function graphNodeEvidence(
  projectId: string,
  issue: TraceMindIssue,
  node: PersistentGraphNode,
  graphRevision: string
): TraceMindEvidenceItem {
  const source = node.source;
  return {
    id: deterministicEvidenceId(projectId, issue.id, 'graph', `${node.revision}:${node.id}`),
    kind: 'graph',
    label: `${node.kind}: ${node.label}`,
    excerpt: utf8Limit(
      `Graph node kind=${node.kind}; label=${node.label}; extraction=${node.extractionMethod}; certainty is structural evidence only.`,
      AI_EVIDENCE_LIMITS.perExcerptBytes
    ),
    path: source?.path ?? null,
    startLine: source?.startLine ?? null,
    endLine: source?.endLine ?? null,
    revision: node.revision,
    freshness: node.stale || node.revision !== graphRevision ? 'stale' : 'fresh',
    certainty: node.stale ? 'ambiguous' : node.kind === 'evidence' ? 'direct' : 'heuristic',
    provenance: node.provenance,
    extractionMethod: node.extractionMethod,
  };
}

function auditSummaryEvidence(
  projectId: string,
  issue: TraceMindIssue,
  audit: AuditRecord,
  linkedGraphFresh: boolean
): TraceMindEvidenceItem {
  const inventory = audit.inventory;
  const excerpt = [
    `Audit ${audit.id}; captured ${new Date(audit.capturedAt).toISOString()}; revision=${audit.revision ?? 'unknown'}; fingerprint=${audit.fingerprint ?? 'unavailable'}.`,
    `Files: discovered=${inventory.filesDiscovered}, parsed=${inventory.filesParsed}, skipped=${inventory.skipped}, inventoryComplete=${inventory.inventoryComplete}.`,
    `Languages: ${inventory.languages.map((entry) => `${entry.language} (${entry.files})`).join(', ') || 'none recorded'}.`,
    `Manifests: ${inventory.manifests.slice(0, 40).join(', ') || 'none recorded'}.`,
    `Limitations: ${inventory.limitations.slice(0, 12).join('; ') || 'none recorded'}.`,
  ].join('\n');
  return {
    id: deterministicEvidenceId(projectId, issue.id, 'audit', `audit:${audit.id}`),
    kind: 'audit',
    label: `Project audit · ${audit.id}`,
    excerpt: utf8Limit(excerpt, AI_EVIDENCE_LIMITS.perExcerptBytes),
    path: null,
    startLine: null,
    endLine: null,
    revision: audit.revision,
    freshness:
      issue.staleEvidence || !linkedGraphFresh
        ? 'stale'
        : audit.revision && audit.revision === issue.currentRevision
          ? 'fresh'
          : 'unknown',
    certainty: 'recorded',
    provenance: `Persisted TraceMind audit ${audit.id}`,
    extractionMethod: 'persisted-audit-summary',
  };
}

/**
 * Builds an issue-scoped, revision-labelled evidence bundle from the local TraceMind stores.
 * Every item is a citation target; structural graph relationships remain leads, not proof.
 */
export async function retrieveAIInvestigationEvidence(
  projectId: string,
  issue: TraceMindIssue,
  projectRoot: string
): Promise<TraceMindEvidenceBundle> {
  if (!projectIdPattern.test(projectId) || issue.locationId !== projectId)
    throw new Error('Issue project scope mismatch');
  const storedIssue = await getIssue(projectId, issue.id);
  if (!storedIssue) throw new Error('Issue not found in project');
  if (storedIssue.version !== issue.version)
    throw new Error('Issue has changed; reload it before generating an investigation');
  const root = await realpath(projectRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('Project root is not a directory');

  const evidence: TraceMindEvidenceItem[] = [];
  const evidenceIds = new Set<string>();
  const limitations = new Set<string>([
    'Retrieved evidence is a bounded local snapshot, not proof of runtime behavior or test coverage.',
    'Graph relationships and parser-derived labels are structural leads; model conclusions remain advisory.',
  ]);
  let totalExcerptBytes = 0;
  const add = (item: TraceMindEvidenceItem): boolean => {
    if (evidenceIds.has(item.id)) return true;
    if (evidence.length >= AI_EVIDENCE_LIMITS.items) {
      limitations.add(
        `Evidence item limit reached (${AI_EVIDENCE_LIMITS.items}); later items were omitted.`
      );
      return false;
    }
    const excerptBytes = Buffer.byteLength(item.excerpt, 'utf8');
    if (totalExcerptBytes + excerptBytes > AI_EVIDENCE_LIMITS.excerptBytes) {
      limitations.add(
        `Evidence excerpt byte limit reached (${AI_EVIDENCE_LIMITS.excerptBytes}); later excerpts were omitted.`
      );
      return false;
    }
    totalExcerptBytes += excerptBytes;
    evidence.push(item);
    evidenceIds.add(item.id);
    return true;
  };

  add(issueEvidence(projectId, issue));
  const events = await listIssueEvents(projectId, issue.id);
  const boundedEvents = events
    .filter((event) => (event.type as string) !== 'ai_investigation')
    .slice(-AI_EVIDENCE_LIMITS.timelineEvents);
  if (events.length > boundedEvents.length)
    limitations.add(
      `Only the latest ${AI_EVIDENCE_LIMITS.timelineEvents} non-AI issue timeline events are included.`
    );
  for (const event of boundedEvents) {
    if (!add(timelineEvidence(projectId, issue, event))) break;
  }

  const auditId =
    issue.auditId ?? [...boundedEvents].reverse().find((event) => event.auditId)?.auditId ?? null;
  let audit: AuditRecord | null = null;
  const auditFiles: AuditEvidence[] = [];
  if (auditId) {
    audit = await getAudit(projectId, auditId);
    if (audit) {
      for (let page = 0; page < AI_EVIDENCE_LIMITS.auditEvidencePages; page += 1) {
        const offset = page * AI_EVIDENCE_LIMITS.auditPageSize;
        const result = await listAuditEvidence(
          projectId,
          audit.id,
          offset,
          AI_EVIDENCE_LIMITS.auditPageSize
        );
        auditFiles.push(...result.items);
        if (result.nextOffset === null) break;
        if (page === AI_EVIDENCE_LIMITS.auditEvidencePages - 1)
          limitations.add(
            `Audit file evidence is paged; only the first ${auditFiles.length} paths were considered for retrieval.`
          );
      }
      if (audit.inventory.graphCoverage?.status === 'partial')
        limitations.add(
          `The linked audit reports partial graph parsing (${audit.inventory.graphCoverage.omittedFiles} files omitted).`
        );
    } else {
      limitations.add(`Linked audit ${auditId} is missing from local storage.`);
    }
  } else {
    limitations.add(
      'No issue-linked audit is recorded; audit and revision-scoped graph evidence may be unavailable.'
    );
  }

  const linkedGraphRevision = audit ? `audit:${audit.id}` : null;
  let graphRevision = await getLatestGraphRevision(projectId);
  if (!graphRevision && linkedGraphRevision) {
    await ensureGraphRevision(projectId, linkedGraphRevision);
    graphRevision = await getLatestGraphRevision(projectId);
  }
  const linkedGraphFresh =
    linkedGraphRevision !== null && graphRevision !== null && linkedGraphRevision === graphRevision;
  if (audit) add(auditSummaryEvidence(projectId, issue, audit, linkedGraphFresh));
  if (linkedGraphRevision && graphRevision && !linkedGraphFresh) {
    limitations.add(
      `Linked audit graph ${linkedGraphRevision} differs from latest graph ${graphRevision}; linked audit/source evidence is stale relative to the latest graph.`
    );
  } else if (linkedGraphRevision && !graphRevision) {
    limitations.add(
      `Linked audit graph ${linkedGraphRevision} could not be compared with a latest graph revision; linked audit/source evidence is stale or unverifiable.`
    );
  }
  let graphOverview: Awaited<ReturnType<typeof getGraphOverview>> = null;
  if (graphRevision) {
    graphOverview = await getGraphOverview(projectId, graphRevision, null);
    if (graphOverview) {
      add({
        id: deterministicEvidenceId(projectId, issue.id, 'graph', `${graphRevision}:overview`),
        kind: 'graph',
        label: `Graph snapshot overview · ${graphRevision}`,
        excerpt: `Nodes=${graphOverview.nodeCount}; relationships=${graphOverview.relationshipCount}; parser limitations=${graphOverview.parserFailureCount}; revision=${graphOverview.revision}. Relationships do not prove runtime behavior or test coverage.`,
        path: null,
        startLine: null,
        endLine: null,
        revision: graphOverview.revision,
        freshness: graphOverview.revision === graphRevision ? 'fresh' : 'stale',
        certainty: 'recorded',
        provenance: 'Persisted TraceMind graph overview',
        extractionMethod: 'graph-revision-summary',
      });
      if (graphOverview.parserFailureCount > 0)
        limitations.add(
          `${graphOverview.parserFailureCount} graph parser limitations are recorded in this revision.`
        );
      if (graphOverview.nextCursor)
        limitations.add(
          'Graph overview node preview is paginated; only its first page is used for context.'
        );
    } else {
      limitations.add(`No graph snapshot exists for ${graphRevision}.`);
    }
  }

  const tokens = issueTokens(issue);
  const graphFileMatches: { path: string; stale: boolean }[] = [];
  if (graphRevision) {
    const searchTerms = tokens.slice(0, AI_EVIDENCE_LIMITS.searchTerms);
    for (const term of searchTerms) {
      const page = await searchGraphFiles(projectId, graphRevision, term, null);
      if (page) {
        graphFileMatches.push(...page.files);
        if (page.nextCursor)
          limitations.add(
            `Graph file search for “${term}” is paginated; only its first ${page.files.length} matches were considered.`
          );
      }
    }
  }

  const eventGraphNodes: PersistentGraphNode[] = [];
  if (graphRevision) {
    for (const event of [...boundedEvents].reverse()) {
      if (!event.graphNodeId) continue;
      const node = await getGraphNode(projectId, graphRevision, event.graphNodeId);
      if (node) eventGraphNodes.push(node);
      if (eventGraphNodes.length >= 6) break;
    }
  }
  for (const node of eventGraphNodes)
    add(graphNodeEvidence(projectId, issue, node, graphRevision!));

  const candidatePaths = mergeCandidatePaths(
    auditFiles,
    graphFileMatches,
    eventGraphNodes.flatMap((node) => (node.source?.path ? [node.source.path] : [])),
    tokens
  );
  const auditByPath = new Map(auditFiles.map((item) => [item.path, item]));
  const sourcePaths: string[] = [];
  for (const path of candidatePaths) {
    if (!safeRelativePath(path)) {
      limitations.add('An unsafe relative path was rejected during evidence retrieval.');
      continue;
    }
    if (!graphRevision) continue;
    const page = await getGraphFileNodesPage(projectId, graphRevision, path, null);
    if (page) {
      for (const node of page.nodes.slice(0, AI_EVIDENCE_LIMITS.graphNodesPerFile)) {
        if (!add(graphNodeEvidence(projectId, issue, node, graphRevision))) break;
      }
      if (page.nextCursor)
        limitations.add(
          `Graph nodes from ${path} are paginated; only the first ${AI_EVIDENCE_LIMITS.graphNodesPerFile} are used.`
        );
    }
    if (sourcePaths.length < AI_EVIDENCE_LIMITS.sourceFiles) sourcePaths.push(path);
  }

  let sourceBytes = 0;
  for (const path of sourcePaths) {
    const source = await readSafeSourceExcerpt(
      root,
      path,
      tokens,
      auditByPath.get(path)?.fingerprint,
      audit?.capturedAt
    );
    if (!source || !source.excerpt) {
      limitations.add(
        `Source excerpt unavailable for ${path}; the file may be absent, unsafe, unreadable, or non-text.`
      );
      continue;
    }
    const bytes = Buffer.byteLength(source.excerpt, 'utf8');
    if (sourceBytes + bytes > 8 * 1024) {
      limitations.add('Source excerpt retrieval reached its 8 KiB source-only budget.');
      break;
    }
    sourceBytes += bytes;
    add({
      id: deterministicEvidenceId(
        projectId,
        issue.id,
        'source_excerpt',
        `${audit?.id ?? 'no-audit'}:${path}`
      ),
      kind: 'source_excerpt',
      label: path,
      excerpt: source.excerpt,
      path,
      startLine: source.startLine,
      endLine: source.endLine,
      revision: audit ? (audit.revision ?? `audit:${audit.id}`) : graphRevision,
      freshness: linkedGraphRevision && !linkedGraphFresh ? 'stale' : source.freshness,
      certainty: source.freshness === 'stale' ? 'ambiguous' : 'direct',
      provenance: audit
        ? `Current local source compared with audit ${audit.id}`
        : 'Current local source; no audit fingerprint recorded',
      extractionMethod: beforeSourceExtractionMethod(path, source.limitation),
    });
    if (source.limitation) limitations.add(source.limitation);
  }

  if (auditFiles.length > 0 && candidatePaths.length === 0)
    limitations.add(
      'No audit or graph file path matched the issue terms; no source excerpts were selected.'
    );
  const currentRevision = graphRevision;
  return {
    projectId,
    issueId: issue.id,
    issueVersion: issue.version,
    currentRevision,
    issue: {
      title: issue.title,
      description: utf8Limit(issue.description, AI_EVIDENCE_LIMITS.issueExcerptBytes),
      status: issue.status,
      priority: issue.priority,
      investigationState: issue.investigationState,
    },
    evidence,
    limitations: [...limitations].slice(0, 40),
  };
}

function beforeSourceExtractionMethod(path: string, limitation: string | undefined): string {
  return limitation ? 'bounded-head-tail-source-sample' : `validated-local-source-excerpt:${path}`;
}
