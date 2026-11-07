import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ANALYZER_VERSION } from './audit/audit-version';
import type { RuntimeSnapshot, RuntimeSignal } from './runtime/model';

vi.mock('./brain/store', () => ({
  getBrainPolicy: vi.fn(async () => null),
  saveBrainPolicy: vi.fn(),
  getBrainChanges: vi.fn(async () => []),
  recordBrainChange: vi.fn(),
}));
vi.mock('./brain/local-context', () => ({ getLocalBrainContext: vi.fn() }));
vi.mock('./brain/binding', () => ({ getBoundBrainPolicy: vi.fn(async () => null) }));

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  getAuditInvalidation: vi.fn(),
  recordAuditInvalidation: vi.fn(),
  createMonitor: vi.fn(),
  findExecutable: vi.fn(),
  generateReport: vi.fn(),
  appOn: vi.fn(),
  appQuit: vi.fn(),
  lookup: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  getIssue: vi.fn(),
  appendIssueEvent: vi.fn(),
  appendIssueCheckResult: vi.fn(),
  transitionIssueInvestigation: vi.fn(),
  consume: vi.fn(),
  native: vi.fn(),
  runAudit: vi.fn(),
  listAudits: vi.fn(),
  saveAudit: vi.fn(),
  listEvidence: vi.fn(),
  compareEvidence: vi.fn(),
  getReport: vi.fn(),
  indexGraph: vi.fn(),
  listGraphs: vi.fn(),
  getGraph: vi.fn(),
  ensureGraphRevision: vi.fn(),
  overview: vi.fn(),
  graphParserFailures: vi.fn(),
  graphRelationships: vi.fn(),
  graphFileSearch: vi.fn(),
  graphFileNodes: vi.fn(),
  showItemInFolder: vi.fn(),
  inspectGraph: vi.fn(),
  benchmarkGraph: vi.fn(),
  recordGraph: vi.fn(),
  getAudit: vi.fn(),
  getRunProposal: vi.fn(),
  verificationRevoke: vi.fn(),
  verificationRequest: vi.fn(),
  linuxCgroupPreflight: vi.fn(),
  aiStatus: vi.fn(),
  configureAI: vi.fn(),
  clearAI: vi.fn(),
  testAIProviderConnection: vi.fn(),
  generateAI: vi.fn(),
  retrieveAI: vi.fn(),
  persistAI: vi.fn(),
  latestGraph: vi.fn(),
  getRuntimeSignals: vi.fn(),
  ingestRuntimeSignals: vi.fn(),
  getRuntimeAIEnabled: vi.fn(),
  setRuntimeAIEnabled: vi.fn(),
  clearAllRuntimeAIEnabled: vi.fn(),
  getRuntimeAILastFailureAt: vi.fn(),
  recordRuntimeAIAnalysisFailure: vi.fn(),
  getLatestRuntimeAIAdvisory: vi.fn(),
  recordRuntimeAIAdvisory: vi.fn(),
  runtimeAIQueueEnable: vi.fn(),
  runtimeAIQueueDisable: vi.fn(),
  runtimeAIQueueObserve: vi.fn(),
  runtimeAIQueueCloseAll: vi.fn(),
  startRuntimeReceiver: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', on: mocks.appOn, quit: mocks.appQuit },
  shell: { showItemInFolder: mocks.showItemInFolder },
}));
vi.mock('@main/core/utils/resolve-executable', () => ({
  findExecutableOnPath: mocks.findExecutable,
}));
vi.mock('./audit/audit-service', () => ({ runLocalAudit: mocks.runAudit }));
vi.mock('./audit/audit-store', () => ({
  getAudit: mocks.getAudit,
  getAuditInvalidation: mocks.getAuditInvalidation,
  recordAuditInvalidation: mocks.recordAuditInvalidation,
  listAudits: mocks.listAudits,
  saveAudit: mocks.saveAudit,
  listAuditEvidence: mocks.listEvidence,
  compareAuditEvidence: mocks.compareEvidence,
  getAuditReport: mocks.getReport,
}));
vi.mock('./project-registry/live-monitor', () => ({
  createTraceMindLiveMonitor: mocks.createMonitor,
}));
vi.mock('./runtime/telemetry-store', () => ({
  getRuntimeSignals: mocks.getRuntimeSignals,
  ingestRuntimeSignals: mocks.ingestRuntimeSignals,
}));
vi.mock('./runtime/ai-state-store', () => ({
  clearAllRuntimeAIEnabled: mocks.clearAllRuntimeAIEnabled,
  getRuntimeAILastFailureAt: mocks.getRuntimeAILastFailureAt,
  getRuntimeAIEnabled: mocks.getRuntimeAIEnabled,
  recordRuntimeAIAnalysisFailure: mocks.recordRuntimeAIAnalysisFailure,
  setRuntimeAIEnabled: mocks.setRuntimeAIEnabled,
  getLatestRuntimeAIAdvisory: mocks.getLatestRuntimeAIAdvisory,
  recordRuntimeAIAdvisory: mocks.recordRuntimeAIAdvisory,
}));
vi.mock('./runtime/ai-queue', () => ({
  TraceMindRuntimeAIQueue: class {
    enable = mocks.runtimeAIQueueEnable;
    disable = mocks.runtimeAIQueueDisable;
    observe = mocks.runtimeAIQueueObserve;
    closeAll = mocks.runtimeAIQueueCloseAll;
  },
}));
vi.mock('./runtime/receiver', () => ({ startRuntimeReceiver: mocks.startRuntimeReceiver }));
vi.mock('./investigation/report', () => ({
  generateInvestigationReport: mocks.generateReport,
}));
vi.mock('./graph/graph-service', () => ({ indexAuditGraph: mocks.indexGraph }));
vi.mock('./graph/graph-store', () => ({
  appendGraphRecordBounded: mocks.recordGraph,
  ensureGraphRevision: mocks.ensureGraphRevision,
  getGraphSnapshot: mocks.getGraph,
  getGraphOverview: mocks.overview,
  getGraphParserFailurePage: mocks.graphParserFailures,
  getGraphRelationshipPage: mocks.graphRelationships,
  searchGraphFiles: mocks.graphFileSearch,
  getGraphFileNodesPage: mocks.graphFileNodes,
  getLatestGraphSnapshot: mocks.latestGraph,
  listGraphSnapshots: mocks.listGraphs,
}));
vi.mock('./graph/graph-query', () => ({ inspectGraph: mocks.inspectGraph }));
vi.mock('./graph/benchmark', () => ({ benchmarkGraphAdapter: mocks.benchmarkGraph }));
vi.mock('./native/native-loader', () => ({ loadNativeProjectFs: mocks.native }));
vi.mock('@main/core/locations/store', () => ({ getLocationById: mocks.lookup }));
vi.mock('./investigation/issue-store', () => ({
  appendIssueCheckResult: mocks.appendIssueCheckResult,
  appendIssueEvent: mocks.appendIssueEvent,
  transitionIssueInvestigation: mocks.transitionIssueInvestigation,
  recordAIInvestigation: mocks.persistAI,
  createIssue: mocks.create,
  getIssue: mocks.getIssue,
  listIssues: mocks.list,
  updateIssue: mocks.update,
}));
vi.mock('./ai/gateway', () => ({
  getAIProviderStatus: mocks.aiStatus,
  configureAIProvider: mocks.configureAI,
  clearAIProvider: mocks.clearAI,
  testAIProviderConnection: mocks.testAIProviderConnection,
  generateTraceMindAIResponse: mocks.generateAI,
}));
vi.mock('./investigation/ai-evidence', () => ({
  retrieveAIInvestigationEvidence: mocks.retrieveAI,
}));
vi.mock('./project-registry/approval-service', () => ({
  AuditApprovalService: class {
    request = mocks.request;
    consumeProject = mocks.consume;
  },
}));
vi.mock('./verification/approval-service', () => ({
  VerificationApprovalService: class {
    request = mocks.verificationRequest;
    revoke = mocks.verificationRevoke;
  },
}));
vi.mock('./verification/run-store', () => ({
  createRunProposal: vi.fn(),
  getRunProposal: mocks.getRunProposal,
  getRunOutputArtifact: vi.fn(),
  getRunResultPreview: vi.fn(),
  listRunProposals: vi.fn(),
  closeRunProposal: vi.fn(),
  claimRunExecution: vi.fn(),
  finishRunExecution: vi.fn(),
  markRunOutcomeUnknown: vi.fn(),
}));
vi.mock('./verification/execution-reservation', () => ({
  acquireExecutionReservation: vi.fn(),
  releaseExecutionReservation: vi.fn(),
}));
vi.mock('./verification/linux-cgroup-v2', () => ({
  preflightLinuxCgroupLimits: mocks.linuxCgroupPreflight,
  prepareLinuxCgroupLimits: vi.fn(),
}));

const { tracemindController } = await import('./controller');
const beforeQuitHandler = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')?.[1];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.linuxCgroupPreflight.mockResolvedValue(true);
  mocks.getRuntimeAIEnabled.mockResolvedValue(false);
  mocks.setRuntimeAIEnabled.mockResolvedValue(undefined);
  mocks.clearAllRuntimeAIEnabled.mockResolvedValue(undefined);
  mocks.getRuntimeAILastFailureAt.mockResolvedValue(null);
  mocks.recordRuntimeAIAnalysisFailure.mockResolvedValue(undefined);
  mocks.getLatestRuntimeAIAdvisory.mockResolvedValue(null);
});

describe('TraceMind approval RPC', () => {
  it('requests native approval for a selected location', async () => {
    mocks.request.mockResolvedValue(true);
    await expect(tracemindController.requestAuditApproval('location-1')).resolves.toBe(true);
    expect(mocks.request).toHaveBeenCalledWith('location-1');
  });

  it('rejects invalid input before invoking the approval service', async () => {
    await expect(tracemindController.requestAuditApproval('')).rejects.toThrow(
      'Invalid location ID'
    );
    await expect(tracemindController.requestAuditApproval(' '.repeat(3))).rejects.toThrow(
      'Invalid location ID'
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe('TraceMind local audit monitor RPC', () => {
  const auditId = '70000000-0000-4000-8000-000000000002';

  function configureApprovedMonitor() {
    mocks.lookup.mockResolvedValue({ id: 'location-1', dir: '/project', sshHost: null });
    mocks.getAudit.mockResolvedValue({
      id: auditId,
      locationId: 'location-1',
      root: '/project',
      identity: '1:2',
    });
    mocks.getAuditInvalidation.mockResolvedValue(null);
    mocks.request.mockResolvedValue(true);
    mocks.consume.mockResolvedValue({
      locationId: 'location-1',
      root: '/project',
      identity: '1:2',
    });
    const snapshot = { state: 'idle', started: false, closed: false, lastInvalidation: null };
    const monitor = {
      onUpdate: vi.fn(() => () => {}),
      get snapshot() {
        return snapshot;
      },
      start: vi.fn(async () => {
        snapshot.state = 'watching';
        snapshot.started = true;
      }),
      stop: vi.fn(async () => {
        snapshot.state = 'stopped';
        snapshot.closed = true;
      }),
    };
    mocks.createMonitor.mockReturnValue(monitor);
    return monitor;
  }

  it('requires the distinct one-use monitor approval and binds the watcher to the audited root identity', async () => {
    const monitor = configureApprovedMonitor();
    await expect(
      tracemindController.startAuditMonitor('location-1', auditId)
    ).resolves.toMatchObject({
      active: true,
      state: 'watching',
      invalidation: null,
    });
    expect(mocks.request).toHaveBeenCalledWith('location-1', 'audit-monitor');
    expect(mocks.consume).toHaveBeenCalledWith('location-1');
    expect(mocks.createMonitor).toHaveBeenCalledWith(
      { locationId: 'location-1', auditId, root: '/project', identity: '1:2' },
      expect.objectContaining({ currentIdentity: expect.any(Function) })
    );
    expect(monitor.start).toHaveBeenCalledOnce();

    mocks.getAuditInvalidation.mockResolvedValue({
      state: 'stopped',
      stale: true,
      changedCount: 0,
      changedPaths: [],
      pathsTruncated: false,
    });
    await expect(
      tracemindController.stopAuditMonitor('location-1', auditId)
    ).resolves.toMatchObject({
      active: false,
      state: 'stopped',
    });
    expect(monitor.stop).toHaveBeenCalledOnce();
  });

  it('does not subscribe when approval is declined or the approved root identity differs', async () => {
    configureApprovedMonitor();
    mocks.request.mockResolvedValueOnce(false);
    await expect(
      tracemindController.startAuditMonitor('location-1', auditId)
    ).resolves.toMatchObject({
      active: false,
      state: 'idle',
    });
    expect(mocks.createMonitor).not.toHaveBeenCalled();

    mocks.request.mockResolvedValue(true);
    mocks.consume.mockResolvedValueOnce({
      locationId: 'location-1',
      root: '/project',
      identity: '9:9',
    });
    await expect(tracemindController.startAuditMonitor('location-1', auditId)).rejects.toThrow(
      'Project changed since the audit'
    );
    expect(mocks.createMonitor).not.toHaveBeenCalled();
  });

  it('closes an orphaned persisted watching marker after restart rather than reporting it active', async () => {
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.getAudit.mockResolvedValue({ id: auditId });
    mocks.getAuditInvalidation.mockResolvedValue({ state: 'watching', stale: false });
    mocks.recordAuditInvalidation.mockResolvedValue({ state: 'stopped', stale: true });
    await expect(
      tracemindController.getAuditMonitorStatus('location-1', auditId)
    ).resolves.toMatchObject({ active: false, state: 'stopped', invalidation: { stale: true } });
    expect(mocks.recordAuditInvalidation).toHaveBeenCalledWith(
      'location-1',
      auditId,
      expect.objectContaining({ state: 'stopped', changedCount: 0 })
    );
  });

  it('stops the active monitor before allowing application shutdown', async () => {
    const monitor = configureApprovedMonitor();
    await tracemindController.startAuditMonitor('location-1', auditId);
    const preventDefault = vi.fn();
    expect(beforeQuitHandler).toBeDefined();
    beforeQuitHandler?.({ preventDefault } as never);
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(monitor.stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.appQuit).toHaveBeenCalledOnce());
  });

  it('adds persisted audit freshness and stale evidence to linked issue reports', async () => {
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.getIssue.mockResolvedValue({ auditId });
    mocks.generateReport.mockResolvedValue({
      markdown: '# Investigation report',
      coverage: { status: 'partial', reasons: [] },
      uncertainty: [],
    });
    mocks.getAuditInvalidation.mockResolvedValue({
      state: 'watching',
      stale: true,
      changedCount: 2,
      changedPaths: ['src/changed.ts'],
      pathsTruncated: false,
    });
    mocks.recordAuditInvalidation.mockResolvedValue({
      state: 'stopped',
      stale: true,
      changedCount: 2,
      changedPaths: ['src/changed.ts'],
      pathsTruncated: false,
    });
    const report = await tracemindController.generateInvestigationReport('location-1', 'issue');
    expect(report).toMatchObject({
      auditFreshness: {
        auditId,
        state: 'stopped',
        stale: true,
        changedPaths: ['src/changed.ts'],
      },
    });
    expect(report?.markdown).toContain('linked audit snapshot is stale');
    expect(report?.coverage.reasons[0]).toContain('Post-snapshot monitor state is stopped');
  });
});

describe('TraceMind runtime intelligence RPC', () => {
  const auditId = '70000000-0000-4000-8000-000000000222';
  const snapshot = {
    locationId: 'location-1',
    auditId,
    auditRevision: 'fingerprint',
    signals: [],
    incidents: [],
    acceptedCount: 0,
    droppedCount: 0,
    lastReceivedAt: null,
    truncated: false,
  };

  function configureLocalAudit() {
    mocks.lookup.mockResolvedValue({ id: 'location-1', dir: '/project', sshHost: null });
    mocks.getAudit.mockResolvedValue({
      id: auditId,
      locationId: 'location-1',
      root: '/project',
      identity: '1:2',
      fingerprint: 'fingerprint',
      revision: 'revision',
    });
    mocks.getRuntimeSignals.mockResolvedValue(snapshot);
    mocks.ingestRuntimeSignals.mockResolvedValue(snapshot);
  }

  it('starts a loopback receiver bound to the current local audit, returns the token once, and stops it', async () => {
    configureLocalAudit();
    const receiver = {
      active: true,
      endpoint: 'http://127.0.0.1:42345',
      startedAt: 10,
      token: 'temporary-token',
      close: vi.fn(async () => undefined),
    };
    mocks.startRuntimeReceiver.mockResolvedValue(receiver);
    await expect(
      tracemindController.startRuntimeReceiver('location-1', auditId)
    ).resolves.toMatchObject({
      active: true,
      endpoint: receiver.endpoint,
      auditId,
      token: receiver.token,
    });
    expect(mocks.startRuntimeReceiver).toHaveBeenCalledWith(expect.any(Function));
    const status = await tracemindController.getRuntimeReceiverStatus('location-1');
    expect(status).toMatchObject({ active: true, auditId, endpoint: receiver.endpoint });
    expect(status).not.toHaveProperty('token');
    await expect(tracemindController.stopRuntimeReceiver('location-1')).resolves.toMatchObject({
      active: false,
      endpoint: null,
    });
    expect(receiver.close).toHaveBeenCalledOnce();
  });

  it('requires a local project and existing audit for receiver, stored signals, and Jaeger import', async () => {
    configureLocalAudit();
    await expect(tracemindController.getRuntimeSignals('remote', auditId)).rejects.toThrow(
      'Registered local location required'
    );
    mocks.getAudit.mockResolvedValueOnce(null);
    await expect(tracemindController.startRuntimeReceiver('location-1', auditId)).rejects.toThrow(
      'Project audit not found'
    );
    await expect(tracemindController.getRuntimeSignals('location-1', auditId)).resolves.toEqual(
      snapshot
    );
    await expect(
      tracemindController.importJaegerTelemetry('location-1', auditId, '{bad')
    ).rejects.toThrow('valid JSON');
  });

  it('keeps provider egress separately opt-in and rejects enabling without a saved provider', async () => {
    configureLocalAudit();
    mocks.aiStatus.mockResolvedValue({ configured: false });
    await expect(
      tracemindController.setRuntimeAIEnabled('location-1', auditId, true)
    ).rejects.toThrow('Configure and save an AI provider before enabling runtime analysis.');
    expect(mocks.setRuntimeAIEnabled).not.toHaveBeenCalled();
    await expect(tracemindController.getRuntimeAISettings('location-1', auditId)).resolves.toEqual({
      enabled: false,
      auditId,
      latestAdvisory: null,
      lastFailureAt: null,
    });
  });

  it('does not persist runtime opt-in if the current incident snapshot cannot be loaded', async () => {
    configureLocalAudit();
    mocks.aiStatus.mockResolvedValue({ configured: true });
    mocks.getRuntimeSignals.mockRejectedValueOnce(new Error('snapshot unavailable'));

    await expect(
      tracemindController.setRuntimeAIEnabled('location-1', auditId, true)
    ).rejects.toThrow('snapshot unavailable');

    expect(mocks.setRuntimeAIEnabled).not.toHaveBeenCalled();
    expect(mocks.runtimeAIQueueEnable).not.toHaveBeenCalled();
  });

  it('preloads runtime AI status before persisting consent so a failed response cannot misreport a saved change', async () => {
    configureLocalAudit();
    mocks.aiStatus.mockResolvedValue({ configured: true });
    mocks.getLatestRuntimeAIAdvisory.mockRejectedValueOnce(new Error('status unavailable'));

    await expect(
      tracemindController.setRuntimeAIEnabled('location-1', auditId, true)
    ).rejects.toThrow('status unavailable');

    expect(mocks.setRuntimeAIEnabled).not.toHaveBeenCalled();
    expect(mocks.runtimeAIQueueEnable).not.toHaveBeenCalled();
  });

  it('always persists runtime opt-out before reading optional advisory status', async () => {
    configureLocalAudit();
    mocks.getLatestRuntimeAIAdvisory.mockRejectedValueOnce(new Error('status unavailable'));

    await expect(
      tracemindController.setRuntimeAIEnabled('location-1', auditId, false)
    ).resolves.toMatchObject({
      enabled: false,
      auditId,
      statusUnavailable: true,
    });

    expect(mocks.setRuntimeAIEnabled).toHaveBeenCalledWith('location-1', auditId, false);
    expect(mocks.runtimeAIQueueDisable).toHaveBeenCalledWith('location-1', auditId);
  });

  it('disables runtime AI before a failed opt-out write can leave the queue sending', async () => {
    configureLocalAudit();
    mocks.getRuntimeAIEnabled.mockResolvedValue(true);
    mocks.setRuntimeAIEnabled.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(
      tracemindController.setRuntimeAIEnabled('location-1', auditId, false)
    ).rejects.toThrow('storage unavailable');

    expect(mocks.runtimeAIQueueDisable).toHaveBeenCalledWith('location-1', auditId);
    expect(mocks.runtimeAIQueueDisable.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setRuntimeAIEnabled.mock.invocationCallOrder[0]
    );
    await expect(
      tracemindController.getRuntimeAISettings('location-1', auditId)
    ).resolves.toMatchObject({ enabled: false, auditId });
  });

  it('enables analysis only for an opted-in local audit and sends newly ingested snapshots to the queue', async () => {
    configureLocalAudit();
    mocks.aiStatus.mockResolvedValue({ configured: true });
    await expect(
      tracemindController.setRuntimeAIEnabled('location-1', auditId, true)
    ).resolves.toMatchObject({
      enabled: true,
      auditId,
      latestAdvisory: null,
      lastFailureAt: null,
    });
    expect(mocks.setRuntimeAIEnabled).toHaveBeenCalledWith('location-1', auditId, true);
    expect(mocks.runtimeAIQueueEnable).toHaveBeenCalledWith(snapshot);

    const signal: RuntimeSignal = {
      id: 'a'.repeat(64),
      kind: 'log',
      source: 'otlp',
      observedAt: 1_730_000_000_000,
      serviceName: 'payments',
      name: 'payment_failure',
      severity: 'ERROR',
      status: 'error',
      attributes: {},
    };
    const observedSnapshot: RuntimeSnapshot = { ...snapshot, signals: [signal], acceptedCount: 1 };
    mocks.getRuntimeAIEnabled.mockResolvedValue(true);
    mocks.ingestRuntimeSignals.mockResolvedValue(observedSnapshot);
    mocks.startRuntimeReceiver.mockResolvedValue({
      active: true,
      endpoint: 'http://127.0.0.1:42345',
      startedAt: 10,
      token: 'temporary-token',
      close: vi.fn(async () => undefined),
    });
    await tracemindController.startRuntimeReceiver('location-1', auditId);
    const callback = mocks.startRuntimeReceiver.mock.calls[0]?.[0] as
      | ((signals: RuntimeSignal[], rejectedCount: number) => Promise<RuntimeSnapshot>)
      | undefined;
    if (!callback) throw new Error('Runtime receiver callback was not registered');
    await callback([signal], 0);
    expect(mocks.runtimeAIQueueObserve).toHaveBeenCalledWith(observedSnapshot);
    await tracemindController.stopRuntimeReceiver('location-1');
  });

  it('disables the old audit queue before a receiver switches to another audit', async () => {
    configureLocalAudit();
    const oldReceiver = {
      active: true,
      endpoint: 'http://127.0.0.1:42345',
      startedAt: 10,
      token: 'temporary-token-old',
      close: vi.fn(async () => undefined),
    };
    const newReceiver = {
      active: true,
      endpoint: 'http://127.0.0.1:42346',
      startedAt: 20,
      token: 'temporary-token-new',
      close: vi.fn(async () => undefined),
    };
    const nextAuditId = '70000000-0000-4000-8000-000000000223';
    mocks.startRuntimeReceiver
      .mockResolvedValueOnce(oldReceiver)
      .mockResolvedValueOnce(newReceiver);
    await tracemindController.startRuntimeReceiver('location-1', auditId);
    mocks.getAudit.mockResolvedValueOnce({
      id: nextAuditId,
      locationId: 'location-1',
      root: '/project',
      identity: '1:2',
      fingerprint: 'fingerprint-next',
    });
    mocks.getRuntimeSignals.mockResolvedValueOnce({ ...snapshot, auditId: nextAuditId });

    await tracemindController.startRuntimeReceiver('location-1', nextAuditId);

    expect(oldReceiver.close).toHaveBeenCalledOnce();
    expect(mocks.runtimeAIQueueDisable).toHaveBeenCalledWith('location-1', auditId);
    expect(mocks.runtimeAIQueueEnable).not.toHaveBeenCalled();
    expect(mocks.startRuntimeReceiver).toHaveBeenCalledTimes(2);
  });
});

it.skipIf(process.platform !== 'win32')(
  'does not prompt or preserve a check approval when execution runtime is unavailable on Windows',
  async () => {
    const runId = '00000000-0000-4000-8000-000000000001';
    const auditId = '00000000-0000-4000-8000-000000000002';
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.getRunProposal.mockResolvedValue({
      id: runId,
      projectId: 'location-1',
      auditId,
      state: 'proposed',
      version: 1,
      verified: false,
    });
    mocks.getAudit.mockResolvedValue({
      id: auditId,
      locationId: 'location-1',
      root: '/project',
      identity: '1:2',
    });

    await expect(
      tracemindController.requestCheckApproval('location-1', auditId, runId)
    ).resolves.toBe('unavailable');
    expect(mocks.verificationRevoke).toHaveBeenCalledWith('location-1', runId);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.verificationRequest).not.toHaveBeenCalled();
  }
);

it('requires a local project before comparing captured evidence', async () => {
  mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
  mocks.compareEvidence.mockResolvedValue({ status: 'unavailable' });
  await expect(
    tracemindController.compareAuditEvidence('location-1', 'old', 'new')
  ).resolves.toEqual({ status: 'unavailable' });
  expect(mocks.compareEvidence).toHaveBeenCalledWith('location-1', 'old', 'new');
  mocks.lookup.mockResolvedValue(undefined);
  await expect(tracemindController.compareAuditEvidence('missing', 'old', 'new')).rejects.toThrow(
    'local'
  );
});

describe('TraceMind issue RPC', () => {
  it('requires a registered local location and delegates issue operations', async () => {
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.create.mockResolvedValue({ id: 'issue' });
    await tracemindController.createIssue('location-1', { title: 'Bug', description: '' });
    expect(mocks.create).toHaveBeenCalledWith('location-1', { title: 'Bug', description: '' });
    await tracemindController.listIssues('location-1');
    expect(mocks.list).toHaveBeenCalledWith('location-1');
    await tracemindController.updateIssue('location-1', 'issue', 1, {
      title: 'Edited',
      description: '',
    });
    expect(mocks.update).toHaveBeenCalledWith('location-1', 'issue', 1, {
      title: 'Edited',
      description: '',
    });
    const phaseInput = { nextState: 'queued' as const, rationale: 'Queue for evidence gathering' };
    await tracemindController.transitionIssueInvestigation('location-1', 'issue', 2, phaseInput);
    expect(mocks.transitionIssueInvestigation).toHaveBeenCalledWith(
      'location-1',
      'issue',
      2,
      phaseInput
    );
  });

  it('rejects unknown and remote locations', async () => {
    mocks.lookup.mockResolvedValue(undefined);
    await expect(tracemindController.listIssues('missing')).rejects.toThrow('local');
    mocks.lookup.mockResolvedValue({ id: 'remote', sshHost: 'host' });
    await expect(tracemindController.listIssues('remote')).rejects.toThrow('local');
    await expect(
      tracemindController.transitionIssueInvestigation('remote', 'issue', 1, {
        nextState: 'queued',
        rationale: 'Queue for evidence gathering',
      })
    ).rejects.toThrow('local');
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('TraceMind AI investigation RPC', () => {
  const issue = {
    id: '70000000-0000-4000-8000-000000000071',
    locationId: 'location-1',
    title: 'Slow response',
    description: 'A request sometimes takes too long.',
    version: 4,
    currentRevision: 'rev-1',
    status: 'open',
    investigationState: 'forming_hypotheses',
    staleEvidence: false,
    auditId: null,
  };
  const reference = {
    id: 'ev_issue_description',
    kind: 'issue' as const,
    label: 'Issue description',
    excerpt: issue.description,
    path: null,
    startLine: null,
    endLine: null,
    revision: 'rev-1',
    freshness: 'fresh' as const,
    certainty: 'recorded' as const,
    provenance: 'issue-store',
    extractionMethod: 'structured issue record',
  };
  const modelResponse = {
    summary: 'The issue description indicates intermittent latency.',
    summaryEvidenceIds: [reference.id],
    hypotheses: [
      {
        rank: 1,
        statement: 'A downstream dependency may be slow.',
        confidence: 'low' as const,
        rationale: 'No request trace is available.',
        evidenceIds: [reference.id],
      },
    ],
    recommendations: [
      {
        rank: 1,
        action: 'Capture a request trace.',
        rationale: 'The trace can separate local time from downstream wait.',
        evidenceIds: [reference.id],
      },
    ],
    limitations: ['No runtime trace is available.'],
  };
  const bundle = {
    projectId: 'location-1',
    issueId: issue.id,
    issueVersion: issue.version,
    currentRevision: 'rev-1',
    issue: {
      title: issue.title,
      description: issue.description,
      status: issue.status as 'open',
      priority: 'medium' as const,
      investigationState: issue.investigationState,
    },
    evidence: [reference],
    limitations: [],
  };

  it('exposes provider settings without a key and forwards explicit save/clear requests', async () => {
    mocks.aiStatus.mockResolvedValue({
      configured: true,
      endpoint: 'https://api.openai.com/v1',
      model: 'example-model',
    });
    mocks.configureAI.mockResolvedValue({
      configured: true,
      endpoint: 'https://api.openai.com/v1',
      model: 'example-model',
    });
    mocks.clearAI.mockResolvedValue({
      configured: false,
      endpoint: 'https://api.openai.com/v1',
      model: 'example-model',
    });
    const status = await tracemindController.getAIProviderStatus();
    expect(status).toEqual({
      configured: true,
      endpoint: 'https://api.openai.com/v1',
      model: 'example-model',
    });
    expect(status).not.toHaveProperty('apiKey');
    await tracemindController.configureAIProvider({
      endpoint: 'https://api.openai.com/v1',
      model: 'example-model',
      apiKey: 'key-is-only-an-input',
    });
    await tracemindController.clearAIProvider();
    expect(mocks.runtimeAIQueueCloseAll).toHaveBeenCalledOnce();
    expect(mocks.clearAllRuntimeAIEnabled).toHaveBeenCalledOnce();
    expect(mocks.configureAI).toHaveBeenCalledWith({
      endpoint: 'https://api.openai.com/v1',
      model: 'example-model',
      apiKey: 'key-is-only-an-input',
    });
    expect(mocks.clearAI).toHaveBeenCalledOnce();
  });

  it('retrieves scoped evidence, calls the configured gateway, strips excerpts before persistence, and leaves lifecycle unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-ai-project-'));
    try {
      mocks.lookup.mockResolvedValue({ id: 'location-1', dir: root, sshHost: null });
      mocks.getIssue.mockResolvedValueOnce(issue).mockResolvedValueOnce(issue);
      mocks.retrieveAI.mockResolvedValue(bundle);
      mocks.generateAI.mockResolvedValue({ model: 'example-model', response: modelResponse });
      mocks.latestGraph.mockResolvedValue({ revision: 'rev-1' });
      mocks.persistAI.mockResolvedValue({ issue, event: {} });

      const result = await tracemindController.generateAIInvestigation('location-1', issue.id);
      expect(mocks.retrieveAI).toHaveBeenCalledWith('location-1', issue, await realpath(root));
      expect(mocks.generateAI).toHaveBeenCalledWith(bundle);
      expect(mocks.persistAI).toHaveBeenCalledOnce();
      expect(mocks.retrieveAI).toHaveBeenCalledTimes(2);
      const persisted = mocks.persistAI.mock.calls[0]?.[4];
      expect(persisted).toMatchObject({
        provider: 'openai-compatible',
        model: 'example-model',
        evidenceRevision: 'rev-1',
        summaryEvidenceIds: [reference.id],
      });
      expect(persisted.evidenceReferences[0]).not.toHaveProperty('excerpt');
      expect(result.hypotheses[0]).toMatchObject({ rank: 1, evidenceIds: [reference.id] });
      expect(mocks.persistAI.mock.calls[0]?.[2]).toBe(issue.version);
      expect(mocks.persistAI.mock.calls[0]?.[3]).toBe(issue.currentRevision);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('downgrades cited source freshness when a file changes during model generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-ai-project-'));
    const sourceReference = {
      ...reference,
      id: 'ev_source_file',
      kind: 'source_excerpt' as const,
      label: 'src/handler.ts',
      path: 'src/handler.ts',
      extractionMethod: 'bounded-source-excerpt',
    };
    const initialBundle = { ...bundle, evidence: [sourceReference] };
    const completionBundle = {
      ...initialBundle,
      evidence: [{ ...sourceReference, freshness: 'stale' as const }],
    };
    const sourceResponse = {
      ...modelResponse,
      summaryEvidenceIds: [sourceReference.id],
      hypotheses: [{ ...modelResponse.hypotheses[0]!, evidenceIds: [sourceReference.id] }],
      recommendations: [
        { ...modelResponse.recommendations[0]!, evidenceIds: [sourceReference.id] },
      ],
    };
    try {
      mocks.lookup.mockResolvedValue({ id: 'location-1', dir: root, sshHost: null });
      mocks.getIssue.mockResolvedValueOnce(issue).mockResolvedValueOnce(issue);
      mocks.retrieveAI.mockResolvedValueOnce(initialBundle).mockResolvedValueOnce(completionBundle);
      mocks.generateAI.mockResolvedValue({ model: 'example-model', response: sourceResponse });
      mocks.latestGraph.mockResolvedValue({ revision: 'rev-1' });
      mocks.persistAI.mockResolvedValue({ issue, event: {} });

      const result = await tracemindController.generateAIInvestigation('location-1', issue.id);
      expect(result.freshness).toBe('stale');
      expect(result.evidenceReferences[0]).toMatchObject({
        freshness: 'stale',
        path: 'src/handler.ts',
      });
      expect(result.limitations).toContain(
        'One or more cited evidence items were stale or unverifiable at completion recheck.'
      );
      expect(mocks.persistAI.mock.calls[0]?.[4].evidenceReferences[0]).not.toHaveProperty(
        'excerpt'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not persist model output when the issue changed during generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-ai-project-'));
    try {
      mocks.lookup.mockResolvedValue({ id: 'location-1', dir: root, sshHost: null });
      mocks.getIssue.mockResolvedValueOnce(issue).mockResolvedValueOnce({ ...issue, version: 5 });
      mocks.retrieveAI.mockResolvedValue(bundle);
      mocks.generateAI.mockResolvedValue({ model: 'example-model', response: modelResponse });
      mocks.latestGraph.mockResolvedValue({ revision: 'rev-1' });
      await expect(
        tracemindController.generateAIInvestigation('location-1', issue.id)
      ).rejects.toThrow('Issue changed during AI investigation');
      expect(mocks.persistAI).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('TraceMind check capability and issue-linked check results', () => {
  it('withholds approval and reports unavailable when the selected executable is missing', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
    try {
      const runId = '70000000-0000-4000-8000-000000000001';
      const auditId = '70000000-0000-4000-8000-000000000002';
      mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
      mocks.getRunProposal.mockResolvedValue({
        id: runId,
        auditId,
        state: 'proposed',
        proposal: { executable: 'go' },
      });
      mocks.getAudit.mockResolvedValue({
        id: auditId,
        root: '/project',
        identity: '1:2',
        analysisVersion: AUDIT_ANALYZER_VERSION,
      });
      mocks.findExecutable.mockImplementation((name: string) =>
        name === 'node' || name === 'npm' ? `/trusted/${name}` : null
      );

      await expect(
        tracemindController.getCheckCapability('location-1', runId)
      ).resolves.toMatchObject({
        platform: 'linux',
        status: 'unavailable',
        canRunDiscoveredChecks: false,
        reason: 'No trusted go executable is available; approval is withheld.',
      });
      await expect(
        tracemindController.requestCheckApproval('location-1', auditId, runId)
      ).resolves.toBe('unavailable');
      expect(mocks.consume).not.toHaveBeenCalled();
      expect(mocks.verificationRequest).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('withholds Linux proposal capability and approval when cgroup preflight fails', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
    const runId = '70000000-0000-4000-8000-000000000011';
    const auditId = '70000000-0000-4000-8000-000000000012';
    const limits = { processCount: 7, memoryBytes: 268_435_456 };
    try {
      mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
      mocks.getRunProposal.mockResolvedValue({
        id: runId,
        auditId,
        state: 'proposed',
        proposal: { executable: 'go', limits, sandboxMode: 'unavailable' },
      });
      mocks.getAudit.mockResolvedValue({
        id: auditId,
        root: '/project',
        identity: '1:2',
        analysisVersion: AUDIT_ANALYZER_VERSION,
      });
      mocks.findExecutable.mockImplementation((name: string) => `/trusted/${name}`);
      mocks.linuxCgroupPreflight.mockResolvedValue(false);

      await expect(
        tracemindController.getCheckCapability('location-1', runId)
      ).resolves.toMatchObject({
        platform: 'linux',
        status: 'unavailable',
        canRunDiscoveredChecks: false,
        reason:
          'Delegated Linux cgroup v2 memory and process-count controls are unavailable; approval is withheld.',
        missingControls: ['memoryBytes', 'processCount'],
      });
      await expect(
        tracemindController.requestCheckApproval('location-1', auditId, runId)
      ).resolves.toBe('unavailable');

      expect(mocks.linuxCgroupPreflight).toHaveBeenCalledTimes(2);
      expect(mocks.linuxCgroupPreflight).toHaveBeenNthCalledWith(1, limits);
      expect(mocks.linuxCgroupPreflight).toHaveBeenNthCalledWith(2, limits);
      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.verificationRequest).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('allows Linux approval after cgroup preflight, including explicitly unisolated proposals', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
    const runId = '70000000-0000-4000-8000-000000000021';
    const auditId = '70000000-0000-4000-8000-000000000022';
    const limits = { processCount: 11, memoryBytes: 536_870_912 };
    try {
      mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
      mocks.getRunProposal.mockResolvedValue({
        id: runId,
        auditId,
        state: 'proposed',
        proposal: { executable: 'go', limits, sandboxMode: 'unavailable' },
      });
      mocks.getAudit.mockResolvedValue({
        id: auditId,
        root: '/project',
        identity: '1:2',
        analysisVersion: AUDIT_ANALYZER_VERSION,
      });
      mocks.findExecutable.mockImplementation((name: string) => `/trusted/${name}`);
      mocks.request.mockResolvedValue(true);
      mocks.consume.mockResolvedValue({ root: '/project', identity: '1:2' });
      mocks.verificationRequest.mockResolvedValue(true);

      await expect(
        tracemindController.getCheckCapability('location-1', runId)
      ).resolves.toMatchObject({
        status: 'runtime-available',
        canRunDiscoveredChecks: true,
        missingControls: [],
      });
      await expect(
        tracemindController.requestCheckApproval('location-1', auditId, runId)
      ).resolves.toBe('approved');

      expect(mocks.linuxCgroupPreflight).toHaveBeenCalledTimes(2);
      expect(mocks.linuxCgroupPreflight).toHaveBeenNthCalledWith(1, limits);
      expect(mocks.linuxCgroupPreflight).toHaveBeenNthCalledWith(2, limits);
      expect(mocks.request).toHaveBeenCalledWith('location-1', 'check-preview');
      expect(mocks.verificationRequest).toHaveBeenCalledWith('location-1', runId);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'exposes the consented macOS sandbox mode as runnable but unverified',
    async () => {
      const runId = '70000000-0000-4000-8000-000000000001';
      const auditId = '70000000-0000-4000-8000-000000000002';
      mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
      mocks.getRunProposal.mockResolvedValue({
        id: runId,
        auditId,
        state: 'proposed',
        proposal: { executable: 'npm', limits: { processCount: 32, memoryBytes: 1_073_741_824 } },
      });
      mocks.getAudit.mockResolvedValue({
        id: auditId,
        root: '/project',
        identity: '1:2',
        analysisVersion: AUDIT_ANALYZER_VERSION,
      });
      mocks.findExecutable.mockImplementation((name: string) => `/trusted/${name}`);
      mocks.request.mockResolvedValue(true);
      mocks.consume.mockResolvedValue({ root: '/project', identity: '1:2' });
      mocks.verificationRequest.mockResolvedValue(true);

      await expect(
        tracemindController.getCheckCapability('location-1', runId)
      ).resolves.toMatchObject({
        platform: 'darwin',
        status: 'runtime-available-unverified',
        canRunDiscoveredChecks: true,
        missingControls: ['memoryBytes', 'processCount'],
      });
      await expect(
        tracemindController.requestCheckApproval('location-1', auditId, runId)
      ).resolves.toBe('approved');
      expect(mocks.request).toHaveBeenCalledWith('location-1', 'check-preview');
      expect(mocks.verificationRequest).toHaveBeenCalledWith('location-1', runId);
    }
  );

  it('links only a terminal runner result from the issue-linked audit and records its actual outcome', async () => {
    const issueId = '70000000-0000-4000-8000-000000000003';
    const runId = '70000000-0000-4000-8000-000000000001';
    const auditId = '70000000-0000-4000-8000-000000000002';
    const criterionId = '70000000-0000-4000-8000-000000000004';
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.getIssue.mockResolvedValue({ id: issueId, auditId });
    mocks.getAudit.mockResolvedValue({ id: auditId, revision: null });
    mocks.getRunProposal.mockResolvedValue({
      id: runId,
      auditId,
      state: 'finished',
      verified: false,
      result: {
        status: 'exited',
        exitCode: 7,
        signal: null,
        effectiveLimits: { processCount: false, memory: false },
      },
    });
    mocks.appendIssueCheckResult.mockResolvedValue({ event: { type: 'check_result' } });

    await tracemindController.recordIssueCheckResult(
      'location-1',
      issueId,
      4,
      auditId,
      runId,
      'Investigated nonzero result.',
      criterionId
    );
    expect(mocks.appendIssueCheckResult).toHaveBeenCalledWith('location-1', issueId, 4, {
      auditId,
      note: 'Investigated nonzero result.',
      revision: null,
      criterionId,
      outcome: {
        runId,
        state: 'finished',
        status: 'exited',
        verified: false,
        exitCode: 7,
        signal: null,
        effectiveLimits: { processCount: false, memory: false },
      },
    });

    mocks.getRunProposal.mockResolvedValue({
      id: runId,
      auditId,
      state: 'proposed',
      verified: false,
    });
    await expect(
      tracemindController.recordIssueCheckResult(
        'location-1',
        issueId,
        4,
        auditId,
        runId,
        'Fabricated pass',
        criterionId
      )
    ).rejects.toThrow('terminal result');
    expect(mocks.appendIssueCheckResult).toHaveBeenCalledTimes(1);
  });
});

describe('TraceMind audit RPC', () => {
  it('runs and lists audits for a registered local location', async () => {
    mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
    mocks.native.mockReturnValue({});
    mocks.runAudit.mockResolvedValue({ id: 'audit' });
    await expect(tracemindController.runAudit('location-1')).resolves.toEqual({ id: 'audit' });
    expect(mocks.runAudit).toHaveBeenCalledWith(
      'location-1',
      expect.objectContaining({ consume: expect.any(Function), save: mocks.saveAudit })
    );
    await tracemindController.listAudits('location-1');
    expect(mocks.listAudits).toHaveBeenCalledWith('location-1');
  });
  it('rejects unregistered locations before running an audit', async () => {
    mocks.lookup.mockResolvedValue(undefined);
    await expect(tracemindController.runAudit('missing')).rejects.toThrow('local');
    expect(mocks.runAudit).not.toHaveBeenCalled();
  });
});

it('exposes persistent graph inspection, entry recording and benchmark RPCs locally', async () => {
  mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
  mocks.listGraphs.mockResolvedValue([]);
  mocks.getGraph.mockResolvedValue(null);
  mocks.overview.mockResolvedValue(null);
  mocks.graphRelationships.mockResolvedValue({
    revision: 'r',
    relationships: [],
    nextCursor: null,
  });
  mocks.graphParserFailures.mockResolvedValue({
    revision: 'r',
    pageSize: 50,
    failures: [],
    nextCursor: null,
  });
  mocks.inspectGraph.mockResolvedValue({
    nodes: [],
    relationships: [],
    truncated: false,
    stopReason: null,
  });
  mocks.benchmarkGraph.mockResolvedValue({ adapter: 'sqlite-kv' });
  mocks.recordGraph.mockResolvedValue({ revision: 'r' });
  await tracemindController.getGraphOverview('location-1', 'r', null);
  await tracemindController.getGraphParserFailurePage('location-1', 'r', null);
  await tracemindController.getGraphRelationshipPage('location-1', 'r', null);
  await tracemindController.inspectGraph('location-1', 'r', 'node', {
    maxDepth: 1,
    maxResults: 1,
    maxEdges: 1,
    maxTimeMs: 1,
  });
  await tracemindController.benchmarkGraphAdapter('location-1', 'r');
  await expect(
    tracemindController.recordGraphEntry('location-1', 'r', {
      kind: 'hypothesis',
      label: 'Theory',
      reason: 'User supplied',
    })
  ).resolves.toBeUndefined();
  expect(mocks.overview).toHaveBeenCalledWith('location-1', 'r', null);
  expect(mocks.graphParserFailures).toHaveBeenCalledWith('location-1', 'r', null);
  expect(mocks.graphRelationships).toHaveBeenCalledWith('location-1', 'r', null);
  expect(mocks.inspectGraph).toHaveBeenCalled();
  expect(mocks.benchmarkGraph).toHaveBeenCalledWith('location-1', 'r');
  expect(mocks.recordGraph).toHaveBeenCalled();
  mocks.lookup.mockResolvedValue(undefined);
  await expect(tracemindController.getGraphOverview('missing', 'r', null)).rejects.toThrow('local');
  await expect(tracemindController.getGraphParserFailurePage('missing', 'r', null)).rejects.toThrow(
    'local'
  );
});

it('does not expose full graph snapshots to the renderer', () => {
  expect(tracemindController).not.toHaveProperty('getGraphSnapshot');
  expect(tracemindController).not.toHaveProperty('listGraphSnapshots');
});

it.skipIf(process.platform !== 'darwin')(
  'searches registered graph files and reveals only canonical in-project files in Finder',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-graph-reveal-'));
    const outside = await mkdtemp(join(tmpdir(), 'tracemind-outside-'));
    try {
      await writeFile(join(root, 'inside.ts'), 'export const inside = true;');
      await writeFile(join(outside, 'outside.ts'), 'secret');
      await symlink(join(outside, 'outside.ts'), join(root, 'escape.ts'));
      mocks.lookup.mockResolvedValue({ id: 'location-1', dir: root, sshHost: null });
      mocks.graphFileSearch.mockResolvedValue({ revision: 'r', files: [], nextCursor: null });
      mocks.graphFileNodes.mockResolvedValue({
        revision: 'r',
        path: 'inside.ts',
        nodes: [],
        nextCursor: null,
      });
      await expect(
        tracemindController.searchGraphFiles('location-1', 'r', 'inside', null)
      ).resolves.toMatchObject({ files: [] });
      expect(mocks.graphFileSearch).toHaveBeenCalledWith('location-1', 'r', 'inside', null);
      await expect(
        tracemindController.getGraphFileNodesPage('location-1', 'r', 'inside.ts', null)
      ).resolves.toMatchObject({ path: 'inside.ts' });
      await tracemindController.revealGraphFileInFinder('location-1', 'r', 'inside.ts');
      expect(mocks.showItemInFolder).toHaveBeenCalledWith(await realpath(join(root, 'inside.ts')));
      await expect(
        tracemindController.revealGraphFileInFinder('location-1', 'r', 'escape.ts')
      ).rejects.toThrow('outside');
      await expect(
        tracemindController.revealGraphFileInFinder('location-1', 'r', '../outside.ts')
      ).rejects.toThrow();
      mocks.graphFileNodes.mockResolvedValueOnce(null);
      await expect(
        tracemindController.revealGraphFileInFinder('location-1', 'r', 'inside.ts')
      ).rejects.toThrow('not found');
      expect(mocks.showItemInFolder).toHaveBeenCalledTimes(1);
      mocks.lookup.mockResolvedValue(undefined);
      await expect(
        tracemindController.searchGraphFiles('location-1', 'r', '', null)
      ).rejects.toThrow('local');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
);

it('retrieves an audit evidence page only for a registered local project', async () => {
  mocks.lookup.mockResolvedValue({ id: 'location-1', sshHost: null });
  mocks.listEvidence.mockResolvedValue({ items: [], nextOffset: null });
  await expect(tracemindController.listAuditEvidence('location-1', 'audit-id', 0)).resolves.toEqual(
    { items: [], nextOffset: null }
  );
  expect(mocks.listEvidence).toHaveBeenCalledWith('location-1', 'audit-id', 0, 50);
});
