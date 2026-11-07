import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app, dialog, shell } from 'electron';
import { getMainWindow } from '@main/app/window';
import { getLocationById } from '@main/core/locations/store';
import { findExecutableOnPath } from '@main/core/utils/resolve-executable';
import type {
  TraceMindAIInvestigation,
  TraceMindAIProviderInput,
  TraceMindRuntimeAISettings,
} from '@shared/core/tracemind/ai-investigation';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  clearAIProvider,
  configureAIProvider,
  generateTraceMindAIResponse,
  getAIProviderStatus,
  testAIProviderConnection,
} from './ai/gateway';
import { auditSnapshotMatchesCurrent, runLocalAudit } from './audit/audit-service';
import {
  compareAuditEvidence,
  getAudit,
  getAuditInvalidation,
  getAuditReport,
  listAuditEvidence,
  listAudits,
  recordAuditInvalidation,
  recordGraphIndexFailure,
  recordGraphCoverage,
  saveAudit,
  type AuditRecord,
} from './audit/audit-store';
import { auditNeedsRefresh } from './audit/audit-version';
import { getBoundBrainPolicy } from './brain/binding';
import { setWatchedBrainRevision } from './brain/freshness';
import { getLocalBrainContext } from './brain/local-context';
import { brainPolicySchema } from './brain/policy';
import { BrainRefreshQueue } from './brain/refresh';
import { getBrainPolicy, saveBrainPolicy, getBrainChanges, recordBrainChange } from './brain/store';
import { benchmarkGraphAdapter } from './graph/benchmark';
import { inspectGraph } from './graph/graph-query';
import { indexAuditGraph } from './graph/graph-service';
import {
  appendGraphRecordBounded,
  ensureGraphRevision,
  getLatestGraphSnapshot,
  getGraphOverview,
  getGraphParserFailurePage,
  getGraphRelationshipPage,
  getGraphFileNodesPage,
  searchGraphFiles,
  type GraphRecordInput,
} from './graph/graph-store';
import { graphPathSchema } from './graph/model';
import { retrieveAIInvestigationEvidence } from './investigation/ai-evidence';
import {
  appendIssueCheckResult,
  appendIssueEvent,
  createIssue,
  getIssue,
  listIssueEvents,
  listIssues,
  markIssueEvidenceStale,
  reviewIssueEvidence,
  recordAIInvestigation,
  transitionIssue,
  transitionIssueInvestigation as persistIssueInvestigation,
  updateIssue,
  updateIssueMetadata,
  type IssueEventInput,
  type IssueInvestigationOutcome,
  type IssueInvestigationState,
  type IssueInput,
  type IssuePriority,
  type IssueStatus,
} from './investigation/issue-store';
import { generateInvestigationReport } from './investigation/report';
import { closeNativeFileHandle, nativeFileIdentity } from './native/access-registry';
import { loadNativeProjectFs } from './native/native-loader';
import { AuditApprovalService } from './project-registry/approval-service';
import {
  createTraceMindLiveMonitor,
  type LiveMonitorSnapshot,
  type LiveMonitorState,
  type TraceMindLiveMonitor,
} from './project-registry/live-monitor';
import { pickLocalProject } from './project-registry/pick-project';
import { resolveSelectedLocalProject } from './project-registry/selected-project';
import { TraceMindRuntimeAIQueue } from './runtime/ai-queue';
import {
  clearAllRuntimeAIEnabled,
  getRuntimeAILastFailureAt,
  getLatestRuntimeAIAdvisory,
  getRuntimeAIEnabled,
  recordRuntimeAIAnalysisFailure,
  recordRuntimeAIAdvisory,
  setRuntimeAIEnabled,
} from './runtime/ai-state-store';
import { parseRuntimeJson } from './runtime/model';
import { startRuntimeReceiver, type RuntimeReceiverHandle } from './runtime/receiver';
import { getRuntimeSignals, ingestRuntimeSignals } from './runtime/telemetry-store';
import { VerificationApprovalService } from './verification/approval-service';
import { checkExecutables, type CheckExecutable } from './verification/command-contract';
import { DiscoveryCache } from './verification/discovery-cache';
import { preflightLinuxCgroupLimits } from './verification/linux-cgroup-v2';
import { createLocalVerificationRunner } from './verification/local-runner';
import { getMacosCheckCapability } from './verification/macos-capability';
import {
  closeRunProposal,
  createRunProposal,
  getRunProposal,
  getRunOutputArtifact,
  getRunResultPreview,
  listRunProposals,
} from './verification/run-store';
import { fingerprintRuntime } from './verification/runtime-fingerprint';
import { detectSandboxMode } from './verification/sandbox';
import { discoverAuditedChecks, verifyApprovalSnapshot } from './verification/snapshot-verifier';

function loadTraceMindNative(): ReturnType<typeof loadNativeProjectFs> {
  return loadNativeProjectFs({
    platform: process.platform,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
}

async function approvedRootIdentity(root: string): Promise<string> {
  const native = loadTraceMindNative();
  const handle = native.openRoot(root);
  try {
    return nativeFileIdentity(native, handle);
  } finally {
    closeNativeFileHandle(native, handle);
  }
}

const rootApprovalOptions = { directoryIdentity: approvedRootIdentity };
const approvals = new AuditApprovalService(rootApprovalOptions);
const discoveryApprovals = new AuditApprovalService(rootApprovalOptions);
const checkScanApprovals = new AuditApprovalService(rootApprovalOptions);
const discoveredChecks = new DiscoveryCache();
let auditRunning = false;
let discoveryRunning = false;
let checkPreviewRunning = false;
const activeCheckRunners = new Map<
  string,
  { locationId: string; auditId: string; runner: ReturnType<typeof createLocalVerificationRunner> }
>();
const activeBrainRefresh = new Map<string, BrainRefreshQueue>();
const activeAuditMonitor = new Map<string, TraceMindLiveMonitor>();
const activeRuntimeReceivers = new Map<
  string,
  { auditId: string; receiver: RuntimeReceiverHandle }
>();
const runtimeAIOptOutOverrides = new Set<string>();
const runtimeAIQueue = new TraceMindRuntimeAIQueue({
  persist: async (advisory) =>
    recordRuntimeAIAdvisory(advisory.projectId, advisory.auditId, advisory),
  onError: async ({ locationId, auditId }) => recordRuntimeAIAnalysisFailure(locationId, auditId),
});

function auditMonitorKey(locationId: string, auditId: string): string {
  return `${locationId}:${auditId}`;
}

function runtimeAIOptOutKey(locationId: string, auditId: string): string {
  return `${locationId}\u0000${auditId}`;
}

async function stopAllAuditMonitors(): Promise<void> {
  await Promise.all([...activeBrainRefresh.values()].map((queue) => queue.close()));
  activeBrainRefresh.clear();
  const monitors = [...activeAuditMonitor.values()];
  activeAuditMonitor.clear();
  await Promise.all(monitors.map((monitor) => monitor.stop().catch(() => undefined)));
}

async function stopAllRuntimeReceivers(): Promise<void> {
  const receivers = [...activeRuntimeReceivers.entries()];
  activeRuntimeReceivers.clear();
  runtimeAIQueue.closeAll();
  await Promise.all(receivers.map(([, item]) => item.receiver.close().catch(() => undefined)));
}

if (typeof app.on === 'function') {
  let shutdownInProgress = false;
  app.on('before-quit', (event) => {
    if (shutdownInProgress || (activeAuditMonitor.size === 0 && activeRuntimeReceivers.size === 0))
      return;
    event.preventDefault();
    shutdownInProgress = true;
    void Promise.all([stopAllAuditMonitors(), stopAllRuntimeReceivers()]).finally(() => app.quit());
  });
}

async function getAuditMonitorStatus(
  locationId: string,
  auditId: string
): Promise<{
  active: boolean;
  state: LiveMonitorState;
  invalidation: Awaited<ReturnType<typeof getAuditInvalidation>>;
}> {
  const monitor = activeAuditMonitor.get(auditMonitorKey(locationId, auditId));
  const snapshot: LiveMonitorSnapshot | null = monitor?.snapshot ?? null;
  let marker = await getAuditInvalidation(locationId, auditId);
  // A persisted `watching` marker without a process-local monitor indicates an app restart
  // or crash; approval never survives that boundary, so close the stale session explicitly.
  if (!monitor && marker?.state === 'watching') {
    marker = await recordAuditInvalidation(locationId, auditId, {
      state: 'stopped',
      changedCount: 0,
      changedPaths: [],
      pathsTruncated: false,
      eventAt: Date.now(),
    });
  }
  return {
    active: snapshot !== null && !snapshot.closed && snapshot.state === 'watching',
    state: snapshot?.state ?? marker?.state ?? 'idle',
    invalidation: marker,
  };
}
function checkRuntime() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const toolExecutables: Partial<Record<CheckExecutable, string>> = {};
  for (const executable of checkExecutables) {
    const path = findExecutableOnPath(executable);
    if (path && isAbsolute(path)) toolExecutables[executable] = path;
  }
  const nodeExecutable = findExecutableOnPath('node');
  if (!Object.keys(toolExecutables).length || !nodeExecutable || !isAbsolute(nodeExecutable))
    return null;
  const helperExecutable = join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    'dist-tracemind-native',
    'tracemind_verification_cwd'
  );
  return {
    npmExecutable: toolExecutables.npm,
    toolExecutables,
    nodeExecutable,
    helperExecutable,
    runtimeDirectory: dirname(nodeExecutable),
  };
}
const checkApprovals = new VerificationApprovalService({
  load: getRunProposal,
  snapshot: async (locationId, auditId, proposal) => {
    const audit = await getAudit(locationId, auditId);
    if (!audit || auditNeedsRefresh(audit.analysisVersion)) return null;
    const selected = await resolveSelectedLocalProject(locationId, getLocationById);
    if (selected.root !== audit.root) return null;
    const native = loadTraceMindNative();
    const snapshot = await verifyApprovalSnapshot(audit, proposal, native);
    if (!snapshot) return null;
    const runtime = checkRuntime();
    if (!runtime) return null;
    try {
      const selectedExecutable = runtime.toolExecutables[proposal.executable];
      if (!selectedExecutable) return null;
      return {
        ...snapshot,
        toolExecutables: { [proposal.executable]: selectedExecutable },
        runtimeDirectory: runtime.runtimeDirectory,
        npmExecutable: runtime.npmExecutable,
        helperExecutable: runtime.helperExecutable,
        runtimeFingerprint: await fingerprintRuntime([
          selectedExecutable,
          runtime.nodeExecutable,
          runtime.helperExecutable,
        ]),
      };
    } catch {
      return snapshot;
    }
  },
  confirm: async (preview) => {
    const window = getMainWindow();
    if (!window) return 'cancel';
    const isolationConfirmation = preview.includes('FINAL CONFIRMATION REQUIRED');
    const choice = await dialog.showMessageBox(window, {
      type: 'warning',
      title: isolationConfirmation ? 'Confirm unisolated check' : 'Review proposed check',
      message: isolationConfirmation
        ? 'This is a separate final confirmation to run without OS isolation.'
        : 'No check will run from this review.',
      detail: `${preview}\n\nApproval expires after 60 seconds. A separate action starts the check.`,
      buttons: ['Cancel', 'Deny', isolationConfirmation ? 'Run without isolation' : 'Approve once'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return choice.response === 2 ? 'approve' : choice.response === 1 ? 'deny' : 'cancel';
  },
  deny: async (locationId, runId, version) => {
    await closeRunProposal(locationId, runId, version, 'denied');
  },
  now: Date.now,
});

async function requireLocalLocation(locationId: string): Promise<void> {
  if (typeof locationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(locationId)) {
    throw new Error('Invalid location ID');
  }
  const location = await getLocationById(locationId);
  if (!location || location.id !== locationId || location.sshHost !== null) {
    throw new Error('Registered local location required');
  }
}

function requireCurrentAuditAnalysis(audit: AuditRecord | null): asserts audit is AuditRecord {
  if (!audit) throw new Error('Project audit not found');
  if (auditNeedsRefresh(audit.analysisVersion)) {
    throw new Error(
      'Project audit analysis is stale; run a new approved audit before check discovery or execution.'
    );
  }
}

function requireSameAuditAnalysisSnapshot(
  previous: AuditRecord,
  current: AuditRecord | null
): asserts current is AuditRecord {
  requireCurrentAuditAnalysis(current);
  if (
    current.id !== previous.id ||
    current.root !== previous.root ||
    current.identity !== previous.identity ||
    current.fingerprint !== previous.fingerprint ||
    current.analysisVersion !== previous.analysisVersion
  ) {
    throw new Error('Project audit changed after approval; run a new audit.');
  }
}

export const tracemindController = createRPCController({
  pickLocalProject,
  discoverAuditChecks: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    const audit = await getAudit(locationId, auditId);
    requireCurrentAuditAnalysis(audit);
    if (discoveryRunning) throw new Error('Check discovery is already running');
    discoveryRunning = true;
    try {
      if (!(await discoveryApprovals.request(locationId, 'check-discovery'))) return null;
      const approvedAudit = await getAudit(locationId, auditId);
      requireSameAuditAnalysisSnapshot(audit, approvedAudit);
      const project = await discoveryApprovals.consumeProject(locationId);
      if (
        !project ||
        project.root !== approvedAudit.root ||
        project.identity !== approvedAudit.identity
      )
        throw new Error('Project changed since the audit; run a new audit.');
      const native = loadTraceMindNative();
      const result = await discoverAuditedChecks(approvedAudit, native, detectSandboxMode());
      if (!result) throw new Error('Project changed or audit is incomplete; run a new audit.');
      return {
        ...result,
        discoveryId: discoveredChecks.issue(locationId, auditId, result.candidates),
      };
    } finally {
      discoveryRunning = false;
    }
  },
  saveDiscoveredCheck: async (
    locationId: string,
    auditId: string,
    discoveryId: string,
    index: number
  ) => {
    await requireLocalLocation(locationId);
    const audit = await getAudit(locationId, auditId);
    requireCurrentAuditAnalysis(audit);
    return discoveredChecks.save(locationId, auditId, discoveryId, index, (proposal) =>
      createRunProposal(locationId, auditId, proposal)
    );
  },
  getCheckProposal: async (locationId: string, runId: string) => {
    await requireLocalLocation(locationId);
    return getRunProposal(locationId, runId);
  },
  getCheckResultPreview: async (locationId: string, auditId: string, runId: string) => {
    await requireLocalLocation(locationId);
    return getRunResultPreview(locationId, auditId, runId);
  },
  getCheckOutputArtifact: async (
    locationId: string,
    auditId: string,
    runId: string,
    stream: 'stdout' | 'stderr'
  ) => {
    await requireLocalLocation(locationId);
    return getRunOutputArtifact({ projectId: locationId, auditId, runId, stream });
  },
  listCheckProposals: async (locationId: string, auditId: string, cursor: string | null) => {
    await requireLocalLocation(locationId);
    if (!(await getAudit(locationId, auditId))) throw new Error('Project audit not found');
    return listRunProposals(locationId, auditId, cursor);
  },
  cancelCheckProposal: async (
    locationId: string,
    auditId: string,
    runId: string,
    version: number
  ) => {
    await requireLocalLocation(locationId);
    const record = await getRunProposal(locationId, runId);
    if (!record || record.auditId !== auditId) throw new Error('Audit proposal not found');
    if (record.state !== 'proposed' || record.version !== version)
      throw new Error('Run proposal changed or is terminal');
    checkApprovals.revoke(locationId, runId);
    return closeRunProposal(locationId, runId, version, 'cancelled');
  },
  requestCheckApproval: async (
    locationId: string,
    auditId: string,
    runId: string
  ): Promise<'approved' | 'denied' | 'not-approved' | 'unavailable'> => {
    await requireLocalLocation(locationId);
    const record = await getRunProposal(locationId, runId);
    if (!record || record.auditId !== auditId || record.state !== 'proposed')
      throw new Error('Pending audit proposal not found');
    const audit = await getAudit(locationId, auditId);
    requireCurrentAuditAnalysis(audit);
    if (checkPreviewRunning) throw new Error('A check review is already running');
    checkPreviewRunning = true;
    try {
      checkApprovals.revoke(locationId, runId);
      // Revoke any prior one-use grant before checking capability. Do not
      // create a new grant for a check this host cannot start; Windows lacks
      // descriptor-bound working-directory handoff.
      if (
        process.platform === 'darwin' &&
        !getMacosCheckCapability(detectSandboxMode()).canRunDiscoveredChecks
      )
        return 'unavailable';
      const runtime = checkRuntime();
      if (!runtime || !runtime.toolExecutables[record.proposal.executable]) return 'unavailable';
      if (
        process.platform === 'linux' &&
        !(await preflightLinuxCgroupLimits(record.proposal.limits))
      )
        return 'unavailable';
      if (!(await checkScanApprovals.request(locationId, 'check-preview'))) return 'not-approved';
      const approvedAudit = await getAudit(locationId, auditId);
      requireSameAuditAnalysisSnapshot(audit, approvedAudit);
      const project = await checkScanApprovals.consumeProject(locationId);
      if (
        !project ||
        project.root !== approvedAudit.root ||
        project.identity !== approvedAudit.identity
      )
        throw new Error('Project changed since the audit; run a new audit.');
      if (await checkApprovals.request(locationId, runId)) return 'approved';
      const latest = await getRunProposal(locationId, runId);
      return latest?.state === 'denied' ? 'denied' : 'not-approved';
    } finally {
      checkPreviewRunning = false;
    }
  },
  runApprovedCheck: async (locationId: string, auditId: string, runId: string) => {
    await requireLocalLocation(locationId);
    const audit = await getAudit(locationId, auditId);
    requireCurrentAuditAnalysis(audit);
    if (
      process.platform === 'darwin' &&
      !getMacosCheckCapability(detectSandboxMode()).canRunDiscoveredChecks
    )
      throw new Error(getMacosCheckCapability(detectSandboxMode()).reason);
    const record = await getRunProposal(locationId, runId);
    if (!record || record.auditId !== auditId || record.state !== 'proposed')
      throw new Error('Pending audit proposal not found');
    const runtime = checkRuntime();
    if (!runtime || !runtime.toolExecutables[record.proposal.executable])
      throw new Error(`Trusted executable for ${record.proposal.executable} is unavailable`);
    const native = loadTraceMindNative();
    const runner = createLocalVerificationRunner({
      approvals: checkApprovals,
      native,
      npmExecutable: runtime.npmExecutable,
      toolExecutables: runtime.toolExecutables,
      helperExecutable: runtime.helperExecutable,
    });
    if (activeCheckRunners.has(runId)) throw new Error('Check is already active');
    activeCheckRunners.set(runId, { locationId, auditId, runner });
    try {
      const result = await runner.run(locationId, runId);
      return {
        id: result.id,
        state: result.state,
        version: result.version,
        verified: result.verified,
      };
    } finally {
      activeCheckRunners.delete(runId);
    }
  },
  cancelRunningCheck: async (locationId: string, auditId: string, runId: string) => {
    await requireLocalLocation(locationId);
    const active = activeCheckRunners.get(runId);
    if (!active || active.locationId !== locationId || active.auditId !== auditId) return false;
    return active.runner.cancel(locationId, runId);
  },
  requestAuditApproval: async (locationId: string): Promise<boolean> => {
    if (typeof locationId !== 'string' || !locationId.trim() || locationId.length > 256) {
      throw new Error('Invalid location ID');
    }
    return approvals.request(locationId);
  },
  listAudits: async (locationId: string) => {
    await requireLocalLocation(locationId);
    return listAudits(locationId);
  },
  listAuditEvidence: async (locationId: string, auditId: string, offset: number) => {
    await requireLocalLocation(locationId);
    return listAuditEvidence(locationId, auditId, offset, 50);
  },
  compareAuditEvidence: async (locationId: string, previousId: string, currentId: string) => {
    await requireLocalLocation(locationId);
    return compareAuditEvidence(locationId, previousId, currentId);
  },
  getAuditReport: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    // A report may be the first request after restart. Normalize orphaned
    // process-local `watching` state before exposing its persisted freshness.
    await getAuditMonitorStatus(locationId, auditId);
    return getAuditReport(locationId, auditId);
  },
  getAuditInvalidation: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    return getAuditInvalidation(locationId, auditId);
  },
  getAuditMonitorStatus: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    if (!(await getAudit(locationId, auditId))) throw new Error('Project audit not found');
    return getAuditMonitorStatus(locationId, auditId);
  },
  startAuditMonitor: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    const audit = await getAudit(locationId, auditId);
    if (!audit) throw new Error('Project audit not found');
    if (!audit.identity) throw new Error('This audit has no filesystem identity; run a new audit.');

    const key = auditMonitorKey(locationId, auditId);
    const existing = activeAuditMonitor.get(key);
    if (existing && !existing.snapshot.closed && existing.snapshot.state === 'watching') {
      return getAuditMonitorStatus(locationId, auditId);
    }

    for (const [activeKey, monitor] of activeAuditMonitor) {
      if (activeKey === key) continue;
      await activeBrainRefresh.get(activeKey)?.close();
      activeBrainRefresh.delete(activeKey);
      activeAuditMonitor.delete(activeKey);
      await monitor.stop();
    }
    if (existing) {
      await activeBrainRefresh.get(key)?.close();
      activeBrainRefresh.delete(key);
      activeAuditMonitor.delete(key);
      await existing.stop();
    }

    // The service presents a distinct native dialog for continuing local monitoring,
    // and yields a single-use grant bound to the selected root's filesystem identity.
    if (!(await approvals.request(locationId, 'audit-monitor'))) {
      return getAuditMonitorStatus(locationId, auditId);
    }
    const approvedProject = await approvals.consumeProject(locationId);
    if (
      !approvedProject ||
      approvedProject.root !== audit.root ||
      approvedProject.identity !== audit.identity
    ) {
      throw new Error('Project changed since the audit; run a new audit before monitoring.');
    }

    const refresh = new BrainRefreshQueue({
      record: async (change) => {
        await recordBrainChange(locationId, change);
        const marker = monitor.snapshot.lastInvalidation;
        if (
          change.state === 'refreshed' &&
          change.auditId &&
          marker?.state === 'watching' &&
          marker.sequence === change.sequence &&
          !monitor.snapshot.closed
        )
          setWatchedBrainRevision(locationId, `audit:${change.auditId}`);
      },
      refresh: async (active) => {
        const current = await resolveSelectedLocalProject(locationId, getLocationById);
        if (
          !active() ||
          current.root !== approvedProject.root ||
          (await approvedRootIdentity(current.root)) !== approvedProject.identity
        )
          throw new Error('Monitoring project identity changed.');
        if (auditRunning)
          throw new Error('Another audit is running; refresh waits for another change.');
        auditRunning = true;
        try {
          const updated = await runLocalAudit(locationId, {
            native: loadTraceMindNative(),
            gitStatusExecutable: join(
              app.isPackaged ? process.resourcesPath : app.getAppPath(),
              'dist-tracemind-native',
              'tracemind_git_cwd'
            ),
            consume: async (id) => (active() && id === locationId ? approvedProject : null),
            save: async (...args) => {
              if (!active()) throw new Error('Monitoring stopped.');
              return saveAudit(...args);
            },
            recordGraphFailure: (record, coverage) =>
              recordGraphIndexFailure(locationId, record.id, coverage),
            recordGraphCoverage: (record, coverage) =>
              recordGraphCoverage(locationId, record.id, coverage),
            indexGraph: async (record, files) => {
              if (!active()) throw new Error('Monitoring stopped.');
              return indexAuditGraph(record, files);
            },
          });
          if (!(await getGraphOverview(locationId, `audit:${updated.id}`, null)))
            throw new Error('Refreshed graph was not persisted.');
          return updated.id;
        } finally {
          auditRunning = false;
        }
      },
    });
    const monitor = createTraceMindLiveMonitor(
      {
        locationId,
        auditId,
        root: approvedProject.root,
        identity: approvedProject.identity,
      },
      {
        currentIdentity: approvedRootIdentity,
        verifySnapshot: () => auditSnapshotMatchesCurrent(audit, loadTraceMindNative()),
        persist: async (id, auditId, input) => {
          const marker = await recordAuditInvalidation(id, auditId, input);
          if (input.changedCount > 0 || input.state !== 'watching') {
            await recordBrainChange(id, {
              sequence: marker.sequence,
              at: input.eventAt,
              paths: input.changedPaths.slice(0, 200),
              truncated: input.pathsTruncated,
              state:
                input.state === 'watching'
                  ? 'pending'
                  : input.state === 'stopped'
                    ? 'stopped'
                    : 'error',
              auditId,
            });
          }
          return marker;
        },
      }
    );
    monitor.onUpdate((snapshot) => {
      setWatchedBrainRevision(
        locationId,
        snapshot.state === 'watching' && snapshot.lastInvalidation?.stale === false
          ? `audit:${auditId}`
          : null
      );
      if (snapshot.lastInvalidation) refresh.observe(snapshot.lastInvalidation);
    });
    try {
      await monitor.start();
    } catch (error) {
      await refresh.close();
      throw error;
    }
    activeBrainRefresh.set(key, refresh);
    activeAuditMonitor.set(key, monitor);
    return getAuditMonitorStatus(locationId, auditId);
  },
  stopAuditMonitor: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    if (!(await getAudit(locationId, auditId))) throw new Error('Project audit not found');
    const key = auditMonitorKey(locationId, auditId);
    const monitor = activeAuditMonitor.get(key);
    if (monitor) {
      await activeBrainRefresh.get(key)?.close();
      activeBrainRefresh.delete(key);
      activeAuditMonitor.delete(key);
      await monitor.stop();
    }
    return getAuditMonitorStatus(locationId, auditId);
  },
  getRuntimeSignals: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    if (!(await getAudit(locationId, auditId))) throw new Error('Project audit not found');
    return getRuntimeSignals(locationId, auditId);
  },
  getRuntimeAISettings: async (
    locationId: string,
    auditId: string
  ): Promise<TraceMindRuntimeAISettings> => {
    await requireLocalLocation(locationId);
    if (!(await getAudit(locationId, auditId))) throw new Error('Project audit not found');
    const [storedEnabled, latestAdvisory, lastFailureAt] = await Promise.all([
      getRuntimeAIEnabled(locationId, auditId),
      getLatestRuntimeAIAdvisory(locationId, auditId),
      getRuntimeAILastFailureAt(locationId, auditId),
    ]);
    const enabled =
      storedEnabled && !runtimeAIOptOutOverrides.has(runtimeAIOptOutKey(locationId, auditId));
    return { enabled, auditId, latestAdvisory, lastFailureAt };
  },
  setRuntimeAIEnabled: async (
    locationId: string,
    auditId: string,
    enabled: boolean
  ): Promise<TraceMindRuntimeAISettings> => {
    await requireLocalLocation(locationId);
    if (!(await getAudit(locationId, auditId))) throw new Error('Project audit not found');
    if (enabled && !(await getAIProviderStatus()).configured) {
      throw new Error('Configure and save an AI provider before enabling runtime analysis.');
    }
    if (enabled) {
      const [currentSnapshot, latestAdvisory, lastFailureAt] = await Promise.all([
        getRuntimeSignals(locationId, auditId),
        getLatestRuntimeAIAdvisory(locationId, auditId),
        getRuntimeAILastFailureAt(locationId, auditId),
      ]);
      await setRuntimeAIEnabled(locationId, auditId, true);
      runtimeAIOptOutOverrides.delete(runtimeAIOptOutKey(locationId, auditId));
      runtimeAIQueue.enable(currentSnapshot);
      return { enabled: true, auditId, latestAdvisory, lastFailureAt };
    }

    const optOutKey = runtimeAIOptOutKey(locationId, auditId);
    runtimeAIOptOutOverrides.add(optOutKey);
    runtimeAIQueue.disable(locationId, auditId);
    await setRuntimeAIEnabled(locationId, auditId, false);
    runtimeAIOptOutOverrides.delete(optOutKey);
    try {
      const [latestAdvisory, lastFailureAt] = await Promise.all([
        getLatestRuntimeAIAdvisory(locationId, auditId),
        getRuntimeAILastFailureAt(locationId, auditId),
      ]);
      return { enabled: false, auditId, latestAdvisory, lastFailureAt };
    } catch {
      return {
        enabled: false,
        auditId,
        latestAdvisory: null,
        lastFailureAt: null,
        statusUnavailable: true,
      };
    }
  },
  getRuntimeReceiverStatus: async (locationId: string) => {
    await requireLocalLocation(locationId);
    const active = activeRuntimeReceivers.get(locationId);
    return active
      ? {
          active: active.receiver.active,
          endpoint: active.receiver.endpoint,
          startedAt: active.receiver.startedAt,
          auditId: active.auditId,
        }
      : { active: false, endpoint: null, startedAt: null, auditId: null };
  },
  startRuntimeReceiver: async (locationId: string, auditId: string) => {
    await requireLocalLocation(locationId);
    const audit = await getAudit(locationId, auditId);
    if (!audit) throw new Error('Project audit not found');
    const existing = activeRuntimeReceivers.get(locationId);
    if (existing) {
      if (existing.auditId === auditId && existing.receiver.active) {
        if (existing.receiver.endpoint) {
          return {
            active: true,
            endpoint: existing.receiver.endpoint,
            startedAt: existing.receiver.startedAt,
            auditId,
            token: existing.receiver.token,
          };
        }
      }
      activeRuntimeReceivers.delete(locationId);
      runtimeAIQueue.disable(locationId, existing.auditId);
      await existing.receiver.close();
    }
    const runtimeAIEnabled =
      !runtimeAIOptOutOverrides.has(runtimeAIOptOutKey(locationId, auditId)) &&
      (await getRuntimeAIEnabled(locationId, auditId));
    const currentSnapshot = await getRuntimeSignals(locationId, auditId);
    if (runtimeAIEnabled) runtimeAIQueue.enable(currentSnapshot);
    else runtimeAIQueue.disable(locationId, auditId);
    const receiver = await startRuntimeReceiver(async (signals, rejectedCount) => {
      const snapshot = await ingestRuntimeSignals(
        locationId,
        auditId,
        audit.fingerprint ?? audit.revision,
        signals,
        rejectedCount
      );
      if (
        !runtimeAIOptOutOverrides.has(runtimeAIOptOutKey(locationId, auditId)) &&
        (await getRuntimeAIEnabled(locationId, auditId))
      )
        runtimeAIQueue.observe(snapshot);
      return snapshot;
    });
    activeRuntimeReceivers.set(locationId, { auditId, receiver });
    return {
      active: receiver.active,
      endpoint: receiver.endpoint,
      startedAt: receiver.startedAt,
      auditId,
      token: receiver.token,
    };
  },
  stopRuntimeReceiver: async (locationId: string) => {
    await requireLocalLocation(locationId);
    const active = activeRuntimeReceivers.get(locationId);
    if (active) {
      activeRuntimeReceivers.delete(locationId);
      await active.receiver.close();
      runtimeAIQueue.disable(locationId, active.auditId);
    }
    return { active: false, endpoint: null, startedAt: null, auditId: null };
  },
  importJaegerTelemetry: async (locationId: string, auditId: string, json: string) => {
    await requireLocalLocation(locationId);
    const audit = await getAudit(locationId, auditId);
    if (!audit) throw new Error('Project audit not found');
    const parsed = parseRuntimeJson('jaeger', json);
    const snapshot = await ingestRuntimeSignals(
      locationId,
      auditId,
      audit.fingerprint ?? audit.revision,
      parsed.signals,
      parsed.rejectedCount
    );
    if (await getRuntimeAIEnabled(locationId, auditId)) runtimeAIQueue.observe(snapshot);
    return { snapshot, importedCount: parsed.signals.length, rejectedCount: parsed.rejectedCount };
  },
  runAudit: async (locationId: string) => {
    await requireLocalLocation(locationId);
    if (auditRunning) throw new Error('An audit is already running');
    auditRunning = true;
    try {
      const native = loadTraceMindNative();
      return await runLocalAudit(locationId, {
        native,
        gitStatusExecutable: join(
          app.isPackaged ? process.resourcesPath : app.getAppPath(),
          'dist-tracemind-native',
          'tracemind_git_cwd'
        ),
        consume: (id) => approvals.consumeProject(id),
        save: saveAudit,
        recordGraphFailure: (audit, coverage) =>
          recordGraphIndexFailure(audit.locationId, audit.id, coverage),
        recordGraphCoverage: (audit, coverage) =>
          recordGraphCoverage(audit.locationId, audit.id, coverage),
        indexGraph: async (audit, files) => {
          return await indexAuditGraph(audit, files);
        },
      });
    } finally {
      auditRunning = false;
    }
  },
  getGraphOverview: async (locationId: string, revision: string, afterId: string | null) => {
    await requireLocalLocation(locationId);
    return getGraphOverview(locationId, revision, afterId);
  },
  getGraphParserFailurePage: async (
    locationId: string,
    revision: string,
    afterCursor: string | null
  ) => {
    await requireLocalLocation(locationId);
    return getGraphParserFailurePage(locationId, revision, afterCursor);
  },
  getGraphRelationshipPage: async (
    locationId: string,
    revision: string,
    afterId: string | null
  ) => {
    await requireLocalLocation(locationId);
    return getGraphRelationshipPage(locationId, revision, afterId);
  },
  searchGraphFiles: async (
    locationId: string,
    revision: string,
    query: string,
    afterCursor: string | null
  ) => {
    await requireLocalLocation(locationId);
    return searchGraphFiles(locationId, revision, query, afterCursor);
  },
  getGraphFileNodesPage: async (
    locationId: string,
    revision: string,
    path: string,
    afterCursor: string | null
  ) => {
    await requireLocalLocation(locationId);
    return getGraphFileNodesPage(locationId, revision, path, afterCursor);
  },
  revealGraphFileInFinder: async (locationId: string, revision: string, path: string) => {
    await requireLocalLocation(locationId);
    if (process.platform !== 'darwin') throw new Error('Finder reveal requires macOS');
    const filePath = graphPathSchema.parse(path);
    if (!(await getGraphFileNodesPage(locationId, revision, filePath, null))) {
      throw new Error('Graph file not found in this revision');
    }
    const project = await resolveSelectedLocalProject(locationId, getLocationById);
    const candidate = resolve(project.root, filePath);
    const canonical = await realpath(candidate);
    const relativePath = relative(project.root, canonical);
    if (
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error('Graph file is outside the local project');
    }
    if (!(await stat(canonical)).isFile()) throw new Error('Graph source is not a file');
    shell.showItemInFolder(canonical);
  },
  inspectGraph: async (
    locationId: string,
    revision: string,
    startNodeId: string,
    limits: {
      direction?: 'outgoing' | 'both';
      maxDepth: number;
      maxResults: number;
      maxEdges: number;
      maxTimeMs: number;
      maxMemoryBytes?: number;
    }
  ) => {
    await requireLocalLocation(locationId);
    return inspectGraph(locationId, revision, startNodeId, limits);
  },
  benchmarkGraphAdapter: async (locationId: string, revision: string) => {
    await requireLocalLocation(locationId);
    return benchmarkGraphAdapter(locationId, revision);
  },
  recordGraphEntry: async (locationId: string, revision: string, input: GraphRecordInput) => {
    await requireLocalLocation(locationId);
    await appendGraphRecordBounded(locationId, revision, input);
  },
  getCheckCapability: async (locationId: string, runId?: string) => {
    await requireLocalLocation(locationId);
    const runtime = checkRuntime();
    const proposal = runId ? await getRunProposal(locationId, runId) : null;
    const selectedExecutable = proposal?.proposal.executable;
    const runtimeAvailable = runId
      ? Boolean(selectedExecutable && runtime?.toolExecutables[selectedExecutable])
      : runtime !== null;
    if (process.platform === 'darwin') {
      const macos = getMacosCheckCapability(detectSandboxMode());
      const canRunDiscoveredChecks = macos.canRunDiscoveredChecks && runtimeAvailable;
      return {
        ...macos,
        status: canRunDiscoveredChecks ? macos.status : 'unavailable',
        canRunDiscoveredChecks,
        reason: !macos.sandboxAvailable
          ? macos.reason
          : !runtimeAvailable
            ? runId && selectedExecutable
              ? `No trusted ${selectedExecutable} executable is available; approval is withheld.`
              : 'The check runtime is unavailable on this host.'
            : macos.reason,
      };
    }
    const linuxControlsAvailable =
      process.platform !== 'linux' ||
      !runId ||
      !runtimeAvailable ||
      !proposal ||
      (await preflightLinuxCgroupLimits(proposal.proposal.limits));
    const canRunDiscoveredChecks = runtimeAvailable && linuxControlsAvailable;
    return {
      platform: process.platform,
      status: canRunDiscoveredChecks ? 'runtime-available' : 'unavailable',
      canRunDiscoveredChecks,
      reason: runId
        ? selectedExecutable
          ? !runtimeAvailable
            ? `No trusted ${selectedExecutable} executable is available; approval is withheld.`
            : !linuxControlsAvailable
              ? 'Delegated Linux cgroup v2 memory and process-count controls are unavailable; approval is withheld.'
              : `The trusted ${selectedExecutable} executable is available; approval and run checks remain separately required.`
          : 'The saved check proposal is unavailable; approval is withheld.'
        : runtimeAvailable
          ? 'The host runtime is available; approval and run checks remain separately required.'
          : 'The check runtime is unavailable on this host.',
      missingControls:
        !canRunDiscoveredChecks && runtimeAvailable && process.platform === 'linux'
          ? ['memoryBytes', 'processCount']
          : [],
    };
  },
  listIssues: async (locationId: string) => {
    await requireLocalLocation(locationId);
    return listIssues(locationId);
  },
  createIssue: async (locationId: string, input: IssueInput) => {
    await requireLocalLocation(locationId);
    return createIssue(locationId, input);
  },
  updateIssue: async (locationId: string, id: string, version: number, input: IssueInput) => {
    await requireLocalLocation(locationId);
    return updateIssue(locationId, id, version, input);
  },
  updateIssueMetadata: async (
    locationId: string,
    id: string,
    version: number,
    input: { priority: IssuePriority; owner: string | null }
  ) => {
    await requireLocalLocation(locationId);
    return updateIssueMetadata(locationId, id, version, input);
  },
  transitionIssue: async (
    locationId: string,
    id: string,
    version: number,
    status: IssueStatus,
    rationale: string
  ) => {
    await requireLocalLocation(locationId);
    return transitionIssue(locationId, id, version, status, rationale);
  },
  transitionIssueInvestigation: async (
    locationId: string,
    id: string,
    version: number,
    input: {
      nextState: IssueInvestigationState;
      rationale: string;
      outcome?: IssueInvestigationOutcome;
      checkRunId?: string;
    }
  ) => {
    await requireLocalLocation(locationId);
    return persistIssueInvestigation(locationId, id, version, input);
  },
  listIssueEvents: async (locationId: string, id: string) => {
    await requireLocalLocation(locationId);
    if (!(await getIssue(locationId, id))) throw new Error('Issue not found');
    return listIssueEvents(locationId, id);
  },
  getBrainSettings: async (locationId: string) => {
    await requireLocalLocation(locationId);
    return { policy: await getBrainPolicy(locationId), changes: await getBrainChanges(locationId) };
  },
  configureBrainProject: async (
    locationId: string,
    input: { enabled: boolean; bridgeEnabled: boolean; shareNotes: boolean; allowedPaths: string[] }
  ) => {
    await requireLocalLocation(locationId);
    const project = await resolveSelectedLocalProject(locationId, getLocationById);
    const identity = await approvedRootIdentity(project.root);
    const provider = await getAIProviderStatus();
    if (input.enabled && !provider.configured)
      throw new Error('Configure the TraceMind brain provider first.');
    const policy = brainPolicySchema.parse({
      ...input,
      root: project.root,
      identity,
      endpoint: provider.endpoint,
      model: provider.model,
    });
    if (policy.enabled || policy.bridgeEnabled) {
      const window = getMainWindow();
      if (!window) throw new Error('Open the desktop window to approve project sharing.');
      const decision = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Enable this project brain?',
        message: 'Approve project-scoped TraceMind context and model sharing?',
        detail: `${project.root}\nProvider: ${provider.endpoint} / ${provider.model}\nModel sharing: ${policy.enabled}; Switch agent bridge: ${policy.bridgeEnabled}; share notes: ${policy.shareNotes}\nExact allowed paths:\n${policy.allowedPaths.join('\n')}\n\nTask text and approved metadata may leave this device. Source contents and credentials stay local. Local agents receive approved paths and redacted notes.`,
        buttons: ['Cancel', 'Approve project'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (decision.response !== 1) return getBrainPolicy(locationId);
      const current = await resolveSelectedLocalProject(locationId, getLocationById);
      if (current.root !== project.root || (await approvedRootIdentity(current.root)) !== identity)
        throw new Error('Project changed during approval.');
    }
    return saveBrainPolicy(locationId, policy);
  },
  getBrainContext: async (locationId: string, task: string) => {
    await requireLocalLocation(locationId);
    const policy = await getBoundBrainPolicy(locationId);
    return getLocalBrainContext(locationId, task, policy?.allowedPaths ?? []);
  },
  getAIProviderStatus: async () => getAIProviderStatus(),
  configureAIProvider: async (input: TraceMindAIProviderInput) => configureAIProvider(input),
  clearAIProvider: async () => {
    runtimeAIQueue.closeAll();
    await clearAllRuntimeAIEnabled();
    runtimeAIOptOutOverrides.clear();
    return clearAIProvider();
  },
  testAIProviderConnection: async () => testAIProviderConnection(),
  /** Explicit, user-triggered AI call; saved output remains advisory and never resolves an issue. */
  generateAIInvestigation: async (
    locationId: string,
    id: string
  ): Promise<TraceMindAIInvestigation> => {
    await requireLocalLocation(locationId);
    const issue = await getIssue(locationId, id);
    if (!issue) throw new Error('Issue not found');
    const selectedProject = await resolveSelectedLocalProject(locationId, getLocationById);
    const evidence = await retrieveAIInvestigationEvidence(locationId, issue, selectedProject.root);
    const { model, response } = await generateTraceMindAIResponse(evidence);
    const [latestIssue, latestGraph] = await Promise.all([
      getIssue(locationId, id),
      getLatestGraphSnapshot(locationId),
    ]);
    if (!latestIssue || latestIssue.version !== issue.version) {
      throw new Error('Issue changed during AI investigation; generate a fresh snapshot.');
    }
    if ((latestGraph?.revision ?? null) !== evidence.currentRevision) {
      throw new Error(
        'Graph revision changed during AI investigation; refresh evidence and retry.'
      );
    }
    // A source file can change without a new graph revision while the provider is
    // generating. Re-read the bounded bundle before persisting so a snapshot never
    // calls evidence fresh solely because it was fresh at request time.
    const completionEvidence = await retrieveAIInvestigationEvidence(
      locationId,
      latestIssue,
      selectedProject.root
    );
    const completionGraph = await getLatestGraphSnapshot(locationId);
    if ((completionGraph?.revision ?? null) !== evidence.currentRevision) {
      throw new Error(
        'Graph revision changed during AI investigation; refresh evidence and retry.'
      );
    }
    const now = Date.now();
    const citedEvidenceIds = new Set([
      ...response.summaryEvidenceIds,
      ...response.hypotheses.flatMap((hypothesis) => hypothesis.evidenceIds),
      ...response.recommendations.flatMap((recommendation) => recommendation.evidenceIds),
    ]);
    const completionEvidenceById = new Map(
      completionEvidence.evidence.map((item) => [item.id, item])
    );
    const citedEvidence = evidence.evidence.filter((item) => citedEvidenceIds.has(item.id));
    const evidenceReferences = citedEvidence
      .map((item) => {
        if (item.freshness !== 'fresh') return item;
        const latest = completionEvidenceById.get(item.id);
        if (latest?.freshness === 'fresh') return item;
        return {
          ...item,
          freshness: latest?.freshness ?? 'unknown',
        };
      })
      .filter((item) => citedEvidenceIds.has(item.id))
      .map(({ excerpt: _excerpt, ...reference }) => structuredClone(reference));
    const freshness = evidenceReferences.some((item) => item.freshness === 'stale')
      ? 'stale'
      : evidenceReferences.some((item) => item.freshness === 'unknown')
        ? 'unknown'
        : 'fresh';
    const investigation: TraceMindAIInvestigation = {
      ...response,
      schemaVersion: 1,
      id: randomUUID(),
      provider: 'openai-compatible',
      model,
      generatedAt: now,
      evidenceRevision: evidence.currentRevision,
      evidenceReferences,
      freshness,
      limitations: [
        ...new Set([
          ...evidence.limitations,
          ...response.limitations,
          ...(evidenceReferences.some((item) => item.freshness !== 'fresh')
            ? ['One or more cited evidence items were stale or unverifiable at completion recheck.']
            : []),
          'AI-generated content is advisory, can be incorrect, and does not prove runtime behavior or resolve the issue.',
        ]),
      ],
    };
    await recordAIInvestigation(
      locationId,
      id,
      issue.version,
      issue.currentRevision,
      investigation
    );
    return investigation;
  },
  recordIssueEvent: async (
    locationId: string,
    id: string,
    version: number,
    input: IssueEventInput
  ) => {
    await requireLocalLocation(locationId);
    if (input.revision && !(await ensureGraphRevision(locationId, input.revision)))
      throw new Error('Graph revision not found in this project');
    return appendIssueEvent(locationId, id, version, input);
  },
  recordIssueCheckResult: async (
    locationId: string,
    id: string,
    version: number,
    auditId: string,
    runId: string,
    note: string,
    criterionId?: string
  ) => {
    await requireLocalLocation(locationId);
    const [issue, run] = await Promise.all([
      getIssue(locationId, id),
      getRunProposal(locationId, runId),
    ]);
    if (!issue || !run || !issue.auditId || issue.auditId !== auditId || run.auditId !== auditId)
      throw new Error('Check result must reference a run from the issue-linked project audit');
    if ((run.state !== 'finished' && run.state !== 'refused') || !run.result)
      throw new Error('Check result can only be linked after the runner has a terminal result');
    const audit = await getAudit(locationId, auditId);
    if (!audit) throw new Error('Project audit not found');
    const revision =
      audit.revision && (await ensureGraphRevision(locationId, audit.revision))
        ? audit.revision
        : null;
    return appendIssueCheckResult(locationId, id, version, {
      auditId: run.auditId,
      note,
      revision,
      criterionId,
      outcome: {
        runId: run.id,
        state: run.state,
        status: run.result.status,
        verified: run.verified,
        exitCode: run.result.exitCode,
        signal: run.result.signal,
        effectiveLimits: {
          processCount: run.result.effectiveLimits.processCount,
          memory: run.result.effectiveLimits.memory,
        },
      },
    });
  },
  recordIssueGraphEntry: async (
    locationId: string,
    revision: string,
    issueId: string,
    expectedVersion: number,
    input: GraphRecordInput
  ) => {
    await requireLocalLocation(locationId);
    return appendGraphRecordBounded(locationId, revision, input, {
      issueId,
      expectedVersion,
    });
  },
  markIssueEvidenceStale: async (
    locationId: string,
    id: string,
    version: number,
    rationale: string
  ) => {
    await requireLocalLocation(locationId);
    return markIssueEvidenceStale(locationId, id, version, rationale);
  },
  reviewIssueEvidence: async (
    locationId: string,
    id: string,
    version: number,
    revision: string,
    rationale: string
  ) => {
    await requireLocalLocation(locationId);
    const latest = await getLatestGraphSnapshot(locationId);
    if (!latest || latest.revision !== revision)
      throw new Error('Evidence review must reference the latest graph revision');
    return reviewIssueEvidence(locationId, id, version, revision, rationale);
  },
  generateInvestigationReport: async (locationId: string, id: string) => {
    await requireLocalLocation(locationId);
    const report = await generateInvestigationReport(locationId, id);
    if (!report) return null;
    const issue = await getIssue(locationId, id);
    const auditId = issue?.auditId ?? null;
    const invalidation = auditId
      ? (await getAuditMonitorStatus(locationId, auditId)).invalidation
      : null;
    const auditFreshness = !auditId
      ? {
          auditId: null,
          state: 'not-linked' as const,
          stale: null,
          changedCount: 0,
          changedPaths: [],
          pathsTruncated: false,
        }
      : invalidation
        ? {
            auditId,
            state: invalidation.state,
            stale: invalidation.stale,
            changedCount: invalidation.changedCount,
            changedPaths: invalidation.changedPaths,
            pathsTruncated: invalidation.pathsTruncated,
          }
        : {
            auditId,
            state: 'unmonitored' as const,
            stale: null,
            changedCount: 0,
            changedPaths: [],
            pathsTruncated: false,
          };
    const freshnessReason = !auditId
      ? 'No audit is linked to this issue; audit freshness cannot be assessed.'
      : !invalidation
        ? 'Live monitoring was not enabled for the linked audit; current filesystem freshness is unknown.'
        : invalidation.stale
          ? `Post-snapshot monitor state is ${invalidation.state}; the linked audit snapshot is stale and needs a new audit.`
          : `Post-snapshot monitor state is ${invalidation.state}; no change has been recorded so far, which is not proof of complete filesystem freshness.`;
    return {
      ...report,
      auditFreshness,
      coverage: { ...report.coverage, reasons: [...report.coverage.reasons, freshnessReason] },
      uncertainty: [...report.uncertainty, freshnessReason],
      markdown: `${report.markdown}\n## Linked audit freshness\n\n- State: ${auditFreshness.state}\n- Stale: ${auditFreshness.stale === null ? 'unknown' : auditFreshness.stale}\n- Changed path events: ${auditFreshness.changedCount}${auditFreshness.pathsTruncated ? ' (path list truncated)' : ''}\n- ${freshnessReason}${auditFreshness.changedPaths.length ? `\n${auditFreshness.changedPaths.map((path) => `  - ${JSON.stringify(path)}`).join('\n')}` : ''}\n`,
    };
  },
});
