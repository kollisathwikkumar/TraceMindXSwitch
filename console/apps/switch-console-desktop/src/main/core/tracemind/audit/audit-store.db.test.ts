import { createHash } from 'node:crypto';
import { openFixture } from '@tooling/utils/db';
import Database from 'better-sqlite3';
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
  saveAudit,
  getAudit,
  listAudits,
  listAuditEvidence,
  compareAuditEvidence,
  getAuditReport,
  getAuditInvalidation,
  recordAuditInvalidation,
  recordGraphCoverage,
  recordGraphIndexFailure,
  AUDIT_ANALYZER_VERSION,
  auditNeedsRefresh,
} = await import('./audit-store');

const record = {
  locationId: 'loc-1',
  root: '/fixture',
  identity: '1:42',
  revision: 'a'.repeat(40),
  dirty: true,
  fingerprint: 'b'.repeat(64),
  capturedAt: 100,
  inventory: {
    filesDiscovered: 3,
    filesParsed: 0,
    skipped: 1,
    inventoryComplete: true,
    errors: [],
    languages: [{ language: 'TypeScript', files: 2 }],
    manifests: ['package.json'],
    limitations: ['No parsing'],
  },
};

function auditFingerprint(entries: readonly { path: string; fingerprint: string }[]): string {
  const hash = createHash('sha256');
  hash.update('tracemind-audit-v1\0');
  for (const entry of [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )) {
    hash.update(`${JSON.stringify([entry.path, entry.fingerprint])}\n`);
  }
  return hash.digest('hex');
}

describe('audit storage', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });
  it('persists a project-scoped audit report together with the audit and evidence', async () => {
    const audit = await saveAudit(record, [{ path: 'src/main.ts', fingerprint: 'c'.repeat(64) }]);
    expect(audit.analysisVersion).toBe(AUDIT_ANALYZER_VERSION);
    expect(auditNeedsRefresh(audit.analysisVersion)).toBe(false);
    expect(auditNeedsRefresh(AUDIT_ANALYZER_VERSION - 1)).toBe(true);
    const report = await getAuditReport('loc-1', audit.id);
    expect(report).toContain('src/main.ts');
    expect(report).toContain('c'.repeat(64));
    expect(report).toContain('No parsing');
    expect(report).toContain('not proof');
    expect(report).toContain('Parser coverage: 0 files parsed; graph coverage is unknown.');
    expect(report).toContain('this graph must not be treated as up to date');
    expect(report).toContain('not a plain file-content SHA-256');
    expect(report).toContain(`Analyzer version: ${AUDIT_ANALYZER_VERSION} (current)`);
    await expect(getAuditReport('loc-2', audit.id)).rejects.toThrow('not found');
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await getAuditReport('loc-1', audit.id)).toBe(report);
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
  });
  it('reads legacy records without an analyzer version and reports their metadata as stale', async () => {
    const saved = await saveAudit(record, []);
    const legacy = { ...saved } as Record<string, unknown>;
    delete legacy.analysisVersion;
    fixture.sqlite
      .prepare('UPDATE kv SET value = ? WHERE key = ?')
      .run(JSON.stringify(legacy), `tracemind:audit:loc-1:${saved.id}`);
    fixture.sqlite
      .prepare('UPDATE kv SET value = ? WHERE key = ?')
      .run('Legacy TraceMind report\n', `tracemind:report:loc-1:${saved.id}`);

    const reopened = await getAudit('loc-1', saved.id);
    expect(reopened?.analysisVersion).toBeUndefined();
    expect(auditNeedsRefresh(reopened?.analysisVersion)).toBe(true);
    const report = await getAuditReport('loc-1', saved.id);
    expect(report).toContain('Analyzer freshness: NEEDS REFRESH.');
    expect(report).toContain(
      `Recorded analyzer version: not recorded; current version: ${AUDIT_ANALYZER_VERSION}.`
    );
    expect(report).toContain('Matching file fingerprints describe the saved file snapshot only');
  });
  it('keeps explicitly older analyzer versions unchanged and marks them stale', async () => {
    const saved = await saveAudit(record, []);
    const olderVersion = AUDIT_ANALYZER_VERSION - 1;
    const older = { ...saved, analysisVersion: olderVersion };
    fixture.sqlite
      .prepare('UPDATE kv SET value = ? WHERE key = ?')
      .run(JSON.stringify(older), `tracemind:audit:loc-1:${saved.id}`);
    fixture.sqlite
      .prepare('UPDATE kv SET value = ? WHERE key = ?')
      .run('Older TraceMind report\n', `tracemind:report:loc-1:${saved.id}`);

    const reopened = await getAudit('loc-1', saved.id);
    expect(reopened?.analysisVersion).toBe(olderVersion);
    expect(reopened?.fingerprint).toBe(saved.fingerprint);
    expect(auditNeedsRefresh(reopened?.analysisVersion)).toBe(true);
    const report = await getAuditReport('loc-1', saved.id);
    expect(report).toContain('Older TraceMind report');
    expect(report).toContain('Analyzer freshness: NEEDS REFRESH.');
    expect(report).toContain(
      `Recorded analyzer version: ${olderVersion}; current version: ${AUDIT_ANALYZER_VERSION}.`
    );
  });
  it('persists bounded dependency provenance and coverage in the audit report', async () => {
    const dependencyInventory = {
      status: 'partial' as const,
      lockfiles: ['package-lock.json'],
      unsupportedFiles: ['pom.xml'],
      ecosystems: ['npm' as const],
      packages: [
        {
          id: 'a'.repeat(64),
          ecosystem: 'npm' as const,
          name: 'alpha',
          version: '1.2.0',
          sourcePath: 'package-lock.json',
          direct: true,
        },
        {
          id: 'b'.repeat(64),
          ecosystem: 'npm' as const,
          name: 'beta',
          version: '2.0.0',
          sourcePath: 'package-lock.json',
          direct: false,
        },
      ],
      edges: [
        { from: null, to: 'a'.repeat(64), sourcePath: 'package-lock.json' },
        { from: 'a'.repeat(64), to: 'b'.repeat(64), sourcePath: 'package-lock.json' },
      ],
      limitations: ['Unsupported Maven metadata was detected.'],
    };
    const audit = await saveAudit(
      { ...record, inventory: { ...record.inventory, dependencyInventory } },
      []
    );
    const report = await getAuditReport('loc-1', audit.id);
    expect(report).toContain(
      'Dependency closure: partial; 2 resolved packages and 2 dependency edges.'
    );
    expect(report).toContain('direct "alpha"@1.2.0 (npm; "package-lock.json")');
    expect(report).toContain('transitive "beta"@2.0.0 (npm; "package-lock.json")');
    expect(report).toContain('Unsupported dependency metadata (first 50):');
    expect(report).toContain('"pom.xml"');
    expect((await getAudit('loc-1', audit.id))?.inventory.dependencyInventory).toEqual(
      dependencyInventory
    );
  });
  it('persists parsed-file counts and partial graph warnings with the updated report', async () => {
    const saved = await saveAudit(record, []);
    const updated = await recordGraphCoverage('loc-1', saved.id, {
      status: 'partial',
      omittedFiles: 2,
      filesParsed: 1,
    });
    expect(updated.inventory).toMatchObject({
      filesParsed: 1,
      graphCoverage: { status: 'partial', omittedFiles: 2 },
    });
    const report = await getAuditReport('loc-1', saved.id);
    expect(report).toContain('Parser coverage: 1 file parsed; graph coverage is partial.');
    expect(report).toContain('at least 2 eligible files lack parser-derived graph evidence');
    expect(report).toContain('this graph must not be treated as up to date');
    const reopened = await getAudit('loc-1', saved.id);
    expect(reopened?.inventory).toEqual(updated.inventory);
  });
  it('rejects partial graph counts that do not account for every inventoried file', async () => {
    const saved = await saveAudit(record, []);
    await expect(
      recordGraphCoverage('loc-1', saved.id, {
        status: 'partial',
        omittedFiles: 0,
        filesParsed: record.inventory.filesDiscovered - 1,
      })
    ).rejects.toThrow('Graph coverage counts must account for every inventoried file');
  });
  it('does not label a complete graph as missing parser evidence', async () => {
    const saved = await saveAudit(record, []);
    await recordGraphCoverage('loc-1', saved.id, {
      status: 'complete',
      omittedFiles: 0,
      filesParsed: record.inventory.filesDiscovered,
    });
    const report = await getAuditReport('loc-1', saved.id);
    expect(report).toContain(
      'Graph coverage: complete; all inventoried eligible files were parsed.'
    );
    expect(report).not.toContain('missing evidence is possible');
  });
  it('rejects complete graph status when the audit snapshot or parser coverage is incomplete', async () => {
    const incomplete = await saveAudit(
      {
        ...record,
        fingerprint: null,
        inventory: {
          ...record.inventory,
          inventoryComplete: false,
          errors: [{ path: '', message: 'Time limit reached' }],
        },
      },
      []
    );
    await expect(
      recordGraphCoverage('loc-1', incomplete.id, {
        status: 'complete',
        omittedFiles: 0,
        filesParsed: record.inventory.filesDiscovered,
      })
    ).rejects.toThrow('Complete graph coverage requires a complete fingerprinted inventory');

    const omitted = await saveAudit(record, []);
    await expect(
      recordGraphCoverage('loc-1', omitted.id, {
        status: 'complete',
        omittedFiles: 1,
        filesParsed: record.inventory.filesDiscovered - 1,
      })
    ).rejects.toThrow('Complete graph coverage requires zero omissions and every file parsed');
  });
  it('keeps partial coverage honest when omissions are not quantified', async () => {
    const saved = await saveAudit(
      {
        ...record,
        inventory: {
          ...record.inventory,
          inventoryComplete: false,
          errors: [{ path: '', message: 'Time limit reached' }],
        },
      },
      []
    );
    await recordGraphCoverage('loc-1', saved.id, {
      status: 'partial',
      omittedFiles: 0,
      filesParsed: record.inventory.filesDiscovered,
    });
    const report = await getAuditReport('loc-1', saved.id);
    expect(report).toContain(
      'no file-level parser omissions are currently quantified, but additional omissions may be unknown'
    );
    expect(report).toContain('missing evidence is possible');
  });
  it('atomically appends a graph-failure limitation to the audit and report', async () => {
    const audit = await saveAudit(record, [{ path: 'src/main.ts', fingerprint: 'c'.repeat(64) }]);
    fixture.sqlite.exec(
      "CREATE TRIGGER reject_report_update BEFORE UPDATE ON kv WHEN NEW.key LIKE 'tracemind:report:%' BEGIN SELECT RAISE(ABORT, 'report update failure'); END"
    );
    await expect(recordGraphIndexFailure('loc-1', audit.id)).rejects.toThrow(
      'report update failure'
    );
    expect((await getAudit('loc-1', audit.id))?.inventory.limitations).not.toContain(
      'Evidence graph indexing failed; audit and file evidence remain available.'
    );
    expect(await getAuditReport('loc-1', audit.id)).not.toContain('Evidence graph indexing failed');
    fixture.sqlite.exec('DROP TRIGGER reject_report_update');

    const updated = await recordGraphIndexFailure('loc-1', audit.id);
    expect(updated.inventory).toMatchObject({
      filesParsed: 0,
      graphCoverage: { status: 'partial', omittedFiles: record.inventory.filesDiscovered },
    });
    expect(updated.inventory.limitations).toContain(
      'Evidence graph indexing failed; audit and file evidence remain available.'
    );
    expect(updated.inventory.limitations).toContain(
      'Historical graph freshness may be incomplete after indexing failure.'
    );
    const report = await getAuditReport('loc-1', audit.id);
    expect(report).toContain('Evidence graph indexing failed');
    expect(report).toContain('Historical graph freshness may be incomplete');
    expect(report).toContain(
      `at least ${record.inventory.filesDiscovered} eligible files lack parser-derived graph evidence`
    );
    expect(report).toContain('src/main.ts');
    const repeated = await recordGraphIndexFailure('loc-1', audit.id);
    expect(
      repeated.inventory.limitations.filter(
        (item) => item === 'Historical graph freshness may be incomplete after indexing failure.'
      )
    ).toHaveLength(1);
  });
  it('bounds report evidence and quotes path control characters', async () => {
    const entries = Array.from({ length: 205 }, (_, index) => ({
      path: `file-${index}${index === 0 ? '\nforged' : ''}.ts`,
      fingerprint: 'c'.repeat(64),
    }));
    const audit = await saveAudit(
      { ...record, inventory: { ...record.inventory, filesDiscovered: 205 } },
      entries
    );
    const report = await getAuditReport('loc-1', audit.id);
    expect(report).toContain('file-0\\nforged.ts');
    expect(report).toContain('Additional file evidence is omitted from this report.');
    expect(report).not.toContain('file-204.ts');
  });
  it('returns no report for an older audit and still rejects a missing audit', async () => {
    const audit = await saveAudit(record);
    fixture.sqlite
      .prepare('DELETE FROM kv WHERE key = ?')
      .run(`tracemind:report:loc-1:${audit.id}`);
    expect(await getAuditReport('loc-1', audit.id)).toBeNull();
    await expect(getAuditReport('loc-1', '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      'not found'
    );
  });
  it('compares exact same-path snapshots across filesystem identities only when fingerprints match', async () => {
    const empty = { ...record, inventory: { ...record.inventory, filesDiscovered: 0 } };
    const emptyFingerprint = auditFingerprint([]);
    const before = await saveAudit(
      { ...empty, identity: '1:42', fingerprint: emptyFingerprint },
      []
    );
    const sameSnapshot = await saveAudit(
      { ...empty, identity: '1:43', fingerprint: emptyFingerprint },
      []
    );
    const replacementEvidence = [{ path: 'replacement.ts', fingerprint: 'c'.repeat(64) }];
    const replacement = await saveAudit(
      {
        ...record,
        identity: '1:44',
        fingerprint: auditFingerprint(replacementEvidence),
        inventory: { ...record.inventory, filesDiscovered: 1 },
      },
      replacementEvidence
    );
    const { identity: _identity, ...legacyInput } = empty;
    const legacy = await saveAudit(legacyInput, []);
    expect((await getAudit('loc-1', before.id))?.identity).toBe('1:42');
    expect(await compareAuditEvidence('loc-1', before.id, sameSnapshot.id)).toEqual({
      status: 'compared',
      counts: { changed: 0, removed: 0, added: 0 },
      items: [],
      truncated: false,
    });
    expect(await compareAuditEvidence('loc-1', before.id, replacement.id)).toEqual({
      status: 'unavailable',
    });
    expect(await compareAuditEvidence('loc-1', before.id, legacy.id)).toEqual({
      status: 'unavailable',
    });
  });
  it('compares complete persisted evidence without confusing historical changes with live state', async () => {
    const inventory = { ...record.inventory, filesDiscovered: 3 };
    const previousEvidence = [
      { path: 'same.ts', fingerprint: 'a'.repeat(64) },
      { path: 'changed.ts', fingerprint: 'b'.repeat(64) },
      { path: 'removed.ts', fingerprint: 'c'.repeat(64) },
    ];
    const currentEvidence = [
      { path: 'same.ts', fingerprint: 'a'.repeat(64) },
      { path: 'changed.ts', fingerprint: 'd'.repeat(64) },
      { path: 'added.ts', fingerprint: 'e'.repeat(64) },
    ];
    const previous = await saveAudit(
      { ...record, fingerprint: auditFingerprint(previousEvidence), inventory },
      previousEvidence
    );
    const current = await saveAudit(
      { ...record, fingerprint: auditFingerprint(currentEvidence), inventory },
      currentEvidence
    );
    expect(await compareAuditEvidence('loc-1', previous.id, current.id)).toEqual({
      status: 'compared',
      counts: { changed: 1, removed: 1, added: 1 },
      items: [
        { path: 'added.ts', change: 'added' },
        { path: 'changed.ts', change: 'changed' },
        { path: 'removed.ts', change: 'removed' },
      ],
      truncated: false,
    });
    const reopened = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(reopened, { schema });
      expect(await compareAuditEvidence('loc-1', previous.id, current.id)).toMatchObject({
        status: 'compared',
        counts: { changed: 1, removed: 1, added: 1 },
      });
    } finally {
      reopened.close();
      mocks.db = fixture.db;
    }
    const partial = await saveAudit({ ...record, fingerprint: null, inventory }, []);
    expect(await compareAuditEvidence('loc-1', previous.id, partial.id)).toEqual({
      status: 'unavailable',
    });
    const missing = await saveAudit(
      { ...record, fingerprint: auditFingerprint([]), inventory },
      []
    );
    expect(await compareAuditEvidence('loc-1', previous.id, missing.id)).toEqual({
      status: 'unavailable',
    });
    const otherRoot = await saveAudit({ ...record, root: '/other', inventory }, []);
    expect(await compareAuditEvidence('loc-1', previous.id, otherRoot.id)).toEqual({
      status: 'unavailable',
    });
    await expect(compareAuditEvidence('loc-2', previous.id, current.id)).rejects.toThrow(
      'not found'
    );
  });
  it('bounds returned paths while retaining accurate totals', async () => {
    const entries = Array.from({ length: 205 }, (_, index) => ({
      path: `file-${String(index).padStart(3, '0')}.ts`,
      fingerprint: 'a'.repeat(64),
    }));
    const empty = await saveAudit(
      {
        ...record,
        fingerprint: auditFingerprint([]),
        inventory: { ...record.inventory, filesDiscovered: 0 },
      },
      []
    );
    const full = await saveAudit(
      {
        ...record,
        fingerprint: auditFingerprint(entries),
        inventory: { ...record.inventory, filesDiscovered: 205 },
      },
      entries
    );
    const comparison = await compareAuditEvidence('loc-1', empty.id, full.id);
    expect(comparison.status).toBe('compared');
    if (comparison.status !== 'compared') throw new Error('Expected comparison');
    expect(comparison.counts).toEqual({ changed: 0, removed: 0, added: 205 });
    expect(comparison.items).toHaveLength(200);
    expect(comparison.truncated).toBe(true);
  });
  it('declines to compare evidence rows that no longer match the saved snapshot fingerprint', async () => {
    const evidence = [{ path: 'src/main.ts', fingerprint: 'a'.repeat(64) }];
    const inventory = { ...record.inventory, filesDiscovered: evidence.length };
    const previous = await saveAudit(
      { ...record, fingerprint: auditFingerprint(evidence), inventory },
      evidence
    );
    const current = await saveAudit(
      { ...record, fingerprint: auditFingerprint(evidence), inventory },
      evidence
    );

    fixture.sqlite
      .prepare('UPDATE kv SET value = ? WHERE key = ?')
      .run(
        JSON.stringify({ path: 'src/main.ts', fingerprint: 'b'.repeat(64) }),
        `tracemind:evidence:loc-1:${current.id}:000000`
      );

    expect(await compareAuditEvidence('loc-1', previous.id, current.id)).toEqual({
      status: 'unavailable',
    });
  });
  it('persists audit metadata and isolates projects', async () => {
    const stored = await saveAudit(record);
    expect(stored).toMatchObject(record);
    expect(await getAudit('loc-1', stored.id)).toEqual(stored);
    expect(await listAudits('loc-1')).toEqual([stored]);
    expect(await getAudit('loc-2', stored.id)).toBeNull();
    expect(await listAudits('loc-2')).toEqual([]);
    const secondConnection = new Database(fixture.sqlite.name);
    try {
      mocks.db = drizzle(secondConnection, { schema });
      expect(await getAudit('loc-1', stored.id)).toEqual(stored);
    } finally {
      secondConnection.close();
      mocks.db = fixture.db;
    }
  });
  it('orders audits by insertion even if the clock moves backwards', async () => {
    const first = await saveAudit({ ...record, capturedAt: 200 });
    const second = await saveAudit({ ...record, capturedAt: 100 });
    expect((await listAudits('loc-1')).map((audit) => audit.id)).toEqual([second.id, first.id]);
  });
  it('stores post-snapshot invalidation without rewriting the snapshot fingerprint', async () => {
    const audit = await saveAudit(record, []);
    const before = await getAudit('loc-1', audit.id);
    const marker = await recordAuditInvalidation('loc-1', audit.id, {
      state: 'watching',
      eventAt: 150,
      changedCount: 1,
      changedPaths: ['src/main.ts'],
      pathsTruncated: false,
    });
    expect(marker).toMatchObject({
      locationId: 'loc-1',
      auditId: audit.id,
      state: 'watching',
      stale: true,
      sequence: 1,
      eventAt: 150,
      changedCount: 1,
      changedPaths: ['src/main.ts'],
    });
    const next = await recordAuditInvalidation('loc-1', audit.id, {
      state: 'watching',
      eventAt: 140,
      changedCount: 1,
      changedPaths: ['src/other.ts'],
      pathsTruncated: false,
    });
    expect(next).toMatchObject({ sequence: 2, eventAt: 150, changedCount: 2, stale: true });
    expect(next.changedPaths).toEqual(['src/main.ts', 'src/other.ts']);
    expect(await getAuditInvalidation('loc-1', audit.id)).toEqual(next);
    expect(await getAudit('loc-1', audit.id)).toEqual(before);
    const report = await getAuditReport('loc-1', audit.id);
    expect(report).toContain('Live change monitor (post-snapshot, advisory):');
    expect(report).toContain('audit snapshot is stale');
    expect(report).toContain('This marker does not alter snapshot fingerprints');
  });

  it('marks watcher overflow and errors stale and bounds accumulated paths', async () => {
    const audit = await saveAudit(record, []);
    const overflow = await recordAuditInvalidation('loc-1', audit.id, {
      state: 'overflow',
      eventAt: 200,
      changedCount: 501,
      changedPaths: Array.from({ length: 500 }, (_, index) => `src/${index}.ts`),
      pathsTruncated: true,
    });
    expect(overflow).toMatchObject({
      state: 'overflow',
      stale: true,
      changedCount: 501,
      pathsTruncated: true,
    });
    expect(overflow.changedPaths).toHaveLength(200);
    const error = await recordAuditInvalidation('loc-1', audit.id, {
      state: 'error',
      eventAt: 201,
      changedCount: 0,
      changedPaths: [],
      pathsTruncated: false,
    });
    expect(error).toMatchObject({ state: 'error', stale: true, sequence: 2, changedCount: 501 });
  });

  it('keeps watcher markers project-scoped and rejects unsafe paths', async () => {
    const audit = await saveAudit(record, []);
    await expect(getAuditInvalidation('loc-2', audit.id)).rejects.toThrow('not found');
    await expect(
      recordAuditInvalidation('loc-1', audit.id, {
        state: 'watching',
        eventAt: 201,
        changedCount: 1,
        changedPaths: ['../secret'],
        pathsTruncated: false,
      })
    ).rejects.toThrow();
    await expect(
      recordAuditInvalidation('loc-1', audit.id, {
        state: 'watching',
        eventAt: 201,
        changedCount: 1,
        changedPaths: ['C:/secret'],
        pathsTruncated: false,
      })
    ).rejects.toThrow();
    await expect(
      recordAuditInvalidation('loc-1', audit.id, {
        state: 'watching',
        eventAt: Number.MAX_SAFE_INTEGER + 1,
        changedCount: 0,
        changedPaths: [],
        pathsTruncated: false,
      })
    ).rejects.toThrow();
  });

  it('stores source-linked file evidence atomically and pages it by project', async () => {
    const entries = [
      { path: 'src/a.ts', fingerprint: 'c'.repeat(64) },
      { path: 'src/b.ts', fingerprint: 'd'.repeat(64) },
    ];
    const audit = await saveAudit(record, entries);
    expect(await listAuditEvidence('loc-1', audit.id, 0, 1)).toEqual({
      items: [entries[0]],
      nextOffset: 1,
    });
    expect(await listAuditEvidence('loc-1', audit.id, 1, 1)).toEqual({
      items: [entries[1]],
      nextOffset: null,
    });
    await expect(listAuditEvidence('loc-2', audit.id, 0, 1)).rejects.toThrow('not found');
    await expect(
      saveAudit(record, [{ path: '../escape', fingerprint: 'e'.repeat(64) }])
    ).rejects.toThrow();
    expect(await listAudits('loc-1')).toEqual([audit]);
  });
  it('rolls back the audit when an evidence write fails', async () => {
    fixture.sqlite.exec(
      "CREATE TRIGGER reject_evidence BEFORE INSERT ON kv WHEN NEW.key LIKE 'tracemind:evidence:%' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
    );
    await expect(
      saveAudit(record, [{ path: 'src/a.ts', fingerprint: 'c'.repeat(64) }])
    ).rejects.toThrow('fixture failure');
    expect(await listAudits('loc-1')).toEqual([]);
  });
  it('rolls back audit and evidence if the report write fails', async () => {
    fixture.sqlite.exec(
      "CREATE TRIGGER reject_report BEFORE INSERT ON kv WHEN NEW.key LIKE 'tracemind:report:%' BEGIN SELECT RAISE(ABORT, 'report failure'); END"
    );
    await expect(
      saveAudit(record, [{ path: 'src/a.ts', fingerprint: 'c'.repeat(64) }])
    ).rejects.toThrow('report failure');
    expect(await listAudits('loc-1')).toEqual([]);
    expect(
      fixture.sqlite
        .prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'tracemind:evidence:%'")
        .get()
    ).toEqual({ n: 0 });
  });
  it('rejects invalid revisions, fingerprints and counts', async () => {
    await expect(saveAudit({ ...record, revision: 'bad' })).rejects.toThrow();
    await expect(saveAudit({ ...record, fingerprint: 'bad' })).rejects.toThrow();
    await expect(
      saveAudit({ ...record, inventory: { ...record.inventory, filesParsed: -1 } })
    ).rejects.toThrow();
    await expect(
      saveAudit({
        ...record,
        inventory: { ...record.inventory, skippedEntries: [], skipDetailsTruncated: false },
      })
    ).rejects.toThrow();
    await expect(
      saveAudit({
        ...record,
        inventory: { ...record.inventory, skippedEntries: [{ path: '.env', reason: 'excluded' }] },
      })
    ).rejects.toThrow();
  });
});
