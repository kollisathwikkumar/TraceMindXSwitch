import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  locations: vi.fn(),
  list: vi.fn(),
  listIssueEvents: vi.fn(),
  updateIssueMetadata: vi.fn(),
  transitionIssue: vi.fn(),
  transitionIssueInvestigation: vi.fn(),
  recordIssueEvent: vi.fn(),
  recordIssueCheckResult: vi.fn(),
  recordIssueGraphEntry: vi.fn(),
  markIssueEvidenceStale: vi.fn(),
  generateInvestigationReport: vi.fn(),
  getCheckCapability: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listAudits: vi.fn(),
  approve: vi.fn(),
  runAudit: vi.fn(),
  pickProject: vi.fn(),
  evidence: vi.fn(),
  compareEvidence: vi.fn(),
  report: vi.fn(),
  graphs: vi.fn(),
  graph: vi.fn(),
  overview: vi.fn(),
  graphParserFailures: vi.fn(),
  graphRelationships: vi.fn(),
  searchGraphFiles: vi.fn(),
  getGraphFileNodesPage: vi.fn(),
  revealGraphFileInFinder: vi.fn(),
  inspectGraph: vi.fn(),
  benchmarkGraph: vi.fn(),
  recordGraph: vi.fn(),
  discoverChecks: vi.fn(),
  saveCheck: vi.fn(),
  listChecks: vi.fn(),
  cancelCheck: vi.fn(),
  getCheckResult: vi.fn(),
  reviewCheck: vi.fn(),
  runCheck: vi.fn(),
  stopCheck: vi.fn(),
  auditMonitorStatus: vi.fn(),
  startAuditMonitor: vi.fn(),
  stopAuditMonitor: vi.fn(),
  getAIProviderStatus: vi.fn(),
  getBrainSettings: vi.fn(),
  configureBrainProject: vi.fn(),
  getBrainContext: vi.fn(),
  configureAIProvider: vi.fn(),
  clearAIProvider: vi.fn(),
  testAIProviderConnection: vi.fn(),
  generateAIInvestigation: vi.fn(),
  getRuntimeAISettings: vi.fn(),
  setRuntimeAIEnabled: vi.fn(),
  runtimeSignals: vi.fn(),
  runtimeReceiverStatus: vi.fn(),
  startRuntimeReceiver: vi.fn(),
  stopRuntimeReceiver: vi.fn(),
  importJaegerTelemetry: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    locations: { getLocations: mocks.locations },
    tracemind: {
      listIssues: mocks.list,
      listIssueEvents: mocks.listIssueEvents,
      createIssue: mocks.create,
      updateIssue: mocks.update,
      updateIssueMetadata: mocks.updateIssueMetadata,
      transitionIssue: mocks.transitionIssue,
      transitionIssueInvestigation: mocks.transitionIssueInvestigation,
      recordIssueEvent: mocks.recordIssueEvent,
      recordIssueCheckResult: mocks.recordIssueCheckResult,
      recordIssueGraphEntry: mocks.recordIssueGraphEntry,
      markIssueEvidenceStale: mocks.markIssueEvidenceStale,
      generateInvestigationReport: mocks.generateInvestigationReport,
      getCheckCapability: mocks.getCheckCapability,
      listAudits: mocks.listAudits,
      requestAuditApproval: mocks.approve,
      runAudit: mocks.runAudit,
      pickLocalProject: mocks.pickProject,
      listAuditEvidence: mocks.evidence,
      compareAuditEvidence: mocks.compareEvidence,
      getAuditReport: mocks.report,
      getAuditMonitorStatus: mocks.auditMonitorStatus,
      startAuditMonitor: mocks.startAuditMonitor,
      stopAuditMonitor: mocks.stopAuditMonitor,
      getAIProviderStatus: mocks.getAIProviderStatus,
      getBrainSettings: mocks.getBrainSettings,
      configureBrainProject: mocks.configureBrainProject,
      getBrainContext: mocks.getBrainContext,
      configureAIProvider: mocks.configureAIProvider,
      clearAIProvider: mocks.clearAIProvider,
      testAIProviderConnection: mocks.testAIProviderConnection,
      generateAIInvestigation: mocks.generateAIInvestigation,
      getRuntimeAISettings: mocks.getRuntimeAISettings,
      setRuntimeAIEnabled: mocks.setRuntimeAIEnabled,
      getRuntimeSignals: mocks.runtimeSignals,
      getRuntimeReceiverStatus: mocks.runtimeReceiverStatus,
      startRuntimeReceiver: mocks.startRuntimeReceiver,
      stopRuntimeReceiver: mocks.stopRuntimeReceiver,
      importJaegerTelemetry: mocks.importJaegerTelemetry,
      listGraphSnapshots: mocks.graphs,
      getGraphSnapshot: mocks.graph,
      getGraphOverview: mocks.overview,
      getGraphParserFailurePage: mocks.graphParserFailures,
      getGraphRelationshipPage: mocks.graphRelationships,
      searchGraphFiles: mocks.searchGraphFiles,
      getGraphFileNodesPage: mocks.getGraphFileNodesPage,
      revealGraphFileInFinder: mocks.revealGraphFileInFinder,
      inspectGraph: mocks.inspectGraph,
      benchmarkGraphAdapter: mocks.benchmarkGraph,
      recordGraphEntry: mocks.recordGraph,
      discoverAuditChecks: mocks.discoverChecks,
      saveDiscoveredCheck: mocks.saveCheck,
      listCheckProposals: mocks.listChecks,
      cancelCheckProposal: mocks.cancelCheck,
      getCheckResultPreview: mocks.getCheckResult,
      requestCheckApproval: mocks.reviewCheck,
      runApprovedCheck: mocks.runCheck,
      cancelRunningCheck: mocks.stopCheck,
    },
  },
}));
vi.mock('@renderer/lib/components/titlebar/Titlebar', () => ({
  Titlebar: () => null,
}));
const bootstrap = new JSDOM('<!doctype html>');
vi.stubGlobal('window', bootstrap.window);
vi.stubGlobal('document', bootstrap.window.document);
const { createRoot } = await import('react-dom/client');
const { AUDIT_ANALYZER_VERSION } = await import('@main/core/tracemind/audit/audit-version');
const { TraceMindMainPanel, tracemindView, layoutGraphCanvasLabels } =
  await import('./tracemind-view');
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.resetAllMocks();
  dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.window.document.querySelector('#root') as HTMLDivElement;
  root = createRoot(container);
  mocks.locations.mockResolvedValue([
    { id: 'local', name: 'Local project', dir: '/repo', sshHost: null },
    { id: 'remote', name: 'Remote project', dir: '/remote', sshHost: 'host' },
  ]);
  mocks.getBrainSettings.mockResolvedValue({ policy: null, changes: [] });
  mocks.configureBrainProject.mockResolvedValue({ enabled: true });
  mocks.getBrainContext.mockResolvedValue({ files: [{ path: 'src/app.ts', notes: [] }] });
  mocks.getAIProviderStatus.mockResolvedValue({
    configured: false,
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  });
  mocks.configureAIProvider.mockResolvedValue({
    configured: true,
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  });
  mocks.clearAIProvider.mockResolvedValue({
    configured: false,
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  });
  mocks.testAIProviderConnection.mockResolvedValue({
    connected: true,
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  });
  mocks.getRuntimeAISettings.mockResolvedValue({
    enabled: false,
    auditId: '',
    latestAdvisory: null,
    lastFailureAt: null,
  });
  mocks.setRuntimeAIEnabled.mockResolvedValue({
    enabled: false,
    auditId: '',
    latestAdvisory: null,
    lastFailureAt: null,
  });
  mocks.list.mockResolvedValue([]);
  mocks.listIssueEvents.mockResolvedValue([]);
  mocks.generateInvestigationReport.mockResolvedValue({
    events: [],
    markdown: '# Investigation report',
  });
  mocks.getCheckCapability.mockResolvedValue({
    platform: 'linux',
    status: 'runtime-available',
    canRunDiscoveredChecks: true,
    reason: 'Runtime available.',
    missingControls: [],
  });
  mocks.listAudits.mockResolvedValue([]);
  mocks.listChecks.mockResolvedValue({ items: [], nextCursor: null });
  mocks.evidence.mockResolvedValue({ items: [], nextOffset: null });
  mocks.compareEvidence.mockResolvedValue({ status: 'unavailable' });
  mocks.report.mockResolvedValue('TraceMind local audit report\nFixture evidence');
  mocks.auditMonitorStatus.mockResolvedValue({ active: false, state: 'idle', invalidation: null });
  mocks.startAuditMonitor.mockResolvedValue({
    active: true,
    state: 'watching',
    invalidation: null,
  });
  mocks.stopAuditMonitor.mockResolvedValue({ active: false, state: 'stopped', invalidation: null });
  mocks.runtimeSignals.mockResolvedValue({
    locationId: 'local',
    auditId: '',
    auditRevision: null,
    signals: [],
    incidents: [],
    acceptedCount: 0,
    droppedCount: 0,
    lastReceivedAt: null,
    truncated: false,
  });
  mocks.runtimeReceiverStatus.mockResolvedValue({
    active: false,
    endpoint: null,
    startedAt: null,
    auditId: null,
  });
  mocks.startRuntimeReceiver.mockResolvedValue({
    active: true,
    endpoint: 'http://127.0.0.1:43123',
    startedAt: 1,
    auditId: 'current-audit',
    token: 'temporary-token',
  });
  mocks.stopRuntimeReceiver.mockResolvedValue({
    active: false,
    endpoint: null,
    startedAt: null,
    auditId: null,
  });
  mocks.importJaegerTelemetry.mockResolvedValue({
    snapshot: {
      locationId: 'local',
      auditId: 'current-audit',
      auditRevision: null,
      signals: [],
      incidents: [],
      acceptedCount: 0,
      droppedCount: 0,
      lastReceivedAt: null,
      truncated: false,
    },
    importedCount: 1,
    rejectedCount: 0,
  });
  mocks.graphs.mockResolvedValue([]);
  mocks.graph.mockResolvedValue(null);
  mocks.overview.mockResolvedValue(null);
  mocks.graphParserFailures.mockResolvedValue({
    revision: 'empty',
    pageSize: 50,
    failures: [],
    nextCursor: null,
  });
  mocks.graphRelationships.mockResolvedValue({
    revision: 'empty',
    relationships: [],
    nextCursor: null,
  });
  mocks.searchGraphFiles.mockResolvedValue({ revision: 'empty', files: [], nextCursor: null });
  mocks.getGraphFileNodesPage.mockResolvedValue(null);
  mocks.revealGraphFileInFinder.mockResolvedValue(undefined);
  mocks.inspectGraph.mockResolvedValue({
    nodes: [],
    relationships: [],
    truncated: false,
    stopReason: null,
  });
  await act(async () => {
    root.render(React.createElement(TraceMindMainPanel));
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-tracemind-section="investigations"]')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
});

async function selectTraceMindSection(id: string): Promise<void> {
  await act(async () => {
    const tab = container.querySelector<HTMLButtonElement>(`[data-tracemind-section="${id}"]`);
    if (!tab) throw new Error(`Missing TraceMind section ${id}`);
    tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
}

it('exposes all thirteen ordered TraceMind sections before a local project is selected', async () => {
  await act(async () => {
    await Promise.resolve();
  });
  const expectedSections = [
    'TraceMind brain',
    'Project intelligence',
    'Evidence collection',
    'Evidence graph',
    'Issues',
    'Investigations',
    'Check discovery & execution',
    'Local architecture',
    'Investigation process',
    'Continuous monitoring',
    'Runtime intelligence',
    'Switch integration',
    'Graphical notes',
  ];
  const nav = container.querySelector('[aria-label="TraceMind sections"]');
  expect(nav).not.toBeNull();
  for (const title of expectedSections) {
    expect(
      [...(nav?.querySelectorAll('button') ?? [])].some(
        (button) => button.querySelector('[data-section-title]')?.textContent === title
      ),
      `missing visible section ${title}`
    ).toBe(true);
  }
  expect(tracemindView.worksWithoutServer).toBe(true);
  expect(tracemindView.TitlebarSlot).toBeDefined();
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.listAudits).not.toHaveBeenCalled();
});

it('keeps the same full TraceMind page shell and section cards across every section', async () => {
  await act(async () => {
    await Promise.resolve();
  });
  const sections = [
    'project',
    'evidence',
    'graph',
    'investigations',
    'checks',
    'runtime',
    'local-first',
  ];
  const main = container.querySelector('main');
  const nav = container.querySelector<HTMLElement>('[aria-label="TraceMind sections"]');
  if (!main || !nav) throw new Error('Missing TraceMind page shell');
  const mainClass = main.className;
  const contentClass = main.firstElementChild?.className;
  const navClass = nav.className;

  for (const id of sections) {
    await selectTraceMindSection(id);
    expect(main.className, `${id} page spacing should match other sections`).toBe(mainClass);
    expect(main.firstElementChild?.className, `${id} content width should match`).toBe(
      contentClass
    );
    expect(nav.className, `${id} section card layout should match`).toBe(navClass);
    expect(main.querySelector('h2')?.textContent).toBe('TraceMind');
    expect(main.textContent).toContain('Record and investigate issues in a local project.');

    const addProject = [...main.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Add local project'
    );
    expect(addProject, `${id} should keep the Add local project action visible`).toBeDefined();
    expect(addProject?.closest('.hidden')).toBeNull();

    for (const section of sections) {
      const card = nav.querySelector<HTMLButtonElement>(`[data-tracemind-section="${section}"]`);
      expect(card, `missing ${section} section card`).not.toBeNull();
      expect(card?.querySelector('[data-section-title]')?.textContent).toBeTruthy();
      expect(card?.querySelectorAll('span').length).toBe(2);
      expect(card?.className).toContain('tm-nav-item');
    }
    expect(
      nav.querySelector(`[data-tracemind-section="${id}"]`)?.getAttribute('aria-current')
    ).toBe('page');
  }
});

it('configures the provider without retaining the key and explicitly renders a cited AI investigation', async () => {
  const issue = {
    id: '70000000-0000-4000-8000-000000000101',
    locationId: 'local',
    title: 'AI workflow issue',
    description: 'A fixture issue for the investigation UI.',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    status: 'open' as const,
    priority: 'medium' as const,
    owner: null,
    currentRevision: null,
    staleEvidence: false,
    resolutionRationale: null,
    resolvedAt: null,
    investigationState: 'reported' as const,
    auditId: null,
  };
  const generated = {
    schemaVersion: 1 as const,
    id: '70000000-0000-4000-8000-000000000102',
    provider: 'openai-compatible' as const,
    model: 'gpt-4o-mini',
    generatedAt: 1000,
    evidenceRevision: 'rev-1',
    freshness: 'fresh' as const,
    summary: 'The issue may be caused by a stale configuration value.',
    summaryEvidenceIds: ['evidence-1'],
    hypotheses: [
      {
        rank: 1,
        statement: 'A stale configuration value is the likely cause.',
        confidence: 'medium' as const,
        rationale: 'The saved source excerpt references the old value.',
        evidenceIds: ['evidence-1'],
      },
    ],
    recommendations: [
      {
        rank: 1,
        action: 'Compare the current setting against the captured revision.',
        rationale: 'This directly checks the leading hypothesis.',
        evidenceIds: ['evidence-1'],
      },
    ],
    limitations: ['Only one source excerpt was available.'],
    evidenceReferences: [
      {
        id: 'evidence-1',
        kind: 'source_excerpt' as const,
        label: 'Configuration loader excerpt',
        path: 'src/config.ts',
        startLine: 12,
        endLine: 15,
        revision: 'rev-1',
        freshness: 'fresh' as const,
        certainty: 'direct' as const,
        provenance: 'source file',
        extractionMethod: 'bounded source excerpt',
      },
    ],
  };
  const aiEvent = {
    id: generated.id,
    projectId: 'local',
    issueId: issue.id,
    issueVersion: 2,
    type: 'ai_investigation',
    body: 'AI-generated advisory snapshot; this does not resolve the issue.',
    evidenceKind: 'inference',
    auditId: null,
    revision: 'rev-1',
    graphNodeId: null,
    checkRunId: null,
    createdAt: 1000,
    aiInvestigation: generated,
  };
  mocks.list.mockResolvedValue([issue]);
  mocks.generateAIInvestigation.mockResolvedValue(generated);
  mocks.listIssueEvents.mockResolvedValue([aiEvent]);
  mocks.generateInvestigationReport.mockResolvedValue({ events: [], markdown: 'Report' });

  await act(async () => {
    await Promise.resolve();
  });
  const projectSelect = container.querySelector('select');
  await act(async () => {
    if (!projectSelect) throw new Error('Missing project selector');
    projectSelect.value = 'local';
    projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  const issueButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === issue.title
  );
  await act(async () =>
    issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  await act(async () => {
    await Promise.resolve();
  });

  expect(mocks.generateAIInvestigation).not.toHaveBeenCalled();
  expect(
    container.querySelector('input[aria-label="AI provider API key"]')?.getAttribute('type')
  ).toBe('password');
  const apiKey = container.querySelector<HTMLInputElement>(
    'input[aria-label="AI provider API key"]'
  );
  await act(async () => {
    if (!apiKey) throw new Error('Missing API key input');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      apiKey,
      'secret-fixture-key'
    );
    apiKey.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const save = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save AI provider'
  );
  mocks.configureAIProvider.mockRejectedValueOnce(
    new Error('Secure secret storage is unavailable on this system.')
  );
  await act(async () => {
    save?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(container.textContent).toContain('Unlock the operating-system Keychain/secure storage');
  expect(apiKey?.value).toBe('secret-fixture-key');
  expect(container.textContent).not.toContain('secret-fixture-key');

  await act(async () => save?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(mocks.configureAIProvider).toHaveBeenCalledWith({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'secret-fixture-key',
  });
  expect(apiKey?.value).toBe('');
  expect(container.textContent).not.toContain('secret-fixture-key');

  const testProvider = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Test saved provider'
  );
  expect(testProvider?.disabled).toBe(false);
  await act(async () => {
    testProvider?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(mocks.testAIProviderConnection).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Connection verified');
  expect(container.textContent).not.toContain('secret-fixture-key');

  const generate = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Generate AI investigation'
  );
  expect(generate).toBeDefined();
  await act(async () =>
    generate?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.generateAIInvestigation).toHaveBeenCalledWith('local', issue.id);
  expect(container.textContent).toContain('AI-generated investigation · advisory');
  expect(container.textContent).toContain(
    'The issue may be caused by a stale configuration value.'
  );
  expect(container.textContent).toContain('A stale configuration value is the likely cause.');
  expect(container.textContent).toContain(
    'Compare the current setting against the captured revision.'
  );
  expect(container.textContent).toContain('src/config.ts:12–15 · fresh · direct');
  expect(container.textContent).toContain('Only one source excerpt was available.');
  expect(container.textContent).toContain('not proof of runtime behavior');

  const clear = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Clear saved key'
  );
  await act(async () =>
    clear?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.clearAIProvider).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('No provider key saved');
  expect(container.querySelector('[aria-label="Generated AI investigation"]')).toBeNull();
});

it('shows generation progress and a recoverable error for a failed model request', async () => {
  const issue = {
    id: '70000000-0000-4000-8000-000000000111',
    locationId: 'local',
    title: 'AI error fixture',
    description: 'Request failure UI fixture.',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    status: 'open' as const,
    priority: 'medium' as const,
    owner: null,
    currentRevision: null,
    staleEvidence: false,
    resolutionRationale: null,
    resolvedAt: null,
    investigationState: 'reported' as const,
    auditId: null,
  };
  mocks.list.mockResolvedValue([issue]);
  let rejectGeneration: (reason: unknown) => void = () => {};
  mocks.generateAIInvestigation.mockReturnValue(
    new Promise((_, reject) => {
      rejectGeneration = reject;
    })
  );
  const projectSelect = container.querySelector('select');
  await act(async () => {
    if (!projectSelect) throw new Error('Missing project selector');
    projectSelect.value = 'local';
    projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  const issueButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === issue.title
  );
  await act(async () =>
    issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  const apiKey = container.querySelector<HTMLInputElement>(
    'input[aria-label="AI provider API key"]'
  );
  await act(async () => {
    if (!apiKey) throw new Error('Missing API key input');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      apiKey,
      'temporary-fixture-key'
    );
    apiKey.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const save = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save AI provider'
  );
  await act(async () => save?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const generate = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Generate AI investigation'
  );
  await act(async () =>
    generate?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(generate?.textContent).toBe('Investigating…');
  await act(async () => {
    rejectGeneration(new Error('fixture model transport error'));
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'AI investigation failed. Review the provider settings and try again.'
  );
  expect(container.textContent).not.toContain('fixture model transport error');
});

it('shows a project prerequisite in every project section while Local-first stays available', async () => {
  await act(async () => {
    await Promise.resolve();
  });
  const nav = container.querySelector('[aria-label="TraceMind sections"]');
  if (!nav) throw new Error('Missing TraceMind section navigation');
  const sections = [
    ['project', 'Select or add a local project'],
    ['evidence', 'Select or add a local project'],
    ['graph', 'Select or add a local project'],
    ['investigations', 'Select or add a local project'],
    ['checks', 'Select or add a local project'],
    ['local-first', 'A running Switch server is not required'],
  ] as const;
  for (const [id, expectedText] of sections) {
    const tab = nav.querySelector<HTMLButtonElement>(`[data-tracemind-section="${id}"]`);
    expect(tab, `missing section tab ${id}`).not.toBeNull();
    await act(async () => {
      tab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const panel = container.querySelector<HTMLElement>(`#tracemind-section-${id}`);
    expect(panel, `missing panel for ${id}`).not.toBeNull();
    expect(panel?.hidden, `${id} panel should be visible`).toBe(false);
    expect(panel?.textContent).toContain(expectedText);
    if (id === 'local-first')
      expect(panel?.textContent).toContain(
        'Approvals are one-use in-memory grants and are not saved across application restarts.'
      );
  }
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.listAudits).not.toHaveBeenCalled();
});

it('marks legacy audit metadata stale in project, evidence, graph, and check selectors', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: null,
    dirty: null,
    fingerprint: 'a'.repeat(64),
    capturedAt: 100,
    inventory: {
      filesDiscovered: 0,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'legacy-audit' },
    { ...base, id: 'current-audit', analysisVersion: AUDIT_ANALYZER_VERSION },
  ]);
  const projectSelect = container.querySelector('select');
  await act(async () => {
    if (!projectSelect) throw new Error('Missing project selector');
    projectSelect.value = 'local';
    projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });

  await selectTraceMindSection('project');
  const intelligence = container.querySelector('#tracemind-section-project');
  expect(intelligence?.textContent).toContain('Needs refresh — analyzer version not recorded');
  expect(intelligence?.textContent).toContain('A matching fingerprint does not update saved');
  expect(
    [...(intelligence?.querySelectorAll('button') ?? [])].some(
      (button) => button.textContent === 'Run audit to refresh'
    )
  ).toBe(true);

  await selectTraceMindSection('evidence');
  const evidenceSelect = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Audit to inspect"]'
  );
  expect(evidenceSelect?.options[0]?.textContent).toContain('analysis needs refresh');
  expect(evidenceSelect?.options[1]?.textContent).toContain(
    `analysis current v${AUDIT_ANALYZER_VERSION}`
  );
  expect(container.querySelector('#tracemind-section-evidence')?.textContent).toContain(
    'Selected audit analysis: Needs refresh'
  );

  await selectTraceMindSection('graph');
  expect(container.querySelector('#tracemind-section-graph')?.textContent).toContain(
    'Graph source analysis: Needs refresh'
  );

  await selectTraceMindSection('checks');
  const checkSelect = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Check audit"]'
  );
  expect(checkSelect?.options[0]?.textContent).toContain('analysis needs refresh');
  expect(checkSelect?.options[1]?.textContent).toContain(
    `analysis current v${AUDIT_ANALYZER_VERSION}`
  );
  expect(container.querySelector('#tracemind-section-checks')?.textContent).toContain(
    'Check discovery source analysis: Needs refresh'
  );
  const discovery = container.querySelector<HTMLButtonElement>('#tracemind-section-checks button');
  expect(discovery?.textContent).toBe('Refresh audit before discovery');
  expect(discovery?.disabled).toBe(true);
  await act(async () =>
    discovery?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.discoverChecks).not.toHaveBeenCalled();

  await act(async () => {
    if (!checkSelect) throw new Error('Missing check audit selector');
    checkSelect.value = 'current-audit';
    checkSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  expect(
    container.querySelector<HTMLButtonElement>('#tracemind-section-checks button')?.disabled
  ).toBe(false);
});

it('shows runtime monitoring, imports Jaeger evidence, and compares selected snapshots', async () => {
  const currentId = '00000000-0000-4000-8000-000000000111';
  const previousId = '00000000-0000-4000-8000-000000000112';
  const base = {
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: 'main-revision',
    dirty: false,
    fingerprint: 'a'.repeat(64),
    capturedAt: 200,
    inventory: {
      filesDiscovered: 0,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
    analysisVersion: AUDIT_ANALYZER_VERSION,
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: currentId },
    { ...base, id: previousId, capturedAt: 100 },
  ]);
  mocks.getRuntimeAISettings.mockResolvedValue({
    enabled: false,
    auditId: currentId,
    latestAdvisory: null,
    lastFailureAt: 1_730_000_000_000,
  });
  mocks.runtimeSignals.mockResolvedValue({
    locationId: 'local',
    auditId: currentId,
    auditRevision: 'a'.repeat(64),
    signals: [],
    incidents: [],
    acceptedCount: 0,
    droppedCount: 0,
    lastReceivedAt: null,
    truncated: false,
  });
  mocks.startRuntimeReceiver.mockResolvedValue({
    active: true,
    endpoint: 'http://127.0.0.1:43123',
    startedAt: 1,
    auditId: currentId,
    token: 'temporary-token',
  });
  mocks.importJaegerTelemetry.mockResolvedValue({
    snapshot: {
      locationId: 'local',
      auditId: currentId,
      auditRevision: 'a'.repeat(64),
      signals: [],
      incidents: [],
      acceptedCount: 1,
      droppedCount: 0,
      lastReceivedAt: 1,
      truncated: false,
    },
    importedCount: 1,
    rejectedCount: 0,
  });
  mocks.compareEvidence.mockResolvedValue({
    status: 'compared',
    counts: { added: 1, changed: 2, removed: 3 },
    items: [{ path: 'src/a.ts', change: 'changed' }],
    truncated: false,
  });

  const projectSelect = container.querySelector('select');
  await act(async () => {
    if (!projectSelect) throw new Error('Missing project selector');
    projectSelect.value = 'local';
    projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await selectTraceMindSection('runtime');
  const panel = container.querySelector('#tracemind-section-runtime');
  expect(panel?.textContent).toContain('OpenTelemetry receiver');
  expect(panel?.textContent).toContain('Model-assisted incident review');
  expect(panel?.textContent).toContain(
    'Raw logs, span messages, metric attributes, trace IDs, and source code are excluded.'
  );
  expect(panel?.textContent).toContain('127.0.0.1');
  expect(panel?.textContent).toContain('Jaeger trace JSON');
  expect(panel?.textContent).toContain('Project snapshot comparison');
  expect(panel?.textContent).toContain('Last automatic AI analysis failed');
  const modelOptIn = panel?.querySelector<HTMLInputElement>(
    'input[aria-label="Send new runtime incident summaries to the configured AI provider"]'
  );
  expect(modelOptIn?.checked).toBe(false);
  expect(modelOptIn?.disabled).toBe(true);

  const start = [...(panel?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes('Start local receiver')
  );
  await act(async () => {
    start?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(mocks.startRuntimeReceiver).toHaveBeenCalledWith('local', currentId);
  expect(panel?.textContent).toContain('temporary-token');

  const payload = panel?.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Jaeger JSON payload"]'
  );
  await act(async () => {
    if (!payload) throw new Error('Missing Jaeger payload input');
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    setter?.call(payload, '{"data":[]}');
    payload.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const importButton = [...(panel?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes('Import Jaeger JSON')
  );
  await act(async () => {
    importButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(mocks.importJaegerTelemetry).toHaveBeenCalledWith('local', currentId, '{"data":[]}');

  const compare = [...(panel?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes('Compare snapshots')
  );
  await act(async () => {
    compare?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(mocks.compareEvidence).toHaveBeenCalledWith('local', previousId, currentId);
  expect(panel?.textContent).toContain('1 added · 2 changed · 3 removed');
});

it('reports a successful runtime opt-out when saved advisory status is unavailable', async () => {
  const auditId = '00000000-0000-4000-8000-000000000131';
  const audit = {
    id: auditId,
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: 'revision-1',
    dirty: false,
    fingerprint: 'b'.repeat(64),
    capturedAt: 200,
    inventory: {
      filesDiscovered: 0,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
    analysisVersion: AUDIT_ANALYZER_VERSION,
  };
  mocks.listAudits.mockResolvedValue([audit]);
  mocks.list.mockResolvedValue([
    {
      id: '70000000-0000-4000-8000-000000000131',
      locationId: 'local',
      title: 'Runtime opt-out fixture',
      description: 'UI fixture for an unavailable advisory status.',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      status: 'open',
      priority: 'medium',
      owner: null,
      currentRevision: null,
      staleEvidence: false,
      resolutionRationale: null,
      resolvedAt: null,
      investigationState: 'reported',
      auditId: null,
    },
  ]);
  mocks.getRuntimeAISettings.mockResolvedValue({
    enabled: true,
    auditId,
    latestAdvisory: null,
    lastFailureAt: null,
  });
  mocks.setRuntimeAIEnabled.mockResolvedValue({
    enabled: false,
    auditId,
    latestAdvisory: null,
    lastFailureAt: null,
    statusUnavailable: true,
  });

  const projectSelect = container.querySelector('select');
  await act(async () => {
    if (!projectSelect) throw new Error('Missing project selector');
    projectSelect.value = 'local';
    projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const issueButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Runtime opt-out fixture'
  );
  await act(async () =>
    issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  const apiKey = container.querySelector<HTMLInputElement>(
    'input[aria-label="AI provider API key"]'
  );
  const saveProvider = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save AI provider'
  );
  await act(async () => {
    if (!apiKey || !saveProvider) throw new Error('Missing AI provider configuration controls');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      apiKey,
      'fixture-provider-key'
    );
    apiKey.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    saveProvider?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  expect(mocks.configureAIProvider).toHaveBeenCalledWith({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'fixture-provider-key',
  });
  await selectTraceMindSection('runtime');

  const panel = container.querySelector('#tracemind-section-runtime');
  const modelOptIn = panel?.querySelector<HTMLInputElement>(
    'input[aria-label="Send new runtime incident summaries to the configured AI provider"]'
  );
  expect(modelOptIn?.checked).toBe(true);
  expect(modelOptIn?.disabled).toBe(false);
  await act(async () => {
    if (!modelOptIn) throw new Error('Missing runtime AI opt-in');
    modelOptIn.click();
    await Promise.resolve();
  });

  expect(mocks.setRuntimeAIEnabled).toHaveBeenCalledWith('local', auditId, false);
  expect(panel?.textContent).toContain(
    'Runtime incident analysis disabled and queued requests canceled. Saved advisory status could not be loaded; refresh to retry.'
  );
});

it('offers cancellation for a running check loaded after the view is reopened', async () => {
  mocks.listAudits.mockResolvedValue([
    {
      id: 'audit-1',
      locationId: 'local',
      root: '/repo',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-1',
        state: 'running',
        verified: false,
        version: 2,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'unavailable',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: null,
      },
    ],
    nextCursor: null,
  });
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await selectTraceMindSection('checks');
  const stop = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Cancel running check')
  );
  expect(stop).toBeDefined();
  mocks.stopCheck.mockResolvedValue(true);
  await act(async () => stop?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(mocks.stopCheck).toHaveBeenCalledWith('local', 'audit-1', 'run-1');
  expect(container.textContent).toContain('Cancellation requested');
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-1',
        state: 'finished',
        verified: false,
        version: 3,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'unavailable',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: 'cancelled',
      },
    ],
    nextCursor: null,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3200));
  });
  expect(container.textContent).toContain('finished · cancelled');
  expect(container.textContent).toContain('View result');
});

it('shows a bounded check result without treating it as verified', async () => {
  mocks.listAudits.mockResolvedValue([
    {
      id: 'audit-1',
      locationId: 'local',
      root: '/repo',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-1',
        state: 'finished',
        verified: false,
        version: 3,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'unavailable',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: 'exited',
      },
    ],
    nextCursor: null,
  });
  const result = {
    outputReferences: [
      { projectId: 'local', auditId: 'audit-1', runId: 'run-1', stream: 'stdout' },
      { projectId: 'local', auditId: 'audit-1', runId: 'run-1', stream: 'stderr' },
    ],
    status: 'exited',
    exitCode: 7,
    signal: null,
    stdout: 'fixture output',
    stderr: 'fixture error',
    stdoutHash: 'a'.repeat(64),
    stderrHash: 'b'.repeat(64),
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutPreviewTruncated: true,
    stderrPreviewTruncated: false,
    capturedComplete: true,
    terminationUnconfirmed: false,
    sandboxMode: 'unavailable',
    durationMs: 25,
    execution: {
      executable: '/fixture/npm',
      args: ['run', 'test'],
      cwd: '/repo',
      environmentKeys: ['PATH'],
      timeoutMs: 60000,
      outputBytes: 1000,
      spawned: true,
      workingDirectoryBinding: 'descriptor',
      targetHandoff: 'exec_handoff',
    },
    effectiveLimits: {
      timeout: 'termination-request',
      output: 'retained-bytes',
      concurrency: 'durable-single-flight',
      cpuTimeSeconds: false,
      processCount: false,
      memory: false,
    },
    executionMismatch: true,
    executionMatchConfirmed: false,
  };
  mocks.getCheckResult.mockResolvedValue(result);
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await selectTraceMindSection('checks');
  const show = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('View result')
  );
  expect(show).toBeDefined();
  await act(async () => show?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(mocks.getCheckResult).toHaveBeenCalledWith('local', 'audit-1', 'run-1');
  expect(container.textContent).toContain('fixture output');
  expect(container.textContent).toContain('/fixture/npm');
  expect(container.textContent).toContain('CPU-time limit: not enforced');
  expect(container.textContent).toContain('Target handoff: exec_handoff');
  expect(container.textContent).toContain(
    'The adapter-reported command or effective resource limits did not match the approved proposal.'
  );
  expect(container.textContent).toContain(
    'Requested caps: process/task limit 1 (Linux counts threads and sandbox helpers) · memory 536,870,912 bytes.'
  );
  expect(container.textContent).toContain('Memory limit: not enforced');
  expect(container.textContent).toContain(
    'Concurrency: one durable check at a time across the application database'
  );
  expect(container.textContent).toContain('Output references');
  expect(container.textContent).toContain('"stream":"stdout"');
  expect(container.textContent).toContain('"stream":"stderr"');
  expect(container.textContent).toContain('preview truncated');
  expect(container.textContent).toContain('not verified');

  mocks.getCheckResult.mockResolvedValueOnce({
    ...result,
    effectiveLimits: {
      ...result.effectiveLimits,
      processCount: 1,
      memory: 536_870_912,
    },
  });
  await act(async () => show?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(container.textContent).toContain('Memory limit: 536,870,912 bytes');
  expect(container.textContent).toContain('Process/task limit: 1 task');
  expect(container.textContent).not.toContain('neither cap is enforced by this runner');
});

it('renders a verified check state from its persisted summary', async () => {
  mocks.listAudits.mockResolvedValue([
    {
      id: 'audit-1',
      locationId: 'local',
      root: '/repo',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-verified',
        state: 'finished',
        verified: true,
        version: 3,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'macos-sandbox-exec',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: 'exited',
      },
    ],
    nextCursor: null,
  });
  mocks.getCheckResult.mockResolvedValue({
    outputReferences: [],
    status: 'exited',
    exitCode: 0,
    signal: null,
    stdout: 'passed',
    stderr: '',
    stdoutHash: 'a'.repeat(64),
    stderrHash: 'b'.repeat(64),
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutPreviewTruncated: false,
    stderrPreviewTruncated: false,
    capturedComplete: true,
    terminationUnconfirmed: false,
    sandboxMode: 'unavailable',
    durationMs: 10,
    execution: null,
    effectiveLimits: null,
    executionMismatch: false,
    executionMatchConfirmed: true,
  });
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await selectTraceMindSection('checks');
  expect(container.textContent).toContain('finished · exited · verified');
  const show = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('View result')
  );
  await act(async () => show?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(container.textContent).toContain('· verified');
  expect(container.textContent).toContain('Executed command matched the approved proposal');
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  dom.window.close();
});

describe('TraceMind issue workflow', () => {
  it('disables the editor until the selected project issues finish loading', async () => {
    let resolve: (items: never[]) => void = () => {};
    mocks.list.mockImplementationOnce(
      () =>
        new Promise<never[]>((done) => {
          resolve = done;
        })
    );
    const select = container.querySelector('select');
    await act(async () => {
      if (!select) throw new Error('Missing selector');
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    expect(
      container.querySelector<HTMLInputElement>('#tracemind-section-investigations input')?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '#tracemind-section-investigations button[type="submit"]'
      )?.disabled
    ).toBe(true);
    await act(async () => resolve([]));
    expect(
      container.querySelector<HTMLInputElement>('#tracemind-section-investigations input')?.disabled
    ).toBe(false);
  });
  it('offers local projects and loads issues on selection', async () => {
    const select = container.querySelector('select');
    expect(select?.textContent).toContain('Local project');
    expect(select?.textContent).not.toContain('Remote project');
    await act(async () => {
      if (select) {
        select.value = 'local';
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
    });
    expect(mocks.list).toHaveBeenCalledWith('local');
    expect(container.textContent).toContain('No issues');
  });

  it('shows issue lifecycle, append-only timeline, and the distinct investigation report', async () => {
    const issue = {
      id: '70000000-0000-4000-8000-000000000001',
      locationId: 'local',
      title: 'Lifecycle issue',
      description: 'Observed',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      status: 'open' as const,
      priority: 'medium' as const,
      owner: null,
      currentRevision: null,
      staleEvidence: false,
      resolutionRationale: null,
      resolvedAt: null,
      investigationState: 'reported' as const,
    };
    mocks.list.mockResolvedValue([issue]);
    const createdEvent = {
      id: '70000000-0000-4000-8000-000000000002',
      projectId: 'local',
      issueId: issue.id,
      issueVersion: 1,
      type: 'issue_created',
      body: 'Issue created',
      evidenceKind: 'record',
      auditId: null,
      revision: null,
      graphNodeId: null,
      checkRunId: null,
      createdAt: 1,
    };
    const unversionedEvidence = {
      id: '70000000-0000-4000-8000-000000000003',
      projectId: 'local',
      issueId: issue.id,
      issueVersion: 2,
      type: 'evidence',
      body: 'Evidence was recorded without a graph revision.',
      evidenceKind: 'record',
      auditId: null,
      revision: null,
      graphNodeId: null,
      checkRunId: null,
      createdAt: 2,
    };
    mocks.listIssueEvents.mockResolvedValue([createdEvent, unversionedEvidence]);
    mocks.generateInvestigationReport.mockResolvedValue({
      events: [{ ...unversionedEvidence, stale: false, revisionUnknown: true }],
      markdown: 'Revision-aware report · partial coverage',
    });
    const projectSelect = container.querySelector('select');
    await act(async () => {
      if (!projectSelect) throw new Error('Missing project selector');
      projectSelect.value = 'local';
      projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const issueButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Lifecycle issue'
    );
    await act(async () =>
      issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    expect(container.textContent).toContain('Investigation detail');
    expect(container.textContent).toContain('Append-only timeline');
    expect(container.textContent).toContain('Revision-aware investigation report');
    expect(container.textContent).toContain('partial coverage');
    expect(container.textContent).toContain('Issue created');
    expect(container.textContent).toContain('revision unknown');
    expect(container.textContent).toContain('Evidence was recorded without a graph revision.');
    expect(container.textContent).toContain('Current phase: reported');
    expect(container.querySelector('select[aria-label="Investigation next phase"]')).not.toBeNull();
  });

  it('identifies the exact linked audit in stale investigation-report freshness', async () => {
    const auditId = '70000000-0000-4000-8000-000000000071';
    const issue = {
      id: '70000000-0000-4000-8000-000000000070',
      locationId: 'local',
      title: 'Stale linked audit',
      description: 'The report must identify which snapshot is stale.',
      auditId,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      status: 'open' as const,
      priority: 'medium' as const,
      owner: null,
      currentRevision: 'revision-a',
      staleEvidence: true,
      resolutionRationale: null,
      resolvedAt: null,
      investigationState: 'reported' as const,
    };
    mocks.list.mockResolvedValue([issue]);
    mocks.generateInvestigationReport.mockResolvedValue({
      events: [],
      markdown:
        'Linked audit freshness\n- State: watching\n- Stale: true\n- Changed path: src/changed.ts',
      auditFreshness: {
        auditId,
        state: 'watching',
        stale: true,
        changedCount: 1,
        changedPaths: ['src/changed.ts'],
        pathsTruncated: false,
      },
    });

    const project = container.querySelector<HTMLSelectElement>('select');
    await act(async () => {
      if (!project) throw new Error('Missing project selector');
      project.value = 'local';
      project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const issueButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stale linked audit'
    );
    await act(async () =>
      issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );

    const report = container.querySelector('[aria-label="Investigation report"]');
    expect(report?.textContent).toContain(
      `Linked audit ${auditId}: watching · stale; run a new audit`
    );
    expect(report?.textContent).toContain('src/changed.ts');
  });

  it('persists legal investigation phase changes and refreshes the report', async () => {
    const issue = {
      id: '70000000-0000-4000-8000-000000000021',
      locationId: 'local',
      title: 'Phase transition issue',
      description: 'Observed',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      status: 'open' as const,
      priority: 'medium' as const,
      owner: null,
      currentRevision: null,
      staleEvidence: false,
      resolutionRationale: null,
      resolvedAt: null,
      investigationState: 'reported' as const,
    };
    const transitionEvent = {
      id: '70000000-0000-4000-8000-000000000022',
      projectId: 'local',
      issueId: issue.id,
      issueVersion: 2,
      type: 'investigation_transition',
      body: 'Investigation phase changed: reported → queued.',
      evidenceKind: 'record',
      auditId: null,
      revision: null,
      graphNodeId: null,
      checkRunId: null,
      createdAt: 2,
    };
    mocks.list.mockResolvedValue([issue]);
    mocks.transitionIssueInvestigation.mockResolvedValue({
      issue: { ...issue, version: 2, investigationState: 'queued' },
      event: transitionEvent,
    });
    mocks.generateInvestigationReport.mockResolvedValue({
      events: [transitionEvent],
      investigationState: 'queued',
      markdown: 'Investigation phase: queued',
    });

    const project = container.querySelector('select');
    await act(async () => {
      if (!project) throw new Error('Missing project selector');
      project.value = 'local';
      project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const issueButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Phase transition issue'
    );
    await act(async () =>
      issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );

    const rationale = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Transition or stale-evidence rationale'))
      ?.querySelector('input');
    const nextPhase = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Investigation next phase"]'
    );
    await act(async () => {
      if (!rationale || !nextPhase) throw new Error('Missing investigation phase controls');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
        rationale,
        'Queue the issue for local evidence gathering'
      );
      rationale.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      nextPhase.value = 'queued';
      nextPhase.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const advance = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Advance phase'
    );
    await act(async () =>
      advance?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    expect(mocks.transitionIssueInvestigation).toHaveBeenCalledWith('local', issue.id, 1, {
      nextState: 'queued',
      rationale: 'Queue the issue for local evidence gathering',
    });
    expect(container.textContent).toContain('Current phase: queued');
    expect(container.textContent).toContain('Investigation phase: queued');
    expect(mocks.generateInvestigationReport).toHaveBeenCalledWith('local', issue.id);
  });

  it('links a terminal run through the trusted check-result endpoint', async () => {
    const issue = {
      id: '70000000-0000-4000-8000-000000000011',
      locationId: 'local',
      title: 'Check-linked issue',
      description: 'Observed',
      auditId: '70000000-0000-4000-8000-000000000012',
      version: 3,
      createdAt: 1,
      updatedAt: 1,
      status: 'investigating' as const,
      priority: 'high' as const,
      owner: null,
      currentRevision: null,
      staleEvidence: false,
      resolutionRationale: null,
      resolvedAt: null,
    };
    const runId = '70000000-0000-4000-8000-000000000013';
    const criterionId = '70000000-0000-4000-8000-000000000014';
    const revision = 'a'.repeat(40);
    mocks.listAudits.mockResolvedValue([
      {
        id: issue.auditId,
        locationId: 'local',
        capturedAt: 1,
        revision,
        root: '/repo',
        dirty: false,
        fingerprint: 'b'.repeat(64),
        inventory: {
          filesDiscovered: 1,
          filesParsed: 1,
          skipped: 0,
          inventoryComplete: true,
          graphCoverage: { status: 'partial', omittedFiles: 0 },
          errors: [],
          languages: [],
          manifests: [],
          limitations: [],
        },
      },
    ]);
    mocks.listIssueEvents.mockResolvedValue([
      {
        id: criterionId,
        type: 'hypothesis',
        body: 'The parser preserves the audit revision.',
        auditId: issue.auditId,
        revision,
      },
    ]);
    mocks.list.mockResolvedValue([issue]);
    mocks.recordIssueCheckResult.mockResolvedValue({ issue: { ...issue, version: 4 }, event: {} });
    const project = container.querySelector('select');
    await act(async () => {
      if (!project) throw new Error('Missing project selector');
      project.value = 'local';
      project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const issueButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check-linked issue'
    );
    await act(async () =>
      issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    const criterion = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Check acceptance criterion"]'
    );
    await act(async () => {
      if (!criterion) throw new Error('Missing check criterion selector');
      criterion.value = criterionId;
      criterion.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const runInput = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Check run ID'))
      ?.querySelector('input');
    const note = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.trim() === 'Note')
      ?.querySelector('textarea');
    await act(async () => {
      if (!runInput || !note) throw new Error('Missing runner result fields');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
        runInput,
        runId
      );
      runInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
        note,
        'Investigated the nonzero outcome.'
      );
      note.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const link = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Link runner result'
    );
    await act(async () =>
      link?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    expect(mocks.recordIssueCheckResult).toHaveBeenCalledWith(
      'local',
      issue.id,
      issue.version,
      issue.auditId,
      runId,
      'Investigated the nonzero outcome.',
      criterionId
    );
  });

  it('does not offer a revisionless hypothesis as a verification criterion', async () => {
    const auditId = '70000000-0000-4000-8000-000000000041';
    const issue = {
      id: '70000000-0000-4000-8000-000000000042',
      locationId: 'local',
      title: 'Revisionless criterion',
      description: 'This criterion cannot be verified against a graph snapshot.',
      auditId,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      status: 'open' as const,
      priority: 'medium' as const,
      owner: null,
      currentRevision: null,
      staleEvidence: false,
      resolutionRationale: null,
      resolvedAt: null,
      investigationState: 'reported' as const,
    };
    const criterionId = '70000000-0000-4000-8000-000000000043';
    mocks.list.mockResolvedValue([issue]);
    mocks.listAudits.mockResolvedValue([
      {
        id: auditId,
        locationId: 'local',
        capturedAt: 1,
        revision: null,
        root: '/repo',
        dirty: null,
        fingerprint: null,
        inventory: {
          filesDiscovered: 0,
          filesParsed: 0,
          skipped: 0,
          inventoryComplete: true,
          errors: [],
          languages: [],
          manifests: [],
          limitations: [],
        },
      },
    ]);
    mocks.listIssueEvents.mockResolvedValue([
      {
        id: criterionId,
        type: 'hypothesis',
        body: 'The request returns success.',
        auditId,
        revision: null,
      },
    ]);

    const project = container.querySelector('select');
    await act(async () => {
      if (!project) throw new Error('Missing project selector');
      project.value = 'local';
      project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const issueButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Revisionless criterion'
    );
    await act(async () =>
      issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );

    const criterion = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Check acceptance criterion"]'
    );
    expect(criterion?.disabled).toBe(true);
    expect(criterion?.options).toHaveLength(1);
    expect(container.textContent).toContain('revisionless criteria cannot verify the issue.');
  });

  it('displays macOS missing resource controls and withholds approval action before review', async () => {
    mocks.listAudits.mockResolvedValue([
      {
        id: 'audit-mac',
        locationId: 'local',
        root: '/repo',
        revision: null,
        dirty: null,
        fingerprint: null,
        capturedAt: 1,
        inventory: {
          filesDiscovered: 0,
          filesParsed: 0,
          skipped: 0,
          inventoryComplete: true,
          errors: [],
          languages: [],
          manifests: [],
          limitations: [],
        },
      },
    ]);
    mocks.listChecks.mockResolvedValue({
      items: [
        {
          id: 'run-mac',
          state: 'proposed',
          verified: false,
          version: 1,
          executable: 'npm',
          workingDirectory: '.',
          sandboxMode: 'macos-sandbox-exec',
          processCount: 1,
          memoryBytes: 536_870_912,
          resultStatus: null,
        },
      ],
      nextCursor: null,
    });
    mocks.getCheckCapability.mockResolvedValue({
      platform: 'darwin',
      status: 'runtime-available-unverified',
      canRunDiscoveredChecks: true,
      reason: 'macOS checks run under Seatbelt and remain unverified.',
      missingControls: ['memoryBytes', 'processCount'],
    });
    const projectSelect = container.querySelector('select');
    await act(async () => {
      if (!projectSelect) throw new Error('Missing project selector');
      projectSelect.value = 'local';
      projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await selectTraceMindSection('checks');
    const review = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Review check')
    );
    expect(container.textContent).toContain(
      'Platform capability: darwin · runtime-available-unverified'
    );
    expect(container.textContent).toContain('memoryBytes, processCount');
    expect(container.textContent).toContain('Requested controls not enforced here');
    expect(review?.disabled).toBe(false);
    expect(mocks.reviewCheck).not.toHaveBeenCalled();
  });
});

it('creates and edits an issue using the selected local project', async () => {
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  const title = container.querySelector<HTMLInputElement>(
    '#tracemind-section-investigations input'
  );
  const description = container.querySelector('textarea');
  const setValue = (
    element: HTMLInputElement | HTMLTextAreaElement | null,
    value: string
  ): void => {
    if (!element) throw new Error('Missing editor');
    const prototype =
      element.tagName === 'INPUT'
        ? dom.window.HTMLInputElement.prototype
        : dom.window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('Missing value setter');
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  await act(async () => {
    setValue(title, 'Bug');
    setValue(description, 'Observed failure');
  });
  const created = {
    id: 'issue',
    locationId: 'local',
    title: 'Bug',
    description: 'Observed failure',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  mocks.create.mockResolvedValue(created);
  mocks.list.mockResolvedValue([created]);
  const form = container.querySelector('#tracemind-section-investigations form');
  await act(async () => {
    form?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(mocks.create).toHaveBeenCalledWith('local', {
    title: 'Bug',
    description: 'Observed failure',
  });
  expect(container.textContent).toContain('Edit issue');
  await act(async () => {
    setValue(title, 'Edited');
  });
  mocks.update.mockResolvedValue({ ...created, title: 'Edited', version: 2 });
  await act(async () => {
    form?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(mocks.update).toHaveBeenCalledWith('local', 'issue', 1, {
    title: 'Edited',
    description: 'Observed failure',
  });
});

it('lets a user review a newer issue version without discarding their draft', async () => {
  const original = {
    id: 'issue',
    locationId: 'local',
    title: 'Original',
    description: 'Old',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const latest = {
    ...original,
    title: 'Someone else edited',
    description: 'New details',
    version: 2,
    updatedAt: 2,
  };
  mocks.list.mockResolvedValueOnce([original]);
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const issueButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Original'
  );
  await act(async () =>
    issueButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  const title = container.querySelector<HTMLInputElement>(
    '#tracemind-section-investigations input'
  );
  await act(async () => {
    if (!title) throw new Error('Missing title');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      title,
      'My draft'
    );
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  mocks.update.mockRejectedValueOnce(new Error('Issue has changed'));
  const form = container.querySelector('#tracemind-section-investigations form');
  await act(async () =>
    form?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(title?.value).toBe('My draft');
  const refresh = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Refresh issue version')
  );
  expect(refresh).toBeDefined();
  mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([latest]);
  await act(async () =>
    refresh?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(title?.value).toBe('My draft');
  expect(container.textContent).toContain('Could not refresh the issue');
  await act(async () =>
    refresh?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(title?.value).toBe('My draft');
  expect(container.textContent).toContain('Someone else edited');
  expect(container.textContent).toContain('New details');
  expect(container.textContent).toContain('overwrites the latest version');
  mocks.update.mockResolvedValueOnce({
    ...latest,
    title: 'My draft',
    description: 'Old',
    version: 3,
  });
  await act(async () =>
    form?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(mocks.update).toHaveBeenLastCalledWith('local', 'issue', 2, {
    title: 'My draft',
    description: 'Old',
  });
});

it('retains a successfully created issue when refreshing the list fails', async () => {
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  const title = container.querySelector<HTMLInputElement>(
    '#tracemind-section-investigations input'
  );
  await act(async () => {
    if (!title) throw new Error('Missing title');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      title,
      'Bug'
    );
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  mocks.create.mockResolvedValue({
    id: 'issue',
    locationId: 'local',
    title: 'Bug',
    description: '',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  mocks.list.mockRejectedValue(new Error('offline'));
  await act(async () => {
    container
      .querySelector('#tracemind-section-investigations form')
      ?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(container.textContent).toContain('Edit issue');
  expect(container.textContent).toContain('Bug');
});

it('requests approval and shows persisted audit coverage', async () => {
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  await act(async () => {
    container
      .querySelector('[data-tracemind-section="evidence"]')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  mocks.approve.mockResolvedValue(true);
  mocks.runAudit.mockResolvedValue({
    id: 'audit-1',
    analysisVersion: AUDIT_ANALYZER_VERSION,
    locationId: 'local',
    root: '/repo',
    revision: null,
    dirty: null,
    fingerprint: 'a'.repeat(64),
    capturedAt: 100,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 0,
      skipped: 1,
      skippedEntries: [{ path: '.env', reason: 'excluded' }],
      skipDetailsTruncated: false,
      inventoryComplete: true,
      graphCoverage: { status: 'partial', omittedFiles: 1 },
      errors: [],
      languages: [{ language: 'TypeScript', files: 1 }],
      manifests: ['package.json'],
      limitations: ['No parsing'],
    },
  });
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Run audit')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.approve).toHaveBeenCalledWith('local');
  expect(mocks.runAudit).toHaveBeenCalledWith('local');
  expect(container.textContent).toContain('No parsing');
  expect(container.textContent).toContain('TypeScript');
  expect(container.textContent).toContain('1 file');
  expect(container.textContent).toContain('Inventory traversal complete');
  expect(container.textContent).toContain('Graph extraction: partial; 1 file omitted');
  expect(container.textContent).toContain('.env');
  expect(container.textContent).toContain('excluded');
  mocks.discoverChecks.mockResolvedValue({
    discoveryId: 'discovery-1',
    candidates: [
      {
        executable: 'npm',
        args: ['run', 'test'],
        workingDirectory: '.',
        sandboxMode: 'macos-sandbox-exec',
        declaredScripts: { test: 'echo test' },
      },
    ],
    limitations: ['Discovery only'],
  });
  await act(async () => {
    container
      .querySelector('[data-tracemind-section="checks"]')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  const discover = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Discover checks')
  );
  expect(discover).toBeDefined();
  await act(async () =>
    discover?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.discoverChecks).toHaveBeenCalledWith('local', 'audit-1');
  expect(container.textContent).toContain('echo test');
  expect(container.textContent).toContain('Effective sandbox mode: macos-sandbox-exec');
  expect(container.textContent).toContain('Discovery only');
  mocks.saveCheck.mockResolvedValue({ id: 'run-1', state: 'proposed', verified: false });
  mocks.listChecks.mockResolvedValue({
    items: [
      {
        id: 'run-1',
        state: 'proposed',
        verified: false,
        version: 1,
        executable: 'npm',
        workingDirectory: '.',
        sandboxMode: 'unavailable',
        processCount: 1,
        memoryBytes: 536_870_912,
        resultStatus: null,
      },
    ],
    nextCursor: null,
  });
  const saveCheck = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Save proposal')
  );
  expect(saveCheck).toBeDefined();
  await act(async () =>
    saveCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.saveCheck).toHaveBeenCalledWith('local', 'audit-1', 'discovery-1', 0);
  expect(container.textContent).toContain('run-1');
  expect(container.textContent).toContain('not executed');
  expect(container.textContent).toContain(
    'Requested caps: process/task limit 1 (Linux counts threads and sandbox helpers) · memory 536,870,912 bytes.'
  );
  expect(mocks.listChecks).toHaveBeenCalledWith('local', 'audit-1', null);
  const reviewCheck = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Review check')
  );
  expect(reviewCheck).toBeDefined();
  mocks.reviewCheck.mockResolvedValue('not-approved');
  await act(async () =>
    reviewCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.getCheckCapability).toHaveBeenCalledWith('local', 'run-1');
  expect(mocks.reviewCheck).toHaveBeenCalledWith('local', 'audit-1', 'run-1');
  expect(container.textContent).toContain('No check was run');
  mocks.reviewCheck.mockResolvedValue('unavailable');
  await act(async () =>
    reviewCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.textContent).toContain(
    'Verification runtime is unavailable on this host. No approval was created and no check was run.'
  );
  expect(mocks.runCheck).not.toHaveBeenCalled();
  mocks.reviewCheck.mockResolvedValue('approved');
  await act(async () =>
    reviewCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.runCheck).not.toHaveBeenCalled();
  const runCheck = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Run approved check')
  );
  expect(runCheck).toBeDefined();
  expect(container.textContent).toContain('later checks remain blocked');
  expect(container.textContent).toContain('Recovery requires a detected reboot');
  mocks.runCheck.mockRejectedValue(new Error('fixture failure'));
  await act(async () =>
    runCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.runCheck).toHaveBeenCalledWith('local', 'audit-1', 'run-1');
  expect(container.textContent).toContain('fixture failure');
  const cancelCheck = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Cancel proposal')
  );
  expect(cancelCheck).toBeDefined();
  mocks.cancelCheck.mockResolvedValue({ id: 'run-1', state: 'cancelled', version: 2 });
  await act(async () =>
    cancelCheck?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.cancelCheck).toHaveBeenCalledWith('local', 'audit-1', 'run-1', 1);
  expect(container.textContent).toContain('cancelled');
  const reportButton = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('View audit report')
  );
  expect(reportButton).toBeDefined();
  await act(async () =>
    reportButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.report).toHaveBeenCalledWith('local', 'audit-1');
  expect(container.textContent).toContain('Fixture evidence');
});

it('links an issue to a selected audit and opens the linked historical audit', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: null,
    dirty: null,
    fingerprint: 'a'.repeat(64),
    capturedAt: 100,
    inventory: {
      filesDiscovered: 0,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', capturedAt: 200 },
    { ...base, id: 'old' },
  ]);
  const project = container.querySelector('select');
  await act(async () => {
    if (!project) throw new Error('Missing project selector');
    project.value = 'local';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const auditSelect = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Related audit"]'
  );
  expect(auditSelect).toBeDefined();
  const title = container.querySelector<HTMLInputElement>(
    '#tracemind-section-investigations input'
  );
  await act(async () => {
    if (!auditSelect || !title) throw new Error('Missing fields');
    auditSelect.value = 'old';
    auditSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      title,
      'Linked issue'
    );
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  mocks.create.mockResolvedValue({
    id: 'issue',
    locationId: 'local',
    title: 'Linked issue',
    description: '',
    auditId: 'old',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  await act(async () =>
    container
      .querySelector('#tracemind-section-investigations form')
      ?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(mocks.create).toHaveBeenCalledWith('local', {
    title: 'Linked issue',
    description: '',
    auditId: 'old',
  });
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('View related audit')
  );
  expect(button).toBeDefined();
  await act(async () =>
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="Audit to inspect"]')?.value
  ).toBe('old');
});

it('does not run an audit after the user denies approval', async () => {
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  mocks.approve.mockResolvedValue(false);
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Run audit')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.runAudit).not.toHaveBeenCalled();
  expect(container.textContent).toContain('not approved');
});

it('registers a selected local folder and loads its issues', async () => {
  mocks.pickProject.mockResolvedValue({
    id: 'new-project',
    name: 'New project',
    dir: '/new',
    sshHost: null,
  });
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Add local project')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.pickProject).toHaveBeenCalledOnce();
  expect(mocks.list).toHaveBeenCalledWith('new-project');
  expect(container.querySelector('select')?.value).toBe('new-project');
});

it('starts an explicitly approved monitor, surfaces stale paths, and keeps it running when the project is deselected', async () => {
  const auditId = '70000000-0000-4000-8000-000000000051';
  mocks.listAudits.mockResolvedValue([
    {
      id: auditId,
      locationId: 'local',
      root: '/repo',
      identity: '1:42',
      revision: null,
      dirty: null,
      fingerprint: 'a'.repeat(64),
      capturedAt: 100,
      inventory: {
        filesDiscovered: 0,
        filesParsed: 0,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  const invalidation = {
    locationId: 'local',
    auditId,
    state: 'watching',
    stale: true,
    sequence: 2,
    eventAt: 200,
    changedCount: 1,
    changedPaths: ['src/changed.ts'],
    pathsTruncated: false,
  };
  mocks.startAuditMonitor.mockResolvedValue({
    active: true,
    state: 'watching',
    invalidation,
  });
  mocks.stopAuditMonitor.mockResolvedValue({
    active: false,
    state: 'stopped',
    invalidation: { ...invalidation, state: 'stopped' },
  });
  const project = container.querySelector('select');
  await act(async () => {
    if (!project) throw new Error('Missing local-project selector');
    project.value = 'local';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const auditTab = container.querySelector<HTMLButtonElement>(
    '[data-tracemind-section="evidence"]'
  );
  await act(async () =>
    auditTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  const start = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Start monitoring')
  );
  expect(start).toBeDefined();
  await act(async () =>
    start?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.startAuditMonitor).toHaveBeenCalledWith('local', auditId);
  expect(container.textContent).toContain('Monitoring started after approval.');
  expect(container.textContent).toContain('Stale — run a new audit');
  expect(container.textContent).toContain('src/changed.ts');

  await act(async () => {
    if (!project) throw new Error('Missing local-project selector');
    project.value = '';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  expect(mocks.stopAuditMonitor).not.toHaveBeenCalled();
});

it('shows when successive stored audit fingerprints differ without claiming live freshness', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    identity: '1:42',
    revision: 'a'.repeat(40),
    dirty: null,
    capturedAt: 100,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', fingerprint: 'b'.repeat(64) },
    { ...base, id: 'old', fingerprint: 'c'.repeat(64) },
  ]);
  mocks.compareEvidence.mockResolvedValue({
    status: 'compared',
    counts: { changed: 1, removed: 1, added: 0 },
    items: [
      { path: 'src/changed.ts', change: 'changed' },
      { path: 'src/gone.ts', change: 'removed' },
    ],
    truncated: false,
  });
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  expect(container.textContent).toContain(
    'Between the two captured audits: 1 changed, 1 removed, 0 added.'
  );
  expect(container.textContent).toContain('1 file inventoried · 0 parsed');
  expect(container.textContent).toContain('not a plain file-content SHA-256');
  expect(container.textContent).toContain(
    'Monitoring is optional and begins only after separate approval'
  );
  expect(mocks.compareEvidence).toHaveBeenCalledWith('local', 'old', 'new');
  expect(container.textContent).toContain('src/changed.ts');
  expect(container.textContent).toContain('src/gone.ts');
  expect(container.textContent).toContain('Earlier evidence is stale');
});

it('reports the persisted comparison as unavailable when a prior fingerprint is missing', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    revision: null,
    dirty: null,
    capturedAt: 100,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', fingerprint: 'b'.repeat(64) },
    { ...base, id: 'old', fingerprint: null },
  ]);
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  expect(container.textContent).toContain(
    'File comparison unavailable for incomplete or incompatible audits.'
  );
  expect(container.textContent).not.toContain('Snapshots differ');
});

it('uses the persisted comparison result when a root was replaced at the same path', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    revision: null,
    dirty: null,
    capturedAt: 100,
    inventory: {
      filesDiscovered: 0,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', identity: '1:43', fingerprint: 'b'.repeat(64) },
    { ...base, id: 'old', identity: '1:42', fingerprint: 'b'.repeat(64) },
  ]);
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  expect(mocks.compareEvidence).toHaveBeenCalledWith('local', 'old', 'new');
  expect(container.textContent).toContain(
    'File comparison unavailable for incomplete or incompatible audits.'
  );
});

it('does not hide an exact fingerprint match across filesystem identity changes', async () => {
  const base = {
    locationId: 'local',
    root: '/repo',
    revision: null,
    dirty: null,
    capturedAt: 100,
    inventory: {
      filesDiscovered: 0,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([
    { ...base, id: 'new', identity: '1:43', fingerprint: 'b'.repeat(64) },
    { ...base, id: 'old', identity: '1:42', fingerprint: 'b'.repeat(64) },
  ]);
  mocks.compareEvidence.mockResolvedValue({
    status: 'compared',
    counts: { changed: 0, removed: 0, added: 0 },
    items: [],
    truncated: false,
  });
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing local-project selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  expect(mocks.compareEvidence).toHaveBeenCalledWith('local', 'old', 'new');
  expect(container.textContent).toContain(
    'Between the two captured audits: 0 changed, 0 removed, 0 added.'
  );
  expect(container.textContent).not.toContain(
    'Comparison unavailable because the root identity or fingerprint is missing or different.'
  );
});

it('shows captured file evidence and loads additional pages', async () => {
  const base = {
    id: 'audit-1',
    locationId: 'local',
    root: '/repo',
    revision: 'a'.repeat(40),
    dirty: null,
    fingerprint: 'b'.repeat(64),
    capturedAt: 100,
    inventory: {
      filesDiscovered: 2,
      filesParsed: 0,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  mocks.listAudits.mockResolvedValue([base]);
  mocks.evidence
    .mockResolvedValueOnce({
      items: [{ path: 'src/a.ts', fingerprint: 'c'.repeat(64) }],
      nextOffset: 1,
    })
    .mockResolvedValueOnce({
      items: [{ path: 'src/b.ts', fingerprint: 'd'.repeat(64) }],
      nextOffset: null,
    });
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  expect(mocks.evidence).toHaveBeenCalledWith('local', 'audit-1', 0);
  expect(container.textContent).toContain('src/a.ts');
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Load more')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.evidence).toHaveBeenCalledWith('local', 'audit-1', 1);
  expect(container.textContent).toContain('src/b.ts');
});

it('inspects persisted graph relationships and parser limitations for an audit', async () => {
  const audit = {
    id: 'audit-graph',
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: 'a'.repeat(40),
    dirty: false,
    fingerprint: 'b'.repeat(64),
    capturedAt: 1,
    inventory: {
      filesDiscovered: 2,
      filesParsed: 1,
      graphCoverage: { status: 'partial', omittedFiles: 1 },
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  const snapshot = {
    projectId: 'local',
    revision: 'audit:audit-graph',
    capturedAt: 1,
    parserFailures: [
      { path: 'README.md', language: 'plain-text', message: 'No parser adapter is available.' },
    ],
    retrievalReasons: [
      {
        id: 'reason',
        projectId: 'local',
        revision: 'audit:audit-graph',
        evidenceNodeId: 'evidence',
        reason: 'Selected local audit file.',
        retrievedAt: 1,
      },
    ],
    nodes: [
      {
        id: 'root',
        projectId: 'local',
        revision: 'audit:audit-graph',
        kind: 'repository_revision',
        label: audit.revision,
        source: null,
        extractionMethod: 'audit',
        provenance: 'audit:audit-graph',
        stale: false,
        createdAt: 1,
      },
      {
        id: 'stale-evidence',
        projectId: 'local',
        revision: 'audit:audit-graph',
        kind: 'evidence',
        label: 'sha256:stale-content',
        source: { path: 'src/stale.ts', startLine: 4, endLine: 6 },
        extractionMethod: 'typescript-ast-v1',
        provenance: 'audit:audit-previous',
        stale: true,
        createdAt: 1,
      },
    ],
    relationships: [],
  };
  mocks.listAudits.mockResolvedValue([audit]);
  mocks.graph.mockResolvedValue(snapshot);
  mocks.overview.mockResolvedValue({
    revision: snapshot.revision,
    rootNodeId: 'root',
    nodeCount: 2,
    relationshipCount: 0,
    nodeCounts: {
      repository_revision: 1,
      file: 0,
      symbol: 1,
      dependency: 0,
      test: 0,
      observation: 0,
      command_run: 0,
      hypothesis: 0,
      evidence: 0,
      finding: 0,
    },
    relationshipCounts: {
      CONTAINS: 0,
      IMPORTS: 0,
      CALLS: 0,
      DEPENDS_ON: 0,
      TESTS: 0,
      SUPPORTS: 0,
      CONTRADICTS: 0,
      VERIFIED_BY: 0,
    },
    parserFailureCount: 51,
    nodes: snapshot.nodes,
    nextCursor: null,
    parserFailures: snapshot.parserFailures,
    retrievalReasons: snapshot.retrievalReasons,
  });
  mocks.graphParserFailures
    .mockResolvedValueOnce({
      revision: snapshot.revision,
      pageSize: 50,
      failures: Array.from({ length: 50 }, (_, ordinal) =>
        ordinal === 0
          ? {
              ordinal,
              path: 'README.md',
              language: 'plain-text',
              message: 'No parser adapter is available.',
            }
          : {
              ordinal,
              path: `src/omitted-${ordinal}.bin`,
              language: 'unsupported',
              message: `Parser limitation ${ordinal}`,
            }
      ),
      nextCursor: 'parser-page-two',
    })
    .mockResolvedValueOnce({
      revision: snapshot.revision,
      pageSize: 50,
      failures: [
        {
          ordinal: 50,
          path: 'src/unknown.bin',
          language: 'unknown',
          message: 'Parser failed unexpectedly.',
        },
      ],
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      revision: snapshot.revision,
      pageSize: 50,
      failures: Array.from({ length: 50 }, (_, ordinal) =>
        ordinal === 0
          ? {
              ordinal,
              path: 'README.md',
              language: 'plain-text',
              message: 'No parser adapter is available.',
            }
          : {
              ordinal,
              path: `src/omitted-${ordinal}.bin`,
              language: 'unsupported',
              message: `Parser limitation ${ordinal}`,
            }
      ),
      nextCursor: 'parser-page-two',
    });
  mocks.graphRelationships.mockResolvedValueOnce({
    revision: snapshot.revision,
    relationships: [
      {
        id: 'persisted-call',
        projectId: 'local',
        revision: snapshot.revision,
        sourceId: 'root',
        targetId: 'stale-evidence',
        relation: 'CALLS',
        certainty: 'heuristic',
        source: { path: 'src/stale.ts', startLine: 5, endLine: 5 },
        extractionMethod: 'typescript-ast-v1',
        provenance: 'audit:audit-graph',
        stale: true,
        createdAt: 1,
      },
    ],
    nextCursor: 'revision-page-two',
  });
  mocks.graphRelationships.mockResolvedValueOnce({
    revision: snapshot.revision,
    relationships: [],
    nextCursor: null,
  });
  mocks.inspectGraph.mockResolvedValue({
    nodes: snapshot.nodes,
    relationships: [
      {
        id: 'contains',
        projectId: 'local',
        revision: snapshot.revision,
        sourceId: 'root',
        targetId: 'root',
        relation: 'CONTAINS',
        source: null,
        extractionMethod: 'audit',
        provenance: 'audit:audit-graph',
        stale: false,
        createdAt: 1,
      },
      {
        id: 'contradicts',
        projectId: 'local',
        revision: snapshot.revision,
        sourceId: 'stale-evidence',
        targetId: 'root',
        relation: 'CONTRADICTS',
        source: null,
        extractionMethod: 'manual',
        provenance: 'investigation',
        stale: false,
        createdAt: 1,
      },
      {
        id: 'supports',
        projectId: 'local',
        revision: snapshot.revision,
        sourceId: 'stale-evidence',
        targetId: 'root',
        relation: 'SUPPORTS',
        source: null,
        extractionMethod: 'manual',
        provenance: 'investigation',
        stale: false,
        createdAt: 1,
      },
    ],
    truncated: false,
    stopReason: null,
  });
  mocks.benchmarkGraph
    .mockResolvedValueOnce({
      adapter: 'sqlite-normalized',
      nodes: 2,
      relationships: 0,
      readMs: 1.2,
      traversalMs: 2.3,
      traversalNodes: 12,
      traversalRelationships: 30,
      truncated: true,
      stopReason: 'time_limit',
    })
    .mockResolvedValueOnce({
      adapter: 'sqlite-normalized',
      nodes: 2,
      relationships: 0,
      readMs: 0.8,
      traversalMs: 1.1,
      traversalNodes: 2,
      traversalRelationships: 1,
      truncated: false,
      stopReason: null,
    });
  const select = container.querySelector('select');
  await act(async () => {
    if (select) {
      select.value = 'local';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });
  expect(container.textContent).toContain('Evidence graph');
  expect(container.textContent).toContain('2 files inventoried · 1 parsed');
  expect(container.querySelector('[aria-label="Audit graph coverage"]')?.textContent).toContain(
    'Graph coverage is partial'
  );
  expect(container.querySelector('[aria-label="Audit graph coverage"]')?.textContent).toContain(
    '1 of 2 inventoried files have parser-derived graph evidence · 1 omitted'
  );
  expect(container.querySelector('[aria-label="Audit graph coverage"]')?.textContent).toContain(
    'Some evidence may be missing'
  );
  expect(container.querySelector('[aria-label="Audit graph coverage"]')?.textContent).toContain(
    'must not be treated as up to date'
  );
  expect(container.textContent).toContain('Graph coverage is partial');
  expect(container.textContent).toContain('Some evidence may be missing');
  expect(container.querySelector('[aria-label="Evidence graph"]')?.textContent).toContain(
    '1 of 2 inventoried files have parser-derived graph evidence · 1 omitted'
  );
  expect(container.querySelector('[aria-label="Evidence graph"]')?.textContent).toContain(
    'must not be treated as up to date'
  );
  expect(container.textContent).toContain('No parser adapter is available');
  expect(container.querySelector('[aria-label="Parser limitations"]')?.textContent).toContain(
    'Entries 1–50 of 51 · page 1 of 2'
  );
  expect(mocks.graphParserFailures).toHaveBeenCalledWith('local', 'audit:audit-graph', null);
  const nextParserPage = container.querySelector<HTMLButtonElement>(
    '[aria-label="Next parser limitation page"]'
  );
  await act(async () =>
    nextParserPage?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.graphParserFailures).toHaveBeenCalledWith(
    'local',
    'audit:audit-graph',
    'parser-page-two'
  );
  expect(container.querySelector('[aria-label="Parser limitations"]')?.textContent).toContain(
    'src/unknown.bin'
  );
  const previousParserPage = container.querySelector<HTMLButtonElement>(
    '[aria-label="Previous parser limitation page"]'
  );
  await act(async () =>
    previousParserPage?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.querySelector('[aria-label="Parser limitations"]')?.textContent).toContain(
    'README.md'
  );
  expect(mocks.overview).toHaveBeenCalledWith('local', 'audit:audit-graph', null);
  expect(container.querySelector('[aria-label="Project relationship map"]')?.textContent).toContain(
    'CALLS · heuristic'
  );
  expect(container.querySelector('[aria-label="Project relationship map"]')?.textContent).toContain(
    'src/stale.ts:5'
  );
  const nextRelationshipPage = container.querySelector<HTMLButtonElement>(
    '[aria-label="Next relationship page"]'
  );
  await act(async () =>
    nextRelationshipPage?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.graphRelationships).toHaveBeenCalledWith(
    'local',
    'audit:audit-graph',
    'revision-page-two'
  );
  expect(mocks.graph).not.toHaveBeenCalled();
  const benchmark = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Benchmark local adapter'
  );
  await act(async () =>
    benchmark?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.textContent).toContain('bounded traversal stopped at time_limit');
  await act(async () =>
    benchmark?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.textContent).toContain('bounded traversal completed within limits');
  const inspect = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Inspect graph'
  );
  await act(async () =>
    inspect?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.inspectGraph).toHaveBeenCalledWith(
    'local',
    'audit:audit-graph',
    'root',
    expect.objectContaining({ direction: 'both' })
  );
  const start = container.querySelector<HTMLSelectElement>('[aria-label="Graph inspection start"]');
  await act(async () => {
    if (!start) throw new Error('Missing inspection start');
    start.value = 'stale-evidence';
    start.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await act(async () =>
    inspect?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(mocks.inspectGraph).toHaveBeenLastCalledWith(
    'local',
    'audit:audit-graph',
    'stale-evidence',
    expect.objectContaining({ direction: 'both' })
  );
  expect(container.textContent).toContain('CONTAINS');
  expect(container.textContent).toContain('SUPPORTS');
  expect(container.textContent).toContain('CONTRADICTS');
  expect(container.querySelector('[aria-label="TraceMind sections"]')).not.toBeNull();
  expect(container.querySelector('svg[aria-label="Inspected evidence graph"]')).not.toBeNull();
  const graphTab = container.querySelector<HTMLButtonElement>('[data-tracemind-section="graph"]');
  await act(async () =>
    graphTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(graphTab?.getAttribute('aria-current')).toBe('page');
  expect(container.querySelector('[aria-label="Evidence graph"]')?.parentElement?.hidden).toBe(
    false
  );
  const visualNode = [
    ...container.querySelectorAll<SVGGElement>('svg g[aria-label^="Inspect from evidence:"]'),
  ].at(-1);
  await act(async () =>
    visualNode?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(start?.value).toBe('stale-evidence');
  const details = [...container.querySelectorAll('[aria-label="Selected node details"]')].at(-1);
  expect(details?.textContent).toContain('sha256:stale-content');
  expect(details?.textContent).toContain('typescript-ast-v1');
  expect(details?.textContent).toContain('audit:audit-previous');
  expect(details?.textContent).toContain('CONTRADICTS');
  const graph = [
    ...container.querySelectorAll<SVGSVGElement>('svg[aria-label="Inspected evidence graph"]'),
  ].at(-1);
  if (!graph || !visualNode) throw new Error('Missing graph');
  expect(graph.getAttribute('viewBox')).toBe('0 0 1200 800');
  expect(graph.style.height).toBe('78vh');
  expect(graph.style.minHeight).toBe('640px');
  const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand graph"]');
  await act(async () => expand?.click());
  expect(graph.closest('[data-graph-canvas]')?.className).toContain('fixed');
  const close = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Close expanded graph"]'
  );
  await act(async () => close?.click());
  expect(graph.closest('[data-graph-canvas]')?.className).not.toContain('fixed');
  vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 480,
    width: 800,
    height: 480,
    toJSON: () => ({}),
  });
  const circle = visualNode.querySelector('circle');
  const beforeDrag = circle?.getAttribute('cx');
  await act(async () => {
    visualNode.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      })
    );
    graph.dispatchEvent(
      new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 120, clientY: 100 })
    );
    graph.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
  });
  expect(circle?.getAttribute('cx')).not.toBe(beforeDrag);
  const zoomIn = graph
    .closest('[data-graph-canvas]')
    ?.querySelector<HTMLButtonElement>('button[aria-label="Zoom in graph"]');
  const beforeZoom = graph?.getAttribute('viewBox');
  await act(async () =>
    zoomIn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(graph?.getAttribute('viewBox')).not.toBe(beforeZoom);
  await act(async () =>
    visualNode?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    )
  );
  expect(
    [...container.querySelectorAll('[aria-label="Selected node details"]')].at(-1)?.textContent
  ).toContain('sha256:stale-content');
  expect(container.textContent).toContain('src/stale.ts:4');
  expect(container.textContent).toContain('stale');
});

it('places readable graph titles without overlapping dense labels', () => {
  const nodes = Array.from({ length: 60 }, (_, index) => ({
    id: `node-${index}`,
    kind: 'config',
    label: 'backend/package-lock.json:license',
    source: { path: 'backend/package-lock.json', startLine: index + 1, endLine: index + 1 },
  })) as Parameters<typeof layoutGraphCanvasLabels>[0];
  const projected = new Map(
    nodes.map((node, index) => [
      node.id,
      { x: 450 + (index % 10) * 16, y: 300 + Math.floor(index / 10) * 16, depth: 0, scale: 1 },
    ])
  );
  const labels = layoutGraphCanvasLabels(nodes, projected, 'node-0', '', true);
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.length).toBeLessThan(nodes.length);
  expect(labels[0]).toMatchObject({ id: 'node-0', text: 'license · L1' });
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i]!;
    for (let j = i + 1; j < labels.length; j++) {
      const b = labels[j]!;
      const aRight = a.x + Math.min(280, a.text.length * 7.3 + 8);
      const bRight = b.x + Math.min(280, b.text.length * 7.3 + 8);
      expect(
        aRight <= b.x - 3 || bRight <= a.x - 3 || a.y + 4 <= b.y - 20 || b.y + 4 <= a.y - 20
      ).toBe(true);
    }
  }
  expect(layoutGraphCanvasLabels(nodes, projected, '', '', false)).toEqual([]);
});

it('warns that partial graph omissions can be unquantified', async () => {
  mocks.listAudits.mockResolvedValue([
    {
      id: 'audit-partial-unknown',
      locationId: 'local',
      root: '/repo',
      identity: '1:2',
      revision: null,
      dirty: null,
      fingerprint: null,
      capturedAt: 1,
      inventory: {
        filesDiscovered: 2,
        filesParsed: 2,
        graphCoverage: { status: 'partial', omittedFiles: 0 },
        skipped: 0,
        inventoryComplete: false,
        errors: [{ path: '', message: 'Time limit reached' }],
        languages: [],
        manifests: [],
        limitations: [],
      },
    },
  ]);
  const select = container.querySelector('select');
  await act(async () => {
    if (!select) throw new Error('Missing project selector');
    select.value = 'local';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const coverage = container.querySelector('[aria-label="Audit graph coverage"]');
  expect(coverage?.textContent).toContain('Graph coverage is partial');
  expect(coverage?.textContent).toContain(
    'no file-level parser omissions are currently quantified; additional omissions may be unknown'
  );
  expect(coverage?.textContent).toContain('Some evidence may be missing');
  expect(coverage?.textContent).toContain('freshness is not guaranteed');
  expect(coverage?.textContent).toContain('must not be treated as up to date');
});

it('pages graph targets and refreshes only the bounded overview after recording', async () => {
  const audit = {
    id: 'audit-pages',
    locationId: 'local',
    root: '/repo',
    identity: '1:2',
    revision: null,
    dirty: false,
    fingerprint: 'b'.repeat(64),
    capturedAt: 1,
    inventory: {
      filesDiscovered: 1,
      filesParsed: 1,
      skipped: 0,
      inventoryComplete: true,
      errors: [],
      languages: [],
      manifests: [],
      limitations: [],
    },
  };
  const base = {
    revision: 'audit:audit-pages',
    rootNodeId: 'root',
    nodeCount: 100_000,
    relationshipCount: 200_000,
    nodeCounts: {
      repository_revision: 1,
      file: 100_000,
      symbol: 0,
      dependency: 0,
      test: 0,
      observation: 0,
      command_run: 0,
      hypothesis: 0,
      evidence: 0,
      finding: 0,
    },
    relationshipCounts: {
      CONTAINS: 0,
      IMPORTS: 0,
      CALLS: 0,
      DEPENDS_ON: 0,
      TESTS: 0,
      SUPPORTS: 0,
      CONTRADICTS: 0,
      VERIFIED_BY: 0,
    },
    parserFailureCount: 0,
    parserFailures: [],
    retrievalReasons: [],
  };
  mocks.listAudits.mockResolvedValue([audit]);
  mocks.overview.mockImplementation(
    async (_location: string, _revision: string, cursor: string | null) =>
      cursor === 'a'
        ? {
            ...base,
            nodes: [{ id: 'b', kind: 'file', label: 'src/b.ts', stale: false }],
            nextCursor: null,
          }
        : {
            ...base,
            nodes: [{ id: 'a', kind: 'file', label: 'src/a.ts', stale: false }],
            nextCursor: 'a',
          }
  );
  const project = container.querySelector('select');
  await act(async () => {
    if (!project) throw new Error('Missing project selector');
    project.value = 'local';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('Target page 1');
  const next = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Next targets'
  );
  await act(async () => next?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(mocks.overview).toHaveBeenCalledWith('local', 'audit:audit-pages', 'a');
  expect(container.textContent).toContain('Target page 2');
  const target = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Graph relationship target"]'
  );
  expect(target?.options).toHaveLength(2);
  await act(async () => {
    if (!target) throw new Error('Missing target selector');
    target.value = 'b';
    target.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const relation = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Graph relationship type"]'
  );
  const label = container.querySelector<HTMLInputElement>(
    'input[aria-label="Investigation entry label"]'
  );
  const reason = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Retrieval or recording rationale"]'
  );
  await act(async () => {
    if (!relation || !label || !reason) throw new Error('Missing entry controls');
    relation.value = 'SUPPORTS';
    relation.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      label,
      'Observation'
    );
    label.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
      reason,
      'Recorded rationale'
    );
    reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const record = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Record entry'
  );
  let finishRecord: () => void = () => {};
  mocks.recordGraph.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRecord = resolve;
      })
  );
  await act(async () => {
    record?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    record?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.recordGraph).toHaveBeenCalledTimes(1);
  expect(record?.disabled).toBe(true);
  await act(async () => finishRecord());
  expect(mocks.recordGraph).toHaveBeenCalledWith('local', 'audit:audit-pages', {
    kind: 'observation',
    label: 'Observation',
    reason: 'Recorded rationale',
    targetNodeId: 'b',
    relation: 'SUPPORTS',
  });
  expect(mocks.overview).toHaveBeenCalledTimes(3);
  expect(mocks.graph).not.toHaveBeenCalled();
  const previous = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Previous targets'
  );
  await act(async () =>
    previous?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  expect(container.textContent).toContain('Target page 1');
});

it('searches graph files, loads all pages for multiple files, and reveals in Finder', async () => {
  const revision = 'audit:files';
  mocks.listAudits.mockResolvedValue([
    {
      id: 'files',
      locationId: 'local',
      root: '/repo',
      identity: '1:2',
      revision: 'a'.repeat(40),
      dirty: false,
      fingerprint: 'b'.repeat(64),
      capturedAt: 1,
      analysisVersion: AUDIT_ANALYZER_VERSION,
      inventory: {
        filesDiscovered: 2,
        filesParsed: 2,
        skipped: 0,
        inventoryComplete: true,
        errors: [],
        languages: [],
        manifests: [],
        limitations: [],
        graphCoverage: { status: 'complete', omittedFiles: 0 },
      },
    },
  ]);
  mocks.overview.mockResolvedValue({
    revision,
    rootNodeId: 'root',
    nodeCount: 4,
    relationshipCount: 0,
    nodeCounts: {},
    relationshipCounts: {},
    parserFailureCount: 0,
    nodes: [{ id: 'root', kind: 'repository_revision', label: revision, stale: false }],
    nextCursor: null,
    parserFailures: [],
    retrievalReasons: [],
  });
  mocks.searchGraphFiles.mockImplementation(async (_id, _rev, query) => ({
    revision,
    files: query
      ? [{ id: 'file-a', path: 'src/Alpha.ts', stale: false }]
      : [
          { id: 'file-a', path: 'src/Alpha.ts', stale: false },
          { id: 'file-b', path: 'src/Beta.ts', stale: false },
        ],
    nextCursor: null,
  }));
  const node = (id: string, path: string, kind: string) => ({
    id,
    projectId: 'local',
    revision,
    kind,
    label: `${path}:${id}`,
    source: { path, startLine: 1, endLine: 1 },
    extractionMethod: 'parser-v3',
    provenance: revision,
    stale: false,
    createdAt: 1,
  });
  mocks.getGraphFileNodesPage.mockImplementation(async (_id, _rev, path, cursor) => ({
    revision,
    path,
    nodes:
      path === 'src/Alpha.ts'
        ? [node(cursor ? 'symbol-a' : 'file-a', path, cursor ? 'symbol' : 'file')]
        : [node('file-b', path, 'file')],
    nextCursor: path === 'src/Alpha.ts' && !cursor ? 'more-alpha' : null,
  }));
  mocks.inspectGraph.mockImplementation(async (_id, _rev, id) => ({
    nodes:
      id === 'file-a'
        ? [node('file-a', 'src/Alpha.ts', 'file'), node('symbol-a', 'src/Alpha.ts', 'symbol')]
        : [node('file-b', 'src/Beta.ts', 'file')],
    relationships:
      id === 'file-a'
        ? [
            {
              id: 'edge',
              projectId: 'local',
              revision,
              sourceId: 'file-a',
              targetId: 'symbol-a',
              relation: 'CONTAINS',
              certainty: 'direct',
              source: { path: 'src/Alpha.ts', startLine: 1, endLine: 1 },
              extractionMethod: 'parser-v3',
              provenance: revision,
              stale: false,
              createdAt: 1,
            },
          ]
        : [],
    truncated: false,
    stopReason: null,
  }));
  const project = container.querySelector<HTMLSelectElement>('select');
  await act(async () => {
    if (!project) throw new Error('Missing project selector');
    project.value = 'local';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await selectTraceMindSection('notes');
  const explorer = container.querySelector('[aria-label="Graph file explorer"]');
  expect(container.querySelector('main > div')?.className).toContain('max-w-none');
  expect(container.querySelector('[aria-label="Full-page graph workspace"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Graph file navigator"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Graph note navigator"]')).not.toBeNull();
  expect(explorer?.textContent).toContain('Revision preview');
  expect(explorer?.textContent).toContain('Preview notes');
  expect(explorer?.querySelector('svg[aria-label="Inspected evidence graph"]')).not.toBeNull();
  expect(explorer?.querySelector('svg')?.style.height).toBe('calc(100vh - 22rem)');
  expect(explorer?.textContent).toContain('src/Alpha.ts');
  for (const path of ['src/Alpha.ts', 'src/Beta.ts']) {
    const checkbox = container.querySelector<HTMLInputElement>(
      `input[aria-label="Show graph nodes for ${path}"]`
    );
    await act(async () => {
      if (!checkbox) throw new Error(`Missing ${path}`);
      checkbox.click();
    });
  }
  expect(mocks.getGraphFileNodesPage).toHaveBeenCalledWith(
    'local',
    revision,
    'src/Alpha.ts',
    'more-alpha'
  );
  expect(explorer?.textContent).toContain('2 selected files · 3 saved nodes loaded');
  expect(explorer?.textContent).toContain('1 saved relationships visible');
  expect(explorer?.querySelector('[aria-label="Selected node details"]')?.textContent).toContain(
    'src/Alpha.ts'
  );
  const reveal = [...(explorer?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === 'Reveal in Finder'
  );
  await act(async () => reveal?.click());
  expect(mocks.revealGraphFileInFinder).toHaveBeenCalledWith('local', revision, 'src/Alpha.ts');
  const search = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search graph file names"]'
  );
  await act(async () => {
    if (!search) throw new Error('Missing graph search');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
      search,
      'Alpha'
    );
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  expect(mocks.searchGraphFiles).toHaveBeenCalledWith('local', revision, 'Alpha', null);
});

it('keeps provider credentials in the brain page and saves a separate project path policy', async () => {
  const project = container.querySelector('select');
  await act(async () => {
    if (!project) throw new Error('Missing selector');
    project.value = 'local';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await selectTraceMindSection('brain');
  expect(
    container.querySelector('#tracemind-section-investigations input[type="password"]')
  ).toBeNull();
  expect(container.querySelector('#tracemind-section-brain input[type="password"]')).not.toBeNull();
  const paths = container.querySelector<HTMLTextAreaElement>('[aria-label="Brain approved paths"]');
  await act(async () => {
    if (!paths) throw new Error('No brain path control');
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
      paths,
      'src/app.ts'
    );
    paths.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const save = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Save project brain policy'
  );
  await act(async () => save?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  expect(mocks.configureBrainProject).toHaveBeenCalledWith('local', {
    enabled: false,
    bridgeEnabled: false,
    shareNotes: false,
    allowedPaths: ['src/app.ts'],
  });
  expect(mocks.generateAIInvestigation).not.toHaveBeenCalled();
});
