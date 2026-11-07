import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '../audit/audit-store';
import type { StoredGraphSnapshot } from './graph-store';
import { graphSnapshotSchema, type GraphSnapshot } from './model';

const mocks = vi.hoisted(() => ({
  snapshots: [] as StoredGraphSnapshot[],
  commit: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('./graph-store', () => ({
  getLatestGraphSnapshot: async () =>
    [...mocks.snapshots].sort((left, right) => right.capturedAt - left.capturedAt)[0] ?? null,
  markGraphStale: async (projectId: string, paths: readonly string[]) => {
    mocks.invalidate(projectId, paths);
    return { revisions: 0, nodes: 0, relationships: 0 };
  },
  saveGraphSnapshotAndMarkStale: async (
    snapshot: GraphSnapshot,
    changedPaths: readonly string[],
    capturedAt: number
  ): Promise<{
    snapshot: StoredGraphSnapshot;
    invalidated: { revisions: number; nodes: number; relationships: number };
  }> => {
    const stored = { ...snapshot, capturedAt };
    mocks.snapshots.push(stored);
    mocks.commit(snapshot, changedPaths);
    return { snapshot: stored, invalidated: { revisions: 0, nodes: 0, relationships: 0 } };
  },
}));

const { indexAuditGraph } = await import('./graph-service');
const parser = await import('./parser-adapters');

const audit = (id: string): AuditRecord => ({
  id,
  locationId: 'local-1',
  root: '/repo',
  identity: '1:2',
  revision: null,
  dirty: null,
  fingerprint: 'a'.repeat(64),
  capturedAt: 1,
  inventory: {
    filesDiscovered: 1,
    filesParsed: 1,
    skipped: 0,
    inventoryComplete: true,
    errors: [],
    languages: [{ language: 'TypeScript', files: 1 }],
    manifests: [],
    limitations: [],
  },
});

describe('incremental graph indexing', () => {
  beforeEach(() => {
    mocks.snapshots = [];
    mocks.commit.mockClear();
    mocks.invalidate.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reuses unchanged file extraction under the new revision without reparsing', async () => {
    const parse = vi.spyOn(parser, 'parseSource');
    const file = {
      path: 'src/a.ts',
      fingerprint: 'b'.repeat(64),
      content: 'export function retained() { return 1; }',
    };
    const first = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000001'), [file]);
    expect(first.snapshot.nodes.some((node) => node.label === 'src/a.ts:retained')).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);

    const second = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000002'), [file]);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(second.snapshot.revision).toBe('audit:00000000-0000-4000-8000-000000000002');
    expect(second.snapshot.nodes.some((node) => node.label === 'src/a.ts:retained')).toBe(true);
    expect(second.snapshot.nodes.every((node) => node.revision === second.snapshot.revision)).toBe(
      true
    );
    expect(
      second.snapshot.relationships.every((edge) => edge.revision === second.snapshot.revision)
    ).toBe(true);
    expect(
      second.snapshot.nodes.find((node) => node.label === 'src/a.ts:retained')?.extractionMethod
    ).toContain('reused');
    const third = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000003'), [file]);
    const retained = third.snapshot.nodes.find((node) => node.label === 'src/a.ts:retained');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(retained?.extractionMethod).toBe('reused-typescript-ast-v4');
    expect(retained?.provenance.length).toBeLessThan(256);
  });

  it('keeps files without a fingerprint visible and conservatively invalidates prior paths', async () => {
    const firstId = '00000000-0000-4000-8000-000000000010';
    const secondId = '00000000-0000-4000-8000-000000000011';
    const priorFiles = [
      { path: 'large.ts', fingerprint: 'a'.repeat(64), content: 'export const large = 1;' },
      { path: 'small.ts', fingerprint: 'b'.repeat(64), content: 'export const small = 1;' },
    ];
    await indexAuditGraph(audit(firstId), priorFiles);

    const nextAudit = {
      ...audit(secondId),
      fingerprint: null,
      inventory: {
        ...audit(secondId).inventory,
        filesDiscovered: 2,
        filesParsed: 1,
        graphCoverage: { status: 'partial' as const, omittedFiles: 1 },
      },
    };
    const result = await indexAuditGraph(nextAudit, [
      {
        path: 'large.ts',
        fingerprint: null,
        content: null,
        omissionReason: 'fingerprint_limit',
      },
      {
        path: 'small.ts',
        fingerprint: 'c'.repeat(64),
        content: 'export function small() { return 2; }',
      },
    ]);

    expect(
      result.snapshot.nodes.some((node) => node.kind === 'file' && node.label === 'large.ts')
    ).toBe(true);
    const largeNode = result.snapshot.nodes.find(
      (node) => node.kind === 'file' && node.label === 'large.ts'
    );
    expect(
      result.snapshot.relationships.some(
        (edge) => edge.relation === 'CONTAINS' && edge.targetId === largeNode?.id
      )
    ).toBe(true);
    expect(
      result.snapshot.nodes.some(
        (node) => node.kind === 'evidence' && node.source?.path === 'large.ts'
      )
    ).toBe(false);
    expect(result.snapshot.nodes.some((node) => node.label === 'small.ts:small')).toBe(true);
    expect(result.parserFailures).toContainEqual(
      expect.objectContaining({
        path: 'large.ts',
        language: 'audit-file',
        message: expect.stringContaining('fingerprint byte budget'),
      })
    );
    expect(mocks.commit.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(['large.ts', 'small.ts'])
    );
  });

  it('bounds persisted diagnostics without dropping file nodes or omission coverage', async () => {
    const files = Array.from({ length: 10_001 }, (_, index) => ({
      path: `large/file-${index}.ts`,
      fingerprint: null,
      content: null,
      omissionReason: 'large_file' as const,
    }));
    const result = await indexAuditGraph(
      {
        ...audit('00000000-0000-4000-8000-000000000013'),
        fingerprint: null,
        inventory: {
          ...audit('00000000-0000-4000-8000-000000000013').inventory,
          filesDiscovered: files.length,
          filesParsed: 0,
          graphCoverage: { status: 'partial', omittedFiles: files.length },
        },
      },
      files
    );
    const { capturedAt: _capturedAt, ...snapshot } = result.snapshot;
    expect(graphSnapshotSchema.parse(snapshot)).toBeDefined();
    expect(result.snapshot.nodes.filter((node) => node.kind === 'file')).toHaveLength(files.length);
    expect(result.snapshot.parserFailures).toHaveLength(10_000);
    expect(result.snapshot.parserFailures[0]).toMatchObject({
      language: 'diagnostics-limit',
      message: expect.stringContaining('10001 files affected'),
    });
    expect(result.snapshot.parserFailures[0]?.message).toContain('2 additional diagnostics');
    expect(result.omittedFiles).toBe(files.length);
    expect(result.filesParsed).toBe(0);
  });

  it('indexes the previous revision once rather than rescanning it for each unchanged file', async () => {
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      fingerprint: index.toString(16).padStart(64, '0'),
      content: `export function function_${index}() { return ${index}; }`,
    }));
    await indexAuditGraph(audit('00000000-0000-4000-8000-000000000004'), files);
    const previous = mocks.snapshots[0]!;
    const findNodes = vi.spyOn(previous.nodes, 'find');
    const mapNodes = vi.spyOn(previous.nodes, 'map');

    const next = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000005'), files);

    expect(findNodes).toHaveBeenCalledTimes(0);
    expect(mapNodes).toHaveBeenCalledTimes(0);
    expect(
      next.snapshot.nodes.filter((node) => node.extractionMethod === 'reused-typescript-ast-v4')
    ).toHaveLength(files.length);
  });

  it('retains a parser diagnostic when its unchanged file extraction is reused', async () => {
    const parse = vi.spyOn(parser, 'parseSource');
    const file = { path: 'README.md', fingerprint: 'e'.repeat(64), content: 'unsupported' };
    const first = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000006'), [file]);
    const second = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000007'), [file]);
    expect(first.parserFailures).toHaveLength(1);
    expect(second.parserFailures).toEqual(first.parserFailures);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('reparses changed content and invalidates the prior source relationships', async () => {
    const parse = vi.spyOn(parser, 'parseSource');
    const firstFile = {
      path: 'src/a.ts',
      fingerprint: 'b'.repeat(64),
      content: 'export function original() { return 1; }',
    };
    await indexAuditGraph(audit('00000000-0000-4000-8000-000000000011'), [firstFile]);

    const changedFile = {
      ...firstFile,
      fingerprint: 'c'.repeat(64),
      content: 'export function replacement() { return 2; }',
    };
    const changed = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000012'), [
      changedFile,
    ]);

    expect(parse).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenCalledWith(expect.any(Object), ['src/a.ts']);
    expect(changed.snapshot.nodes.some((node) => node.label === 'src/a.ts:replacement')).toBe(true);
    expect(changed.snapshot.nodes.some((node) => node.label === 'src/a.ts:original')).toBe(false);
    expect(changed.snapshot.relationships.some((edge) => edge.stale)).toBe(false);
  });

  it('resolves imports, calls and test relationships to indexed source nodes', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000021'), [
      {
        path: 'src/run.ts',
        fingerprint: '1'.repeat(64),
        content: "import { helper } from './helper';\nexport function run() { helper(); }",
      },
      {
        path: 'src/helper.ts',
        fingerprint: '2'.repeat(64),
        content: 'export function helper() { return 1; }',
      },
      {
        path: 'src/run.test.ts',
        fingerprint: '3'.repeat(64),
        content: "import { run } from './run';\ntest('runs', () => run());",
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const importEdge = result.snapshot.relationships.find(
      (edge) => edge.relation === 'IMPORTS' && nodesById.get(edge.sourceId)?.label === 'src/run.ts'
    );
    expect(nodesById.get(importEdge?.targetId ?? '')).toMatchObject({
      kind: 'file',
      label: 'src/helper.ts',
    });
    expect(importEdge?.certainty).toBe('heuristic');
    const callEdge = result.snapshot.relationships.find(
      (edge) => edge.relation === 'CALLS' && edge.source?.path === 'src/run.ts'
    );
    expect(nodesById.get(callEdge?.sourceId ?? '')?.label).toBe('src/run.ts:run');
    expect(nodesById.get(callEdge?.targetId ?? '')?.label).toBe('src/helper.ts:helper');
    expect(callEdge?.certainty).toBe('heuristic');
    const testEdge = result.snapshot.relationships.find(
      (edge) => edge.relation === 'TESTS' && edge.source?.path === 'src/run.test.ts'
    );
    expect(nodesById.get(testEdge?.sourceId ?? '')?.label).toBe('src/run.test.ts:runs');
    expect(nodesById.get(testEdge?.targetId ?? '')?.label).toBe('src/run.ts:run');
    expect(testEdge?.certainty).toBe('heuristic');
  });

  it('marks duplicate name-only call resolutions as ambiguous', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000032'), [
      {
        path: 'src/run.ts',
        fingerprint: '1'.repeat(64),
        content: 'export function run() { helper(); }',
      },
      { path: 'src/a.ts', fingerprint: '2'.repeat(64), content: 'export function helper() {}' },
      { path: 'src/b.ts', fingerprint: '3'.repeat(64), content: 'export function helper() {}' },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const call = result.snapshot.relationships.find(
      (edge) =>
        edge.relation === 'CALLS' && nodesById.get(edge.sourceId)?.label === 'src/run.ts:run'
    );
    expect(call?.certainty).toBe('ambiguous');
    expect(nodesById.get(call?.targetId ?? '')?.extractionMethod).toBe('unresolved-reference');
  });

  it('attributes calls to the narrowest containing symbol in nested source ranges', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000022'), [
      {
        path: 'src/nested.ts',
        fingerprint: '7'.repeat(64),
        content: 'function outer() {\n  function inner() {\n    missing();\n  }\n  missing();\n}',
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const calls = result.snapshot.relationships
      .filter((edge) => edge.relation === 'CALLS')
      .sort((left, right) => (left.source?.startLine ?? 0) - (right.source?.startLine ?? 0));

    expect(calls).toHaveLength(2);
    expect(nodesById.get(calls[0]!.sourceId)?.label).toBe('src/nested.ts:inner');
    expect(nodesById.get(calls[1]!.sourceId)?.label).toBe('src/nested.ts:outer');
  });

  it('preserves same-line call sites and attributes each to its innermost function', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000025'), [
      {
        path: 'src/inline.mts',
        fingerprint: 'c'.repeat(64),
        content:
          'function outer(){ function inner(){ helper(); helper(); } helper(); } function helper() {}',
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const calls = result.snapshot.relationships
      .filter((edge) => edge.relation === 'CALLS')
      .sort((left, right) => (left.source?.startColumn ?? 0) - (right.source?.startColumn ?? 0));
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((edge) => edge.source?.startColumn)).size).toBe(3);
    expect(calls.map((edge) => nodesById.get(edge.sourceId)?.label)).toEqual([
      'src/inline.mts:inner',
      'src/inline.mts:inner',
      'src/inline.mts:outer',
    ]);
  });

  it('marks relative imports with multiple eligible resolution candidates ambiguous', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000026'), [
      {
        path: 'src/run.ts',
        fingerprint: '1'.repeat(64),
        content: "import './helper';",
      },
      { path: 'src/helper.ts', fingerprint: '2'.repeat(64), content: 'export const a = 1;' },
      {
        path: 'src/helper/index.ts',
        fingerprint: '3'.repeat(64),
        content: 'export const b = 2;',
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const imports = result.snapshot.relationships.filter((edge) => edge.relation === 'IMPORTS');
    expect(imports).toHaveLength(1);
    expect(imports[0]?.certainty).toBe('ambiguous');
    expect(nodesById.get(imports[0]!.targetId)).toMatchObject({
      kind: 'dependency',
      extractionMethod: 'ambiguous-import-resolution',
      label: 'ambiguous relative import: ./helper',
    });
  });

  it('resolves TypeScript module extension candidates without guessing when only one exists', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000027'), [
      {
        path: 'src/run.mts',
        fingerprint: '4'.repeat(64),
        content: "import './helper';",
      },
      { path: 'src/helper.cts', fingerprint: '5'.repeat(64), content: 'export const cts = 1;' },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const edge = result.snapshot.relationships.find((item) => item.relation === 'IMPORTS');
    expect(edge?.certainty).toBe('heuristic');
    expect(nodesById.get(edge?.targetId ?? '')).toMatchObject({
      kind: 'file',
      label: 'src/helper.cts',
    });
  });

  it('maps TypeScript .js specifiers to unique source modules with heuristic certainty', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000071'), [
      {
        path: 'src/run.ts',
        fingerprint: '1'.repeat(64),
        content: "import './helper.js';",
      },
      { path: 'src/helper.ts', fingerprint: '2'.repeat(64), content: 'export const helper = 1;' },
      { path: 'src/plain.js', fingerprint: '3'.repeat(64), content: "import './only-ts.js';" },
      { path: 'src/only-ts.ts', fingerprint: '4'.repeat(64), content: 'export const value = 1;' },
      {
        path: 'src/ambiguous-run.ts',
        fingerprint: '5'.repeat(64),
        content: "import './choices.js';",
      },
      { path: 'src/choices.ts', fingerprint: '6'.repeat(64), content: 'export const a = 1;' },
      { path: 'src/choices.tsx', fingerprint: '7'.repeat(64), content: 'export const b = 2;' },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const imports = result.snapshot.relationships.filter((edge) => edge.relation === 'IMPORTS');
    const sourceImport = imports.find(
      (edge) => nodesById.get(edge.sourceId)?.label === 'src/run.ts'
    );
    expect(sourceImport?.certainty).toBe('heuristic');
    expect(nodesById.get(sourceImport?.targetId ?? '')).toMatchObject({
      kind: 'file',
      label: 'src/helper.ts',
    });
    const plainImport = imports.find(
      (edge) => nodesById.get(edge.sourceId)?.label === 'src/plain.js'
    );
    expect(nodesById.get(plainImport?.targetId ?? '')).toMatchObject({
      kind: 'dependency',
      label: 'unresolved relative import: ./only-ts.js',
    });
    const ambiguous = imports.find(
      (edge) => nodesById.get(edge.sourceId)?.label === 'src/ambiguous-run.ts'
    );
    expect(ambiguous?.certainty).toBe('ambiguous');
    expect(nodesById.get(ambiguous?.targetId ?? '')).toMatchObject({
      extractionMethod: 'ambiguous-import-resolution',
      label: 'ambiguous relative import: ./choices.js',
    });
  });

  it('persists constructor, tagged-template, and JSX relationships as heuristic syntax evidence', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000075'), [
      {
        path: 'src/components.tsx',
        fingerprint: '7'.repeat(64),
        content:
          'export class Widget {}\nfunction query() {}\nnew Widget();\nquery`select 1`;\nconst view = <Widget />;',
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const constructor = result.snapshot.relationships.find(
      (edge) => edge.relation === 'CALLS' && edge.source?.startLine === 3
    );
    const taggedTemplate = result.snapshot.relationships.find(
      (edge) => edge.relation === 'CALLS' && edge.source?.startLine === 4
    );
    const render = result.snapshot.relationships.find((edge) => edge.relation === 'RENDERS');
    expect(constructor?.certainty).toBe('heuristic');
    expect(nodesById.get(constructor?.targetId ?? '')?.label).toBe('src/components.tsx:Widget');
    expect(taggedTemplate?.certainty).toBe('heuristic');
    expect(nodesById.get(taggedTemplate?.targetId ?? '')?.label).toBe('src/components.tsx:query');
    expect(render?.certainty).toBe('heuristic');
    expect(nodesById.get(render?.targetId ?? '')?.label).toBe('src/components.tsx:Widget');
  });

  it('indexes source declarations and references near EOF at the Mandate 1.846 MiB profile', async () => {
    const suffix = 'export function read() { target(); }\nexport function target() {}';
    const content = `${' '.repeat(1_846_042 - Buffer.byteLength(suffix))}${suffix}`;
    expect(Buffer.byteLength(content)).toBe(1_846_042);
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000076'), [
      {
        path: 'src/mandate-sized.ts',
        fingerprint: '8'.repeat(64),
        content,
      },
    ]);
    expect(result.parserFailures).toEqual([]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    expect(result.snapshot.nodes.map((node) => node.label)).toContain(
      'src/mandate-sized.ts:target'
    );
    const call = result.snapshot.relationships.find((edge) => edge.relation === 'CALLS');
    expect(call?.certainty).toBe('heuristic');
    expect(nodesById.get(call?.targetId ?? '')?.label).toBe('src/mandate-sized.ts:target');
    expect(call?.source?.startColumn).toBeGreaterThan(1_800_000);
  });

  it('resolves Python relative and absolute imports only to unique local modules', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000072'), [
      {
        path: 'src/pkg/use.py',
        fingerprint: '1'.repeat(64),
        content:
          'from . import helper\nimport pkg.mod\nfrom .ambiguous import value\nimport pkg.collision',
      },
      { path: 'src/pkg/helper.py', fingerprint: '2'.repeat(64), content: 'def helper(): pass' },
      { path: 'src/pkg/mod.py', fingerprint: '3'.repeat(64), content: 'def mod(): pass' },
      { path: 'src/pkg/ambiguous.py', fingerprint: '4'.repeat(64), content: '' },
      { path: 'src/pkg/ambiguous/__init__.py', fingerprint: '5'.repeat(64), content: '' },
      { path: 'src/pkg/collision.py', fingerprint: '6'.repeat(64), content: '' },
      { path: 'vendor/pkg/collision.py', fingerprint: '7'.repeat(64), content: '' },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const imports = result.snapshot.relationships.filter(
      (edge) =>
        edge.relation === 'IMPORTS' && nodesById.get(edge.sourceId)?.label === 'src/pkg/use.py'
    );
    const helper = imports.find((edge) => edge.source?.startLine === 1);
    expect(helper?.certainty).toBe('direct');
    expect(nodesById.get(helper?.targetId ?? '')).toMatchObject({
      kind: 'file',
      label: 'src/pkg/helper.py',
    });
    const absolute = imports.find((edge) => edge.source?.startLine === 2);
    expect(absolute?.certainty).toBe('heuristic');
    expect(nodesById.get(absolute?.targetId ?? '')).toMatchObject({
      kind: 'file',
      label: 'src/pkg/mod.py',
    });
    const ambiguous = imports.find((edge) => edge.source?.startLine === 3);
    expect(ambiguous?.certainty).toBe('ambiguous');
    expect(nodesById.get(ambiguous?.targetId ?? '')).toMatchObject({
      kind: 'dependency',
      extractionMethod: 'ambiguous-import-resolution',
    });
    const absoluteAmbiguous = imports.find((edge) => edge.source?.startLine === 4);
    expect(absoluteAmbiguous?.certainty).toBe('ambiguous');
    expect(nodesById.get(absoluteAmbiguous?.targetId ?? '')).toMatchObject({
      kind: 'dependency',
      label: 'ambiguous Python import: pkg.collision',
      extractionMethod: 'ambiguous-import-resolution',
    });
  });

  it('reparses an unchanged file when the persisted graph extractor version is stale', async () => {
    const parse = vi.spyOn(parser, 'parseSource');
    const file = {
      path: 'src/versioned.ts',
      fingerprint: 'a'.repeat(64),
      content: 'export function retained() {}',
    };
    const first = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000073'), [file]);
    const persistedFile = first.snapshot.nodes.find((node) => node.kind === 'file');
    expect(persistedFile?.extractionMethod).toBe('graph-extractor-v4');
    persistedFile!.extractionMethod = 'filesystem-audit';

    const second = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000074'), [file]);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(
      second.snapshot.nodes.find((node) => node.label === 'src/versioned.ts:retained')
    ).toMatchObject({ extractionMethod: 'typescript-ast-v4' });
  });

  it('preserves duplicate import sites and terminates cyclic import indexing', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000029'), [
      {
        path: 'src/a.ts',
        fingerprint: 'a'.repeat(64),
        content: "import './b'; import './b';",
      },
      {
        path: 'src/b.ts',
        fingerprint: 'b'.repeat(64),
        content: "import './a';",
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const imports = result.snapshot.relationships.filter((edge) => edge.relation === 'IMPORTS');
    const importsFromA = imports
      .filter((edge) => nodesById.get(edge.sourceId)?.label === 'src/a.ts')
      .sort((left, right) => (left.source?.startColumn ?? 0) - (right.source?.startColumn ?? 0));
    expect(imports).toHaveLength(3);
    expect(importsFromA).toHaveLength(2);
    expect(new Set(importsFromA.map((edge) => edge.source?.startColumn)).size).toBe(2);
    expect(importsFromA.map((edge) => nodesById.get(edge.targetId)?.label)).toEqual([
      'src/b.ts',
      'src/b.ts',
    ]);
    expect(
      imports.some(
        (edge) =>
          nodesById.get(edge.sourceId)?.label === 'src/b.ts' &&
          nodesById.get(edge.targetId)?.label === 'src/a.ts'
      )
    ).toBe(true);
  });

  it('uses deterministic graph identities when indexing the same audit snapshot twice', async () => {
    const sameAudit = audit('00000000-0000-4000-8000-000000000030');
    const files = [
      {
        path: 'src/repeat.ts',
        fingerprint: 'f'.repeat(64),
        content: "import './dep'; export function run() { helper(); }",
      },
      { path: 'src/dep.ts', fingerprint: 'd'.repeat(64), content: 'export function helper() {}' },
    ];
    const first = await indexAuditGraph(sameAudit, files);
    const second = await indexAuditGraph(sameAudit, files);
    expect(second.snapshot).toBe(first.snapshot);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(second.snapshot.nodes.map((node) => node.id).sort()).toEqual(
      first.snapshot.nodes.map((node) => node.id).sort()
    );
    expect(second.snapshot.relationships.map((edge) => edge.id).sort()).toEqual(
      first.snapshot.relationships.map((edge) => edge.id).sort()
    );
    expect(second.snapshot.retrievalReasons.map((reason) => reason.id).sort()).toEqual(
      first.snapshot.retrievalReasons.map((reason) => reason.id).sort()
    );
  });

  it('prefers a unique local symbol when the same name exists in another file', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000024'), [
      {
        path: 'src/a.ts',
        fingerprint: '1'.repeat(64),
        content: 'function helper() {}\nexport function run() { helper(); }',
      },
      {
        path: 'src/b.ts',
        fingerprint: '2'.repeat(64),
        content: 'export function helper() {}',
      },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const call = result.snapshot.relationships.find((edge) => edge.relation === 'CALLS');
    expect(nodesById.get(call?.targetId ?? '')?.label).toBe('src/a.ts:helper');
  });

  it('matches a naive interval lookup for overlapping, expired and tied symbol ranges', async () => {
    const path = 'src/generated.ts';
    const symbols = Array.from({ length: 100 }, (_, index) => {
      const startLine = 1 + ((index * 17) % 80);
      return {
        name: `symbol_${index}`,
        kind: 'function' as const,
        source: { path, startLine, endLine: startLine + (index % 16) },
      };
    });
    const references = Array.from({ length: 120 }, (_, index) => {
      const line = 1 + ((index * 29) % 110);
      return {
        target: `missing_${index}`,
        relation: 'CALLS' as const,
        certainty: 'heuristic' as const,
        source: { path, startLine: line, endLine: line },
      };
    }).reverse();
    vi.spyOn(parser, 'parseSource').mockReturnValue({
      language: 'TypeScript',
      symbols,
      references,
    });
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000023'), [
      { path, fingerprint: '8'.repeat(64), content: '' },
    ]);
    const nodesById = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const callsByTarget = new Map(
      result.snapshot.relationships
        .filter((edge) => edge.relation === 'CALLS')
        .map((edge) => [nodesById.get(edge.targetId)?.label, edge])
    );
    for (const reference of references) {
      const line = reference.source.startLine;
      const expected = symbols
        .filter((symbol) => symbol.source.startLine <= line && symbol.source.endLine >= line)
        .sort(
          (left, right) =>
            left.source.endLine -
            left.source.startLine -
            (right.source.endLine - right.source.startLine)
        )[0];
      const call = callsByTarget.get(reference.target);
      expect(call).toBeDefined();
      expect(nodesById.get(call!.sourceId)?.label).toBe(
        expected ? `${path}:${expected.name}` : path
      );
    }
  });

  it('re-resolves unchanged importers to changed dependency nodes in the new revision', async () => {
    const firstFiles = [
      {
        path: 'src/run.ts',
        fingerprint: '4'.repeat(64),
        content: "import { helper } from './helper';\nexport function run() { helper(); }",
      },
      {
        path: 'src/helper.ts',
        fingerprint: '5'.repeat(64),
        content: 'export function helper() { return 1; }',
      },
    ];
    await indexAuditGraph(audit('00000000-0000-4000-8000-000000000031'), firstFiles);
    const second = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000032'), [
      firstFiles[0]!,
      {
        ...firstFiles[1]!,
        fingerprint: '6'.repeat(64),
        content: 'export function helper() { return 2; }',
      },
    ]);
    const nodesById = new Map(second.snapshot.nodes.map((node) => [node.id, node]));
    const callEdge = second.snapshot.relationships.find(
      (edge) => edge.relation === 'CALLS' && edge.source?.path === 'src/run.ts'
    );
    expect(nodesById.get(callEdge?.targetId ?? '')).toMatchObject({
      label: 'src/helper.ts:helper',
      revision: second.snapshot.revision,
      extractionMethod: 'typescript-ast-v4',
    });
    expect(
      second.snapshot.nodes.find((node) => node.label === 'src/run.ts:run')?.extractionMethod
    ).toBe('reused-typescript-ast-v4');
  });

  it('re-resolves test relationships when a tested symbol disappears', async () => {
    const testFile = {
      path: 'src/run.test.ts',
      fingerprint: '9'.repeat(64),
      content: "test('runs', () => run());",
    };
    const sourceFile = {
      path: 'src/run.ts',
      fingerprint: 'a'.repeat(64),
      content: 'export function run() { return 1; }',
    };
    await indexAuditGraph(audit('00000000-0000-4000-8000-000000000041'), [testFile, sourceFile]);
    const next = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000042'), [
      testFile,
      {
        ...sourceFile,
        fingerprint: 'b'.repeat(64),
        content: 'export function replacement() { return 2; }',
      },
    ]);
    const nodesById = new Map(next.snapshot.nodes.map((node) => [node.id, node]));
    const testTargets = next.snapshot.relationships
      .filter((edge) => edge.relation === 'TESTS' && edge.source?.path === testFile.path)
      .map((edge) => nodesById.get(edge.targetId)?.label);

    expect(testTargets).toEqual(['run']);
    expect(next.snapshot.nodes.some((node) => node.label === 'src/run.ts:run')).toBe(false);
  });
});

describe('Markdown graph links', () => {
  it('retains document-link semantics instead of mislabeling a link as an import', async () => {
    const result = await indexAuditGraph(audit('00000000-0000-4000-8000-000000000099'), [
      {
        path: 'docs/README.md',
        fingerprint: 'a'.repeat(64),
        content: '# Home\n[Guide](./guide.md)',
      },
      { path: 'docs/guide.md', fingerprint: 'b'.repeat(64), content: '# Guide' },
    ]);
    const byId = new Map(result.snapshot.nodes.map((node) => [node.id, node]));
    const link = result.snapshot.relationships.find((edge) => edge.relation === 'LINKS_TO');
    expect(link).toBeDefined();
    expect(byId.get(link!.targetId)?.label).toBe('docs/guide.md');
    expect(link?.certainty).toBe('direct');
    expect(result.snapshot.relationships.some((edge) => edge.relation === 'IMPORTS')).toBe(false);
  });
});
