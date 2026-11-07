import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvidence, AuditRecord } from '../audit/audit-store';
import type { GraphOverview } from '../graph/graph-store';
import type { PersistentGraphNode } from '../graph/model';
import type { TraceMindIssue } from './issue-store';

const fixture = vi.hoisted(() => ({
  issue: undefined as TraceMindIssue | undefined,
  events: [] as any[],
  audit: undefined as AuditRecord | undefined,
  auditFiles: [] as AuditEvidence[],
  graphOverview: undefined as GraphOverview | undefined,
  graphNodes: new Map<string, PersistentGraphNode[]>(),
  graphFiles: new Map<string, { id: string; path: string; stale: boolean }[]>(),
  graphNodeLookup: new Map<string, PersistentGraphNode>(),
  latestGraphRevision: null as string | null,
}));

vi.mock('drizzle-orm', () => ({
  desc: vi.fn((value: unknown) => ({ direction: 'desc', value })),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
}));
vi.mock('@main/db/client', () => ({
  db: {
    select: vi.fn(() => {
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(async () =>
          fixture.latestGraphRevision ? [{ revision: fixture.latestGraphRevision }] : []
        ),
      };
      return query;
    }),
  },
}));
vi.mock('@main/db/schema', () => ({
  tracemindGraphRevisions: {
    projectId: 'project_id',
    revision: 'revision',
    capturedAt: 'captured_at',
  },
}));

vi.mock('./issue-store', () => ({
  getIssue: vi.fn(async (projectId: string, issueId: string) =>
    fixture.issue?.locationId === projectId && fixture.issue.id === issueId ? fixture.issue : null
  ),
  listIssueEvents: vi.fn(async (projectId: string, issueId: string) =>
    fixture.issue?.locationId === projectId && fixture.issue.id === issueId ? fixture.events : []
  ),
}));
vi.mock('../audit/audit-store', () => ({
  getAudit: vi.fn(async (projectId: string, auditId: string) =>
    fixture.audit?.locationId === projectId && fixture.audit.id === auditId ? fixture.audit : null
  ),
  listAuditEvidence: vi.fn(
    async (_projectId: string, _auditId: string, offset: number, limit: number) => ({
      items: fixture.auditFiles.slice(offset, offset + limit),
      nextOffset: offset + limit < fixture.auditFiles.length ? offset + limit : null,
    })
  ),
}));
vi.mock('../graph/graph-store', () => ({
  ensureGraphRevision: vi.fn(async () => true),
  getGraphOverview: vi.fn(async (projectId: string, revision: string) =>
    fixture.graphOverview?.revision === revision ? fixture.graphOverview : null
  ),
  getGraphFileNodesPage: vi.fn(async (_projectId: string, revision: string, path: string) => {
    const nodes = fixture.graphNodes.get(path);
    return nodes ? { revision, path, nodes, nextCursor: null } : null;
  }),
  getGraphNode: vi.fn(
    async (_projectId: string, _revision: string, nodeId: string) =>
      fixture.graphNodeLookup.get(nodeId) ?? null
  ),
  searchGraphFiles: vi.fn(async (_projectId: string, revision: string, term: string) => ({
    revision,
    files: fixture.graphFiles.get(term) ?? [],
    nextCursor: null,
  })),
}));

const { retrieveAIInvestigationEvidence } = await import('./ai-evidence');

const issueId = '00000000-0000-4000-8000-000000000001';
const auditId = '00000000-0000-4000-8000-000000000002';
const projectId = 'local-1';
const revision = 'a'.repeat(40);

function makeIssue(overrides: Partial<TraceMindIssue> = {}): TraceMindIssue {
  return {
    id: issueId,
    locationId: projectId,
    title: 'Token refresh in checkout',
    description: 'Checkout token refresh returns an error when an expired token is retried.',
    auditId,
    version: 2,
    createdAt: 10,
    updatedAt: 20,
    status: 'investigating',
    priority: 'high',
    owner: null,
    currentRevision: revision,
    staleEvidence: false,
    resolutionRationale: null,
    resolvedAt: null,
    investigationState: 'gathering_evidence',
    ...overrides,
  };
}

function makeAudit(): AuditRecord {
  return {
    id: auditId,
    locationId: projectId,
    root: '/repo',
    identity: '1:2',
    revision,
    dirty: false,
    fingerprint: 'd'.repeat(64),
    capturedAt: Date.now() + 60_000,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 1,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [{ language: 'TypeScript', files: 1 }],
      manifests: ['package.json'],
      limitations: [],
    },
  };
}

function makeGraphNode(
  path: string,
  id = 'node-token',
  graphRevision = `audit:${auditId}`
): PersistentGraphNode {
  return {
    schemaVersion: 1,
    id,
    projectId,
    issueId,
    revision: graphRevision,
    kind: 'symbol',
    label: `${path}:refreshToken`,
    source: { path, startLine: 1, endLine: 2 },
    extractionMethod: 'typescript-ast-v3',
    provenance: `audit:${auditId};parser:typescript`,
    stale: false,
    createdAt: 1,
  };
}

function makeGraphOverview(graphRevision = `audit:${auditId}`): GraphOverview {
  return {
    revision: graphRevision,
    rootNodeId: 'root',
    nodeCount: 4,
    relationshipCount: 3,
    nodeCounts: {} as GraphOverview['nodeCounts'],
    relationshipCounts: {} as GraphOverview['relationshipCounts'],
    parserFailureCount: 0,
    nodes: [],
    nextCursor: null,
    parserFailures: [],
    retrievalReasons: [],
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    projectId,
    issueId,
    issueVersion: 2,
    type: 'finding',
    body: 'Observed token refresh fail after expiry.',
    evidenceKind: 'inference',
    auditId,
    revision,
    graphNodeId: null,
    checkRunId: null,
    criterionId: null,
    checkOutcome: null,
    investigationState: 'gathering_evidence',
    investigationOutcome: null,
    createdAt: 30,
    ...overrides,
  };
}

let root: string;
let sourceBytes: Buffer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tracemind-ai-evidence-'));
  await mkdir(join(root, 'src'), { recursive: true });
  sourceBytes = Buffer.from(
    'export function refreshToken(token: string) {\n  return retry(token);\n}\n'
  );
  await writeFile(join(root, 'src/token-refresh.ts'), sourceBytes);
  fixture.issue = makeIssue();
  fixture.events = [makeEvent()];
  fixture.audit = makeAudit();
  fixture.auditFiles = [
    {
      path: 'src/token-refresh.ts',
      fingerprint: createHash('sha256').update(sourceBytes).digest('hex'),
    },
  ];
  fixture.graphOverview = makeGraphOverview();
  fixture.graphNodes = new Map([['src/token-refresh.ts', [makeGraphNode('src/token-refresh.ts')]]]);
  fixture.graphFiles = new Map([
    ['token', [{ id: 'file-token', path: 'src/token-refresh.ts', stale: false }]],
  ]);
  fixture.graphNodeLookup = new Map();
  fixture.latestGraphRevision = `audit:${auditId}`;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('retrieveAIInvestigationEvidence', () => {
  it('combines issue, timeline, audit, graph, and verified source excerpts with stable citation IDs', async () => {
    const first = await retrieveAIInvestigationEvidence(projectId, fixture.issue!, root);
    const second = await retrieveAIInvestigationEvidence(projectId, fixture.issue!, root);
    expect(first).toEqual(second);
    expect(new Set(first.evidence.map((item) => item.id)).size).toBe(first.evidence.length);
    expect(first.evidence.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['issue', 'timeline', 'audit', 'graph', 'source_excerpt'])
    );
    const source = first.evidence.find((item) => item.kind === 'source_excerpt');
    expect(source).toMatchObject({
      path: 'src/token-refresh.ts',
      freshness: 'fresh',
      certainty: 'direct',
    });
    expect(source?.excerpt).toContain('refreshToken');
    expect(first.evidence.find((item) => item.kind === 'graph')?.certainty).toBe('recorded');
    expect(first.limitations).toContain(
      'Retrieved evidence is a bounded local snapshot, not proof of runtime behavior or test coverage.'
    );
  });

  it('rejects project/issue mismatches before reading another project timeline', async () => {
    await expect(
      retrieveAIInvestigationEvidence('other-project', fixture.issue!, root)
    ).rejects.toThrow('Issue project scope mismatch');
  });

  it('uses the latest graph revision and marks linked audit/source evidence stale when it differs from the Git revision', async () => {
    const latestGraphRevision = 'audit:00000000-0000-4000-8000-000000000099';
    fixture.latestGraphRevision = latestGraphRevision;
    fixture.graphOverview = makeGraphOverview(latestGraphRevision);
    fixture.graphNodes = new Map([
      [
        'src/token-refresh.ts',
        [makeGraphNode('src/token-refresh.ts', 'node-latest', latestGraphRevision)],
      ],
    ]);

    const result = await retrieveAIInvestigationEvidence(projectId, fixture.issue!, root);
    const auditItem = result.evidence.find((item) => item.kind === 'audit');
    const sourceItem = result.evidence.find((item) => item.kind === 'source_excerpt');
    const graphOverview = result.evidence.find((item) =>
      item.label.startsWith('Graph snapshot overview')
    );

    expect(result.currentRevision).toBe(latestGraphRevision);
    expect(auditItem).toMatchObject({ revision, freshness: 'stale' });
    expect(sourceItem).toMatchObject({ revision, freshness: 'stale' });
    expect(graphOverview).toMatchObject({ revision: latestGraphRevision, freshness: 'fresh' });
    expect(result.limitations).toContain(
      `Linked audit graph audit:${auditId} differs from latest graph ${latestGraphRevision}; linked audit/source evidence is stale relative to the latest graph.`
    );
  });

  it('does not follow symlinks that point outside the selected project root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tracemind-outside-'));
    await writeFile(join(outside, 'private.ts'), 'export const token = "outside";');
    await unlink(join(root, 'src/token-refresh.ts'));
    await symlink(join(outside, 'private.ts'), join(root, 'src/token-refresh.ts'));
    const result = await retrieveAIInvestigationEvidence(projectId, fixture.issue!, root);
    expect(result.evidence.some((item) => item.kind === 'source_excerpt')).toBe(false);
    expect(result.limitations).toContain(
      'Source excerpt unavailable for src/token-refresh.ts; the file may be absent, unsafe, unreadable, or non-text.'
    );
  });

  it('rejects traversal paths and never emits their contents', async () => {
    fixture.auditFiles = [{ path: '../outside/token-refresh.ts', fingerprint: 'e'.repeat(64) }];
    fixture.graphFiles.set('token', [
      { id: 'unsafe', path: '../outside/token-refresh.ts', stale: false },
    ]);
    const result = await retrieveAIInvestigationEvidence(projectId, fixture.issue!, root);
    expect(result.evidence.some((item) => item.path?.startsWith('..'))).toBe(false);
    expect(result.limitations).toContain(
      'An unsafe relative path was rejected during evidence retrieval.'
    );
  });

  it('samples large files within a strict byte budget and labels unverifiable freshness', async () => {
    const large = Buffer.alloc(5 * 1024 * 1024, 0x61);
    large.write('token refresh near beginning', 0, 'utf8');
    large.write('token refresh at tail', large.length - 64, 'utf8');
    await writeFile(join(root, 'src/token-refresh.ts'), large);
    const result = await retrieveAIInvestigationEvidence(projectId, fixture.issue!, root);
    const source = result.evidence.find((item) => item.kind === 'source_excerpt');
    expect(source?.freshness).toBe('unknown');
    expect(source?.excerpt).toContain('middle omitted; tail sample');
    expect(Buffer.byteLength(source?.excerpt ?? '', 'utf8')).toBeLessThanOrEqual(2_400);
    expect(
      result.limitations.some((item) =>
        item.includes('tail line numbers and full-file freshness were not verified')
      )
    ).toBe(true);
  });

  it('marks a source stale when its full content fingerprint no longer matches the audit', async () => {
    fixture.auditFiles = [{ path: 'src/token-refresh.ts', fingerprint: 'f'.repeat(64) }];
    const result = await retrieveAIInvestigationEvidence(projectId, fixture.issue!, root);
    expect(result.evidence.find((item) => item.kind === 'source_excerpt')?.freshness).toBe('stale');
  });

  it('adds recorded check outcomes without claiming a check proves issue resolution', async () => {
    fixture.events = [
      makeEvent({
        id: '00000000-0000-4000-8000-000000000020',
        type: 'check_result',
        body: 'Focused check completed.',
        evidenceKind: 'execution',
        checkOutcome: {
          runId: '00000000-0000-4000-8000-000000000030',
          state: 'finished',
          status: 'exited',
          verified: true,
          exitCode: 0,
          signal: null,
          effectiveLimits: { processCount: false, memory: false },
        },
      }),
    ];
    const result = await retrieveAIInvestigationEvidence(projectId, fixture.issue!, root);
    expect(result.evidence.find((item) => item.kind === 'check')?.excerpt).toContain(
      'verified=true'
    );
    expect(result.limitations).toContain(
      'Retrieved evidence is a bounded local snapshot, not proof of runtime behavior or test coverage.'
    );
  });
});
