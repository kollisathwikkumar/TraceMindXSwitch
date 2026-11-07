import { realpath, writeFile } from 'node:fs/promises';
import { openFixture } from '@tooling/utils/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_ANALYZER_VERSION } from '@main/core/tracemind/audit/audit-version';
import type { AppDb } from '@main/db/client';
import { locations } from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, showMessageBox: vi.fn() }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('TraceMind parity database is not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/app/window', () => ({ getMainWindow: () => ({}) }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  dialog: { showMessageBox: mocks.showMessageBox },
}));

const { tracemindController } = await import('@main/core/tracemind/controller');

const targetInput = process.env.TRACEMIND_PARITY_TARGET_ROOT;

describe.skipIf(!targetInput)('TraceMind controller audit against Mandate', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const locationId = 'mandate-controller-parity';

  beforeAll(async () => {
    if (!targetInput) throw new Error('TRACEMIND_PARITY_TARGET_ROOT is required');
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    const root = await realpath(targetInput);
    await fixture.db
      .insert(locations)
      .values({ id: locationId, name: 'Mandate parity', dir: root, sshHost: '' });
  });

  afterAll(async () => {
    fixture?.close();
    mocks.db = undefined;
  });

  it('persists a fresh full audit and reconciles exact inventory, evidence, dependencies, and graph coverage', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await tracemindController.requestAuditApproval(locationId)).toBe(true);
    const audit = await tracemindController.runAudit(locationId);

    expect(audit.analysisVersion).toBe(AUDIT_ANALYZER_VERSION);
    expect(audit.inventory.inventoryComplete).toBe(true);
    expect(audit.inventory.errors).toEqual([]);
    expect(audit.inventory.filesDiscovered).toBe(911);
    expect(audit.fingerprint).toBe(
      '177f583be0d0ff019600c085259922d31fd3a9b38b19c14f680d99bfdee8cfef'
    );
    expect(audit.inventory.languages).toEqual([
      { language: 'CSS', files: 14 },
      { language: 'HTML', files: 1 },
      { language: 'JavaScript', files: 15 },
      { language: 'Python', files: 2 },
      { language: 'Shell', files: 53 },
      { language: 'Solidity', files: 6 },
      { language: 'SQL', files: 45 },
      { language: 'TypeScript', files: 427 },
      { language: 'YAML', files: 88 },
    ]);
    expect(audit.inventory.manifests).toEqual([
      'BACKEND_COVERAGE_BASELINE/backend/package.json',
      'backend-rollback-test/package-lock.json',
      'backend-rollback-test/package.json',
      'backend/package-lock.json',
      'backend/package.json',
      'ci/browser-sso/package-lock.json',
      'ci/browser-sso/package.json',
      'frontend/package-lock.json',
      'frontend/package.json',
    ]);
    expect(audit.inventory.dependencyInventory).toMatchObject({
      status: 'partial',
      ecosystems: ['npm'],
      packages: expect.any(Array),
      edges: expect.any(Array),
    });
    expect(audit.inventory.dependencyInventory?.packages).toHaveLength(882);
    expect(audit.inventory.dependencyInventory?.edges).toHaveLength(1504);
    expect(audit.inventory.graphCoverage).toMatchObject({
      status: 'partial',
      omittedFiles: 241,
    });
    expect(audit.inventory.filesParsed).toBe(670);

    let evidenceCount = 0;
    let offset = 0;
    while (true) {
      const page = await tracemindController.listAuditEvidence(locationId, audit.id, offset);
      evidenceCount += page.items.length;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(evidenceCount).toBe(911);

    const graph = await tracemindController.getGraphOverview(locationId, `audit:${audit.id}`, null);
    expect(graph).not.toBeNull();
    expect(graph).toMatchObject({
      parserFailureCount: 241,
      nodeCount: 20069,
      relationshipCount: 71570,
    });
    expect((graph?.relationshipCounts ?? {})['IMPORTS']).toBeGreaterThan(0);
    const graphRevision = `audit:${audit.id}`;
    let fileSearchCursor: string | null = null;
    let searchableFiles = 0;
    do {
      const page = await tracemindController.searchGraphFiles(
        locationId,
        graphRevision,
        '',
        fileSearchCursor
      );
      expect(page).not.toBeNull();
      searchableFiles += page!.files.length;
      fileSearchCursor = page!.nextCursor;
    } while (fileSearchCursor);
    expect(searchableFiles).toBe(911);
    const matchingLocks = await tracemindController.searchGraphFiles(
      locationId,
      graphRevision,
      'backend/package-lock.json',
      null
    );
    expect(matchingLocks?.files.some((file) => file.path === 'backend/package-lock.json')).toBe(
      true
    );
    let fileNodeCursor: string | null = null;
    let savedFileNodes = 0;
    do {
      const page = await tracemindController.getGraphFileNodesPage(
        locationId,
        graphRevision,
        'backend/package-lock.json',
        fileNodeCursor
      );
      expect(page).not.toBeNull();
      savedFileNodes += page!.nodes.length;
      fileNodeCursor = page!.nextCursor;
    } while (fileNodeCursor);
    expect(savedFileNodes).toBeGreaterThan(100);

    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    const checks = await tracemindController.discoverAuditChecks(locationId, audit.id);
    expect(checks).not.toBeNull();
    expect(checks?.candidates.length).toBeGreaterThan(0);
    expect(checks?.candidates.every((candidate) => candidate.args.length > 0)).toBe(true);

    const report = await tracemindController.getAuditReport(locationId, audit.id);
    expect(report).toContain(`Analyzer version: ${AUDIT_ANALYZER_VERSION} (current)`);
    expect(report).toContain('Graph coverage: partial; at least 241 eligible files lack');
    expect(report).toContain('Dependency closure: partial;');
    const verifiedResult = {
      auditId: audit.id,
      projectRoot: audit.root,
      analyzerVersion: audit.analysisVersion,
      files: audit.inventory.filesDiscovered,
      skipped: audit.inventory.skipped,
      fingerprint: audit.fingerprint,
      evidenceRows: evidenceCount,
      languages: audit.inventory.languages,
      manifests: audit.inventory.manifests,
      dependencies: {
        status: audit.inventory.dependencyInventory?.status,
        ecosystems: audit.inventory.dependencyInventory?.ecosystems,
        packages: audit.inventory.dependencyInventory?.packages.length,
        edges: audit.inventory.dependencyInventory?.edges.length,
        limitations: audit.inventory.dependencyInventory?.limitations,
      },
      graph: {
        parsed: audit.inventory.filesParsed,
        omitted: audit.inventory.graphCoverage?.omittedFiles,
        parserFailures: graph?.parserFailureCount,
        nodes: graph?.nodeCount,
        relationships: graph?.relationshipCount,
        searchableFiles,
        savedNodesInBackendLockfile: savedFileNodes,
      },
      checksDiscovered: checks?.candidates.length,
      reportCurrent: Boolean(
        report?.includes(`Analyzer version: ${AUDIT_ANALYZER_VERSION} (current)`)
      ),
      targetModified: false,
    };
    if (process.env.TRACEMIND_PARITY_RESULT_PATH)
      await writeFile(
        process.env.TRACEMIND_PARITY_RESULT_PATH,
        JSON.stringify(verifiedResult, null, 2)
      );
  }, 180_000);
});
