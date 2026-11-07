import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuditInvalidation,
  AuditEvidence,
  AuditRecord,
  EvidenceComparison,
} from '@main/core/tracemind/audit/audit-store';
import {
  AUDIT_ANALYZER_VERSION,
  auditNeedsRefresh,
} from '@main/core/tracemind/audit/audit-version';
import type { GraphInspection } from '@main/core/tracemind/graph/graph-query';
import type {
  GraphFileSearchPage,
  GraphOverview,
  GraphParserFailurePage,
  GraphRelationshipPage,
} from '@main/core/tracemind/graph/graph-store';
import type { PersistentGraphNode } from '@main/core/tracemind/graph/model';
import type {
  IssueEvent,
  IssueInvestigationOutcome,
  IssueInvestigationState,
  IssuePriority,
  IssueStatus,
  TraceMindIssue,
} from '@main/core/tracemind/investigation/issue-store';
import type { InvestigationReport } from '@main/core/tracemind/investigation/report';
import {
  checkOutcomes,
  getAllowedInvestigationTransitions,
} from '@main/core/tracemind/investigation/state-machine';
import type { LiveMonitorState } from '@main/core/tracemind/project-registry/live-monitor';
import type { RuntimeSnapshot } from '@main/core/tracemind/runtime/model';
import type { CommandProposal } from '@main/core/tracemind/verification/command-contract';
import type { RunProposalSummary } from '@main/core/tracemind/verification/run-store';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import './tracemind.css';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { Location } from '@shared/core/locations/locations';
import type {
  TraceMindAIInvestigation,
  TraceMindAIProviderStatus,
  TraceMindRuntimeAIAdvisory,
  TraceMindRuntimeAISettings,
} from '@shared/core/tracemind/ai-investigation';
import { BrainProjectPanel } from './brain-project-panel';
import {
  connectionNotes,
  connectionPositions,
  isGraphSourcePath,
  sourceGraphInspection,
} from './graph-notes';
import { traceMindSections } from './workflow';

type InvestigationReportWithFreshness = InvestigationReport & {
  auditFreshness?: {
    auditId: string | null;
    state: LiveMonitorState | 'not-linked' | 'unmonitored';
    stale: boolean | null;
    changedCount: number;
    changedPaths: string[];
    pathsTruncated: boolean;
  };
};

type AuditMonitorStatus = {
  active: boolean;
  state: LiveMonitorState;
  invalidation: AuditInvalidation | null;
};

function auditAnalysisLabel(analysisVersion: number | undefined): string {
  return auditNeedsRefresh(analysisVersion)
    ? `Needs refresh — analyzer version ${analysisVersion ?? 'not recorded'}; current version ${AUDIT_ANALYZER_VERSION}`
    : `Current — analyzer version ${AUDIT_ANALYZER_VERSION}`;
}

function AuditAnalysisFreshness({
  analysisVersion,
  context,
}: {
  analysisVersion: number | undefined;
  context: string;
}) {
  const stale = auditNeedsRefresh(analysisVersion);
  return (
    <p
      aria-label={`${context} analysis freshness`}
      data-analysis-stale={stale ? 'true' : 'false'}
      role={stale ? 'status' : undefined}
      className="text-sm text-foreground-muted"
    >
      {context} analysis: {auditAnalysisLabel(analysisVersion)}.
      {stale &&
        ' The saved file fingerprint describes its historical snapshot only; derived inventory and graph metadata need a new audit.'}
    </p>
  );
}

function auditOptionLabel(audit: AuditRecord): string {
  const freshness = auditNeedsRefresh(audit.analysisVersion)
    ? 'analysis needs refresh'
    : `analysis current v${AUDIT_ANALYZER_VERSION}`;
  return `${new Date(audit.capturedAt).toLocaleString()} — ${audit.id} — ${freshness}`;
}

function EvidenceCitationList({
  ids,
  references,
}: {
  ids: string[];
  references: TraceMindAIInvestigation['evidenceReferences'];
}) {
  if (ids.length === 0)
    return <p className="text-xs text-foreground-muted">No evidence citations supplied.</p>;
  return (
    <ul aria-label="Evidence citations" className="mt-1 flex flex-col gap-1">
      {ids.map((id) => {
        const reference = references.find((item) => item.id === id);
        return (
          <li key={id} className="text-xs break-all text-foreground-muted">
            {reference?.label ?? id}
            {reference?.path ? ` · ${reference.path}` : ''}
            {reference?.startLine !== null && reference?.startLine !== undefined
              ? `:${reference.startLine}${reference.endLine && reference.endLine !== reference.startLine ? `–${reference.endLine}` : ''}`
              : ''}
            {reference
              ? ` · ${reference.freshness} · ${reference.certainty}`
              : ' · reference metadata unavailable'}
          </li>
        );
      })}
    </ul>
  );
}

type TraceMindSection = (typeof traceMindSections)[number]['id'];

export function TraceMindMainPanel() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  const [section, setSection] = useState<TraceMindSection>('project');
  const [issues, setIssues] = useState<TraceMindIssue[]>([]);
  const [editing, setEditing] = useState<TraceMindIssue | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [issuePriority, setIssuePriority] = useState<IssuePriority>('medium');
  const [issueOwner, setIssueOwner] = useState('');
  const [issueAuditId, setIssueAuditId] = useState('');
  const [issueEvents, setIssueEvents] = useState<IssueEvent[]>([]);
  const [investigationReport, setInvestigationReport] =
    useState<InvestigationReportWithFreshness | null>(null);
  const [eventType, setEventType] = useState<'observation' | 'hypothesis' | 'finding' | 'evidence'>(
    'observation'
  );
  const [eventBody, setEventBody] = useState('');
  const [eventRevision, setEventRevision] = useState('');
  const [eventRunId, setEventRunId] = useState('');
  const [findingCriterionId, setFindingCriterionId] = useState('');
  const [checkCriterionId, setCheckCriterionId] = useState('');
  const [eventBusy, setEventBusy] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState<IssueStatus>('investigating');
  const [transitionRationale, setTransitionRationale] = useState('');
  const [investigationTarget, setInvestigationTarget] = useState<IssueInvestigationState>('queued');
  const [investigationOutcome, setInvestigationOutcome] = useState<IssueInvestigationOutcome | ''>(
    ''
  );
  const [investigationRunId, setInvestigationRunId] = useState('');
  const [graphRevision, setGraphRevision] = useState('');
  const [reviewRevision, setReviewRevision] = useState('');
  const [graphLabel, setGraphLabel] = useState('');
  const [graphReason, setGraphReason] = useState('');
  const [viewedAuditId, setViewedAuditId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshAvailable, setRefreshAvailable] = useState(false);
  const [reviewVersion, setReviewVersion] = useState<TraceMindIssue | null>(null);
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [auditing, setAuditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditMessage, setAuditMessage] = useState('');
  const [aiProvider, setAIProvider] = useState<TraceMindAIProviderStatus | null>(null);
  const [aiConnectionMessage, setAIConnectionMessage] = useState('');
  const [aiEndpoint, setAIEndpoint] = useState('');
  const [aiModel, setAIModel] = useState('');
  const [aiApiKey, setAIApiKey] = useState('');
  const [aiInvestigation, setAIInvestigation] = useState<TraceMindAIInvestigation | null>(null);
  const [aiBusy, setAIBusy] = useState(false);
  const [aiGenerating, setAIGenerating] = useState(false);
  const [aiError, setAIError] = useState('');
  const selectedIssueAudit = audits.find((audit) => audit.id === issueAuditId) ?? null;
  const linkedHypotheses =
    editing?.auditId === issueAuditId && selectedIssueAudit?.revision
      ? issueEvents.filter(
          (entry) =>
            entry.type === 'hypothesis' &&
            entry.auditId === issueAuditId &&
            entry.revision === selectedIssueAudit.revision
        )
      : [];

  useEffect(() => {
    let active = true;
    void rpc.locations.getLocations().then(
      (items) => {
        if (active) setLocations(items.filter((item) => item.sshHost === null));
      },
      () => {
        if (active) setError('Could not load local projects.');
      }
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void rpc.tracemind.getAIProviderStatus().then(
      (status) => {
        if (active) {
          setAIProvider(status);
          setAIEndpoint(status.endpoint);
          setAIModel(status.model);
        }
      },
      () => {
        if (active) setAIError('Could not load AI provider settings.');
      }
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setIssues([]);
    setEditing(null);
    setTitle('');
    setDescription('');
    setIssueAuditId('');
    setIssueEvents([]);
    setFindingCriterionId('');
    setCheckCriterionId('');
    setInvestigationReport(null);
    setViewedAuditId('');
    setRefreshAvailable(false);
    setReviewVersion(null);
    setError('');
    if (!locationId) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    void rpc.tracemind
      .listIssues(locationId)
      .then(
        (items) => {
          if (active) setIssues(items);
        },
        () => {
          if (active) setError('Could not load issues for this project.');
        }
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [locationId]);

  useEffect(() => {
    let active = true;
    setIssueEvents([]);
    setInvestigationReport(null);
    setAIInvestigation(null);
    if (!locationId || !editing?.id)
      return () => {
        active = false;
      };
    void Promise.all([
      rpc.tracemind.listIssueEvents(locationId, editing.id),
      rpc.tracemind.generateInvestigationReport(locationId, editing.id),
    ]).then(
      ([events, report]) => {
        if (active) {
          setIssueEvents(events);
          setInvestigationReport(report);
          const latestAIEvent = [...events]
            .reverse()
            .find((entry) => entry.type === 'ai_investigation' && entry.aiInvestigation);
          setAIInvestigation(latestAIEvent?.aiInvestigation ?? null);
        }
      },
      () => {
        if (active) setError('Could not load the issue timeline or investigation report.');
      }
    );
    return () => {
      active = false;
    };
  }, [locationId, editing?.id, editing?.version]);

  useEffect(() => {
    setFindingCriterionId('');
    setCheckCriterionId('');
  }, [issueAuditId]);

  useEffect(() => {
    let active = true;
    setAudits([]);
    setAuditMessage('');
    if (!locationId) {
      setAuditLoading(false);
      return () => {
        active = false;
      };
    }
    setAuditLoading(true);
    void rpc.tracemind
      .listAudits(locationId)
      .then(
        (items) => {
          if (active) setAudits(items);
        },
        () => {
          if (active) setAuditMessage('Could not load audit history.');
        }
      )
      .finally(() => {
        if (active) setAuditLoading(false);
      });
    return () => {
      active = false;
    };
  }, [locationId]);

  async function addLocalProject(): Promise<void> {
    if (picking) return;
    setPicking(true);
    setError('');
    try {
      const location = await rpc.tracemind.pickLocalProject();
      if (location) {
        setLocations((current) => [location, ...current.filter((item) => item.id !== location.id)]);
        setLocationId(location.id);
      }
    } catch {
      setError('Could not add the selected local project.');
    } finally {
      setPicking(false);
    }
  }

  async function saveAIProvider(): Promise<void> {
    if (aiBusy || !aiEndpoint.trim() || !aiModel.trim() || !aiApiKey.trim()) return;
    setAIBusy(true);
    setAIError('');
    try {
      const status = await rpc.tracemind.configureAIProvider({
        endpoint: aiEndpoint.trim(),
        model: aiModel.trim(),
        apiKey: aiApiKey,
      });
      setAIProvider(status);
      setAIEndpoint(status.endpoint);
      setAIModel(status.model);
      setAIApiKey('');
      setAIConnectionMessage('Provider saved. Test the connection before using model analysis.');
    } catch (error) {
      setAIError(
        error instanceof Error && /secure secret storage is unavailable/i.test(error.message)
          ? 'Secure key storage is unavailable. Unlock the operating-system Keychain/secure storage, then retry; the key was not saved.'
          : 'Could not save AI provider settings. Check the HTTPS endpoint, model, and API key; no key is returned or displayed.'
      );
    } finally {
      setAIBusy(false);
    }
  }

  async function testAIConnection(): Promise<void> {
    if (aiBusy || !aiProvider?.configured) return;
    setAIBusy(true);
    setAIError('');
    setAIConnectionMessage('Testing the saved provider…');
    try {
      const result = await rpc.tracemind.testAIProviderConnection();
      setAIConnectionMessage(
        `Connection verified · ${result.model} · no project evidence was sent.`
      );
    } catch (error) {
      setAIConnectionMessage('Provider connection not verified.');
      setAIError(
        error instanceof Error && /Secure secret storage is unavailable/i.test(error.message)
          ? 'Secure key storage is unavailable. Unlock the operating-system Keychain/secure storage, then retry.'
          : error instanceof Error && /HTTP \d{3}/.test(error.message)
            ? `Provider connection failed (${error.message.match(/HTTP \d{3}/)?.[0] ?? 'HTTP error'}). Check the saved endpoint, model, and key.`
            : 'Provider connection failed. Check the saved endpoint and network connection.'
      );
    } finally {
      setAIBusy(false);
    }
  }

  async function clearAIProvider(): Promise<void> {
    if (aiBusy) return;
    setAIBusy(true);
    setAIError('');
    try {
      const status = await rpc.tracemind.clearAIProvider();
      setAIProvider(status);
      setAIEndpoint(status.endpoint);
      setAIModel(status.model);
      setAIApiKey('');
      setAIInvestigation(null);
    } catch {
      setAIError('Could not clear the saved AI provider key.');
    } finally {
      setAIBusy(false);
    }
  }

  async function generateAIInvestigation(): Promise<void> {
    if (!locationId || !editing || !aiProvider?.configured || aiGenerating) return;
    setAIGenerating(true);
    setAIError('');
    try {
      const result = await rpc.tracemind.generateAIInvestigation(locationId, editing.id);
      setAIInvestigation(result);
      const [events, report, latestIssues] = await Promise.all([
        rpc.tracemind.listIssueEvents(locationId, editing.id),
        rpc.tracemind.generateInvestigationReport(locationId, editing.id),
        rpc.tracemind.listIssues(locationId),
      ]);
      setIssueEvents(events);
      setInvestigationReport(report);
      setIssues(latestIssues);
      const latestIssue = latestIssues.find((issue) => issue.id === editing.id);
      if (latestIssue) setEditing(latestIssue);
    } catch {
      setAIError('AI investigation failed. Review the provider settings and try again.');
    } finally {
      setAIGenerating(false);
    }
  }

  async function runAudit(): Promise<void> {
    if (!locationId || auditing) return;
    setAuditing(true);
    setAuditMessage('');
    try {
      const approved = await rpc.tracemind.requestAuditApproval(locationId);
      if (!approved) {
        setAuditMessage('Audit was not approved.');
        return;
      }
      const audit = await rpc.tracemind.runAudit(locationId);
      setAudits((current) => [audit, ...current.filter((item) => item.id !== audit.id)]);
      setViewedAuditId('');
    } catch (error) {
      setAuditMessage(error instanceof Error ? `Audit failed: ${error.message}` : 'Audit failed.');
    } finally {
      setAuditing(false);
    }
  }

  function selectIssue(issue: TraceMindIssue | null): void {
    setEditing(issue);
    setTitle(issue?.title ?? '');
    setDescription(issue?.description ?? '');
    setIssueAuditId(issue?.auditId ?? '');
    setFindingCriterionId('');
    setCheckCriterionId('');
    setIssuePriority(issue?.priority ?? 'medium');
    setIssueOwner(issue?.owner ?? '');
    const currentPhase = issue?.investigationState ?? 'reported';
    const allowedPhases = getAllowedInvestigationTransitions(currentPhase);
    setInvestigationTarget(allowedPhases[0] ?? currentPhase);
    setInvestigationOutcome('');
    setInvestigationRunId('');
    setError('');
    setRefreshAvailable(false);
    setReviewVersion(null);
  }

  async function refreshIssueVersion(): Promise<void> {
    if (!editing || !locationId || saving) return;
    setSaving(true);
    setError('');
    try {
      const items = await rpc.tracemind.listIssues(locationId);
      const latest = items.find((item) => item.id === editing.id);
      setIssues(items);
      if (!latest) {
        setError('This issue is no longer available. Your draft is unchanged.');
        return;
      }
      setEditing(latest);
      setReviewVersion(latest);
      setRefreshAvailable(false);
    } catch {
      setError('Could not refresh the issue. Your draft is unchanged.');
    } finally {
      setSaving(false);
    }
  }

  async function saveIssue(): Promise<void> {
    if (!locationId || !title.trim() || saving || loading) return;
    setSaving(true);
    setError('');
    try {
      const input = {
        title,
        description,
        ...(issueAuditId ? { auditId: issueAuditId } : editing?.auditId ? { auditId: null } : {}),
      };
      const saved = editing
        ? await rpc.tracemind.updateIssue(locationId, editing.id, editing.version, input)
        : await rpc.tracemind.createIssue(locationId, input);
      setIssues((current) => [saved, ...current.filter((issue) => issue.id !== saved.id)]);
      selectIssue(saved);
    } catch {
      setError('Could not save the issue. It may have changed; reload before retrying.');
      setRefreshAvailable(Boolean(editing));
    } finally {
      setSaving(false);
    }
  }

  function receiveIssue(saved: TraceMindIssue): void {
    setEditing(saved);
    setIssues((current) => [saved, ...current.filter((issue) => issue.id !== saved.id)]);
    const currentPhase = saved.investigationState ?? 'reported';
    const allowedPhases = getAllowedInvestigationTransitions(currentPhase);
    setInvestigationTarget(allowedPhases[0] ?? currentPhase);
  }

  async function saveIssueMetadata(): Promise<void> {
    if (!locationId || !editing || eventBusy) return;
    setEventBusy(true);
    setError('');
    try {
      receiveIssue(
        await rpc.tracemind.updateIssueMetadata(locationId, editing.id, editing.version, {
          priority: issuePriority,
          owner: issueOwner.trim() || null,
        })
      );
    } catch {
      setError('Could not update issue details. Reload the latest issue version and retry.');
    } finally {
      setEventBusy(false);
    }
  }

  async function changeIssueStatus(): Promise<void> {
    if (!locationId || !editing || eventBusy || !transitionRationale.trim()) return;
    setEventBusy(true);
    setError('');
    try {
      const saved = await rpc.tracemind.transitionIssue(
        locationId,
        editing.id,
        editing.version,
        transitionTarget,
        transitionRationale
      );
      receiveIssue(saved);
      setTransitionRationale('');
    } catch {
      setError(
        'Could not change issue status. Check the current issue version and transition rationale.'
      );
    } finally {
      setEventBusy(false);
    }
  }

  async function changeInvestigationPhase(): Promise<void> {
    if (!locationId || !editing || eventBusy || !transitionRationale.trim()) return;
    const allowed = getAllowedInvestigationTransitions(editing.investigationState);
    const needsCheckOutcome =
      investigationTarget === 'verified' || investigationTarget === 'failed';
    if (
      !allowed.includes(investigationTarget) ||
      (needsCheckOutcome && (!investigationOutcome || !investigationRunId.trim())) ||
      Boolean(investigationOutcome) !== Boolean(investigationRunId.trim())
    )
      return;
    setEventBusy(true);
    setError('');
    try {
      const input = {
        nextState: investigationTarget,
        rationale: transitionRationale.trim(),
        ...(investigationOutcome && investigationRunId.trim()
          ? { outcome: investigationOutcome, checkRunId: investigationRunId.trim() }
          : {}),
      };
      const result = await rpc.tracemind.transitionIssueInvestigation(
        locationId,
        editing.id,
        editing.version,
        input
      );
      receiveIssue(result.issue);
      setIssueEvents((current) => [...current, result.event]);
      setTransitionRationale('');
      setInvestigationOutcome('');
      setInvestigationRunId('');
      setInvestigationReport(
        await rpc.tracemind.generateInvestigationReport(locationId, editing.id)
      );
    } catch {
      setError(
        'Could not advance the investigation phase. Confirm the current issue version and legal phase, then link the check and finding to the same hypothesis, audit, and latest graph revision.'
      );
    } finally {
      setEventBusy(false);
    }
  }

  async function addIssueEvent(): Promise<void> {
    if (!locationId || !editing || eventBusy || !eventBody.trim()) return;
    const linksAcceptanceCriterion = eventType === 'hypothesis' || eventType === 'finding';
    if (
      linksAcceptanceCriterion &&
      (!issueAuditId || issueAuditId !== editing.auditId || !selectedIssueAudit)
    ) {
      setError('Save the issue with its related audit before recording a hypothesis or finding.');
      return;
    }
    if (
      eventType === 'finding' &&
      !linkedHypotheses.some((entry) => entry.id === findingCriterionId)
    ) {
      setError(
        'Choose a persisted hypothesis from the issue-linked audit as this finding’s criterion.'
      );
      return;
    }
    setEventBusy(true);
    setError('');
    try {
      const input = {
        type: eventType,
        body: eventBody,
        evidenceKind:
          eventType === 'observation'
            ? ('observation' as const)
            : eventType === 'hypothesis'
              ? ('inference' as const)
              : ('record' as const),
        ...(linksAcceptanceCriterion
          ? { auditId: issueAuditId, revision: selectedIssueAudit?.revision ?? null }
          : eventRevision.trim()
            ? { revision: eventRevision.trim() }
            : {}),
        ...(eventType === 'finding' ? { criterionId: findingCriterionId } : {}),
      };
      const result = await rpc.tracemind.recordIssueEvent(
        locationId,
        editing.id,
        editing.version,
        input
      );
      receiveIssue(result.issue);
      setIssueEvents((current) => [...current, result.event]);
      setEventBody('');
      setFindingCriterionId('');
      const report = await rpc.tracemind.generateInvestigationReport(locationId, editing.id);
      setInvestigationReport(report);
    } catch {
      setError(
        'Could not append the investigation event. Check the linked audit, check run, revision, and issue version.'
      );
    } finally {
      setEventBusy(false);
    }
  }

  async function addIssueCheckResult(): Promise<void> {
    if (
      !locationId ||
      !editing ||
      eventBusy ||
      !issueAuditId ||
      editing.auditId !== issueAuditId ||
      !eventRunId.trim() ||
      !eventBody.trim()
    )
      return;
    setEventBusy(true);
    setError('');
    try {
      const result = await rpc.tracemind.recordIssueCheckResult(
        locationId,
        editing.id,
        editing.version,
        issueAuditId,
        eventRunId.trim(),
        eventBody,
        checkCriterionId || undefined
      );
      receiveIssue(result.issue);
      setIssueEvents((current) => [...current, result.event]);
      setEventBody('');
      setEventRunId('');
      setCheckCriterionId('');
      setInvestigationReport(
        await rpc.tracemind.generateInvestigationReport(locationId, editing.id)
      );
    } catch {
      setError(
        'Could not link the terminal check result. Confirm its audit, run ID, and issue version.'
      );
    } finally {
      setEventBusy(false);
    }
  }

  async function addIssueGraphEntry(): Promise<void> {
    if (
      !locationId ||
      !editing ||
      eventBusy ||
      !graphRevision.trim() ||
      !graphLabel.trim() ||
      !graphReason.trim()
    )
      return;
    setEventBusy(true);
    setError('');
    try {
      await rpc.tracemind.recordIssueGraphEntry(
        locationId,
        graphRevision.trim(),
        editing.id,
        editing.version,
        { kind: 'observation', label: graphLabel, reason: graphReason }
      );
      const [events, report, latest] = await Promise.all([
        rpc.tracemind.listIssueEvents(locationId, editing.id),
        rpc.tracemind.generateInvestigationReport(locationId, editing.id),
        rpc.tracemind.listIssues(locationId),
      ]);
      const current = latest.find((issue) => issue.id === editing.id);
      if (current) receiveIssue(current);
      setIssueEvents(events);
      setInvestigationReport(report);
      setGraphLabel('');
      setGraphReason('');
      setError('');
    } catch {
      setError(
        'Could not append a linked graph entry. Check the graph revision and issue version.'
      );
    } finally {
      setEventBusy(false);
    }
  }

  async function markEvidenceStale(): Promise<void> {
    if (!locationId || !editing || eventBusy || !transitionRationale.trim()) return;
    setEventBusy(true);
    setError('');
    try {
      receiveIssue(
        await rpc.tracemind.markIssueEvidenceStale(
          locationId,
          editing.id,
          editing.version,
          transitionRationale
        )
      );
      setTransitionRationale('');
    } catch {
      setError('Could not mark evidence stale. Reload the issue and provide a rationale.');
    } finally {
      setEventBusy(false);
    }
  }

  async function reviewCurrentEvidence(): Promise<void> {
    if (
      !locationId ||
      !editing ||
      eventBusy ||
      !reviewRevision.trim() ||
      !transitionRationale.trim()
    )
      return;
    setEventBusy(true);
    setError('');
    try {
      receiveIssue(
        await rpc.tracemind.reviewIssueEvidence(
          locationId,
          editing.id,
          editing.version,
          reviewRevision.trim(),
          transitionRationale
        )
      );
      setTransitionRationale('');
    } catch {
      setError(
        'Could not review evidence. Confirm the latest graph revision and provide a rationale.'
      );
    } finally {
      setEventBusy(false);
    }
  }

  async function refreshInvestigationReport(): Promise<void> {
    if (!locationId || !editing || eventBusy) return;
    setEventBusy(true);
    try {
      setInvestigationReport(
        await rpc.tracemind.generateInvestigationReport(locationId, editing.id)
      );
    } catch {
      setError('Could not generate the issue investigation report.');
    } finally {
      setEventBusy(false);
    }
  }

  const currentInvestigationState = editing?.investigationState ?? 'reported';
  const allowedInvestigationPhases = editing
    ? getAllowedInvestigationTransitions(currentInvestigationState)
    : [];
  const selectedLocation = locations.find((item) => item.id === locationId) ?? null;
  const selectedAudit = audits.find((item) => item.id === viewedAuditId) ?? audits[0];
  const activeSection = traceMindSections.find((item) => item.id === section)!;
  const pageScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pageScroll.current?.scrollTo?.({ top: 0 });
  }, [section]);

  return (
    <main className="tm-workspace h-full bg-background text-foreground">
      <div className="tm-shell max-w-none">
        <header className="tm-topbar">
          <div className="tm-brand-mark" aria-hidden="true">
            T<span>m</span>
          </div>
          <div>
            <h2>TraceMind</h2>
            <p>Record and investigate issues in a local project.</p>
          </div>
          <span className="tm-channel">CANARY / LOCAL INTELLIGENCE</span>
        </header>
        <div className="tm-project-bar">
          <label className="flex max-w-xl flex-col gap-2 text-sm">
            Local project
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              disabled={saving || auditing || picking}
              className="h-9 rounded-md border border-border bg-background px-2"
            >
              <option value="">Select a local project</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} — {location.dir}
                </option>
              ))}
            </select>
          </label>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void addLocalProject()}
              disabled={picking || saving || auditing}
            >
              {picking ? 'Selecting…' : 'Add local project'}
            </Button>
          </div>
          <span role="status" className="tm-model-state">
            {aiProvider?.configured
              ? 'LLM configured · connection not verified'
              : aiProvider
                ? 'No LLM configured · local tools available'
                : 'Checking LLM configuration…'}
          </span>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="tm-body">
          <nav aria-label="TraceMind sections" className="tm-navigation">
            <p className="tm-nav-label">PROJECT WORKFLOW</p>
            {traceMindSections.map((item) => (
              <button
                key={item.id}
                type="button"
                data-tracemind-section={item.id}
                aria-current={section === item.id ? 'page' : undefined}
                onClick={() => setSection(item.id)}
                title={item.summary}
                className="tm-nav-item"
                aria-controls={
                  item.id === 'notes' ? 'tracemind-section-graph' : `tracemind-section-${item.id}`
                }
              >
                <span data-section-title className="text-sm font-medium text-foreground">
                  {item.title}
                </span>
                <span className="tm-nav-index" aria-hidden="true">
                  {String(traceMindSections.indexOf(item) + 1).padStart(2, '0')}
                </span>
              </button>
            ))}
            <div className="tm-nav-footer">
              Evidence before inference.
              <br />
              Every finding keeps its source.
            </div>
          </nav>
          <div ref={pageScroll} className="tm-content">
            <header className="tm-page-heading">
              <div>
                <p className="tm-eyebrow">TRACEMIND / {selectedLocation?.name ?? 'WORKSPACE'}</p>
                <h1>{activeSection.title}</h1>
                <p>{activeSection.summary}</p>
              </div>
              <span className="tm-status-pill">
                {selectedAudit ? 'Snapshot available' : 'Awaiting audit'}
              </span>
            </header>
            <section
              id="tracemind-section-issues"
              aria-label="Issues section"
              hidden={section !== 'issues'}
            >
              <div className="tm-panel-heading">
                <h2>
                  Issue register <span className="tm-count">{issues.length}</span>
                </h2>
                <Button
                  disabled={!locationId || loading}
                  onClick={() => {
                    selectIssue(null);
                    setSection('investigations');
                  }}
                >
                  New issue
                </Button>
              </div>
              {issues.length === 0 ? (
                <div className="tm-empty">
                  <h3>{locationId ? 'No issues recorded' : 'Choose a project to begin'}</h3>
                  <p>
                    Capture an audit, then record a symptom and link the evidence that supports it.
                  </p>
                </div>
              ) : (
                <div className="tm-issue-list">
                  {issues.map((issue) => (
                    <button
                      key={issue.id}
                      className="tm-issue-row"
                      onClick={() => {
                        selectIssue(issue);
                        setSection('investigations');
                      }}
                    >
                      <span className="tm-status-pill">{issue.status}</span>
                      <strong>{issue.title}</strong>
                      <span>{issue.priority}</span>
                      <span>{issue.owner || 'Unassigned'}</span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section
              id="tracemind-section-process"
              aria-label="Investigation process section"
              hidden={section !== 'process'}
            >
              <div className="tm-process">
                <h2>From a symptom to an evidence-backed finding</h2>
                <p>
                  Each transition is explicit. A completed check never resolves an issue
                  automatically.
                </p>
                <ol>
                  {[
                    'Record the issue and affected project',
                    'Capture evidence and review freshness',
                    'Form a hypothesis with source references',
                    'Discover a check and approve its execution',
                    'Review the result and record a finding',
                    'Verify the finding or record an inconclusive outcome',
                  ].map((step, i) => (
                    <li key={step}>
                      <span>{String(i + 1).padStart(2, '0')}</span>
                      {step}
                    </li>
                  ))}
                </ol>
                <Button variant="outline" onClick={() => setSection('investigations')}>
                  Open investigations
                </Button>
              </div>
            </section>
            <section
              id="tracemind-section-brain"
              aria-label="TraceMind brain section"
              hidden={section !== 'brain'}
            >
              <section
                aria-label="TraceMind brain provider"
                className="mt-6 flex flex-col gap-4 rounded-lg border border-border p-4"
              >
                <div>
                  <h3 className="font-medium">TraceMind brain provider</h3>
                  <p className="text-sm text-foreground-muted">
                    Configure one OpenAI-compatible model for TraceMind task routing,
                    investigations, and runtime advisories. Your key is encrypted locally and is
                    never returned to agents or displayed after saving.
                  </p>
                  <p className="text-xs text-foreground-muted">
                    A saved key does not enable sharing. Approve each project below. Source contents
                    stay local; requests include task text, approved paths, and only separately
                    approved notes. Provider compatibility requires chat/completions JSON output.
                  </p>
                </div>
                <form
                  className="grid gap-3 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveAIProvider();
                  }}
                >
                  <label className="flex flex-col gap-2 text-sm">
                    Provider endpoint
                    <Input
                      aria-label="AI provider endpoint"
                      value={aiEndpoint}
                      onChange={(event) => setAIEndpoint(event.target.value)}
                      maxLength={2048}
                      autoComplete="url"
                      disabled={aiBusy}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm">
                    Model
                    <Input
                      aria-label="AI provider model"
                      value={aiModel}
                      onChange={(event) => setAIModel(event.target.value)}
                      maxLength={100}
                      autoComplete="off"
                      disabled={aiBusy}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm sm:col-span-2">
                    API key (saved encrypted; not displayed again)
                    <Input
                      aria-label="AI provider API key"
                      type="password"
                      value={aiApiKey}
                      onChange={(event) => setAIApiKey(event.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                      disabled={aiBusy}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2 sm:col-span-2">
                    <Button
                      type="submit"
                      disabled={aiBusy || !aiEndpoint.trim() || !aiModel.trim() || !aiApiKey.trim()}
                    >
                      {aiBusy ? 'Saving…' : 'Save AI provider'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={aiBusy || !aiProvider?.configured}
                      onClick={() => void testAIConnection()}
                    >
                      {aiBusy ? 'Testing…' : 'Test saved provider'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={aiBusy || !aiProvider?.configured}
                      onClick={() => void clearAIProvider()}
                    >
                      Clear saved key
                    </Button>
                    <span role="status" className="self-center text-sm text-foreground-muted">
                      {aiProvider?.configured
                        ? `Configured · ${aiProvider.model} · ${aiProvider.endpoint}`
                        : aiProvider
                          ? 'No provider key saved'
                          : 'Loading provider settings…'}
                    </span>
                  </div>
                </form>
                {aiConnectionMessage && (
                  <p role="status" className="text-sm text-foreground-muted">
                    {aiConnectionMessage}
                  </p>
                )}
                {aiError && <p role="alert">{aiError}</p>}
              </section>
              {section === 'brain' && locationId ? (
                <BrainProjectPanel key={locationId} locationId={locationId} />
              ) : (
                <p>Select a local project to configure its isolation policy.</p>
              )}
            </section>
            <section
              id="tracemind-section-monitoring"
              aria-label="Continuous monitoring section"
              hidden={section !== 'monitoring'}
            >
              <div className="tm-process">
                <h2>Watch the project, refresh its brain</h2>
                <p>
                  Approved monitoring runs in the main process while you navigate Switch. Changes
                  save bounded local change notes and trigger debounced audit and graph refreshes.
                  Historical snapshots remain unchanged. Monitoring never runs project commands or
                  sends source to a model.
                </p>
              </div>
              {selectedAudit && section === 'monitoring' ? (
                <AuditMonitorPanel
                  key={`continuous:${locationId}:${selectedAudit.id}`}
                  locationId={locationId}
                  auditId={selectedAudit.id}
                />
              ) : (
                <p className="tm-empty">
                  Select a project and capture an audit to enable monitoring.
                </p>
              )}
              <div className="tm-boundary">
                <strong>Threat detection & communication alerts</strong>
                <p>
                  The watcher detects file changes, not intrusions. Local agent sessions can report
                  indexed issues through tracemind_report_issue; Switch receives a minimal alert.
                  Slack/Mattermost delivery still depends on the configured platform bridge.
                </p>
              </div>
            </section>
            <section
              id="tracemind-section-integration"
              aria-label="Switch integration section"
              hidden={section !== 'integration'}
            >
              <div className="tm-process">
                <h2>Switch → TraceMind → solving agent</h2>
                <p>
                  Approved local sessions retrieve TraceMind context before handling an addressed
                  Switch message. External platform ingress still requires a working Slack or
                  Mattermost connector.
                </p>
                <ol>
                  {[
                    [
                      'Communication request',
                      'Uses existing Switch room routing; external ingress must be verified separately',
                    ],
                    ['Project audit', 'Available locally — explicit project approval'],
                    [
                      'Investigation & preferred path',
                      aiProvider?.configured
                        ? aiConnectionMessage.startsWith('Connection verified')
                          ? 'Provider connectivity verified; analysis remains explicit and advisory'
                          : 'Provider saved; connectivity has not been verified'
                        : 'No LLM configured — manual evidence-backed investigation remains available',
                    ],
                    [
                      'Agent handoff',
                      'Local session IPC supplies approved paths and notes before message execution',
                    ],
                    [
                      'Report & alert delivery',
                      'Agent report tool saves local issues and requests a minimal same-room alert',
                    ],
                  ].map(([label, status]) => (
                    <li key={label}>
                      <div>
                        <strong>{label}</strong>
                        <p>{status}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <Button variant="outline" onClick={() => setSection('brain')}>
                  Review model configuration
                </Button>
              </div>
              <div className="tm-boundary">
                <strong>Platform re-audit comes after workflow verification</strong>
                <p>
                  macOS supports approved, unverified checks. Linux depends on available isolation
                  controls. Windows production execution is not connected. These are capability
                  statements, not cross-platform certification.
                </p>
              </div>
            </section>
            <div
              id="tracemind-section-project"
              role="region"
              aria-label="Project intelligence section"
              hidden={section !== 'project'}
            >
              <ProjectIntelligencePanel
                location={selectedLocation}
                audit={audits[0]}
                auditLoading={auditLoading}
                auditing={auditing}
                picking={picking}
                onAddProject={() => void addLocalProject()}
                onRunAudit={() => void runAudit()}
              />
            </div>
            <div
              id="tracemind-section-investigations"
              role="region"
              aria-label="Issues and investigations section"
              hidden={section !== 'investigations'}
            >
              {locationId ? (
                <>
                  <div className="grid gap-6 md:grid-cols-[minmax(12rem,1fr)_2fr]">
                    <section aria-label="Issues" className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <h3 className="font-medium">Issues</h3>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => selectIssue(null)}
                          disabled={saving || loading}
                        >
                          New issue
                        </Button>
                      </div>
                      {loading ? (
                        <p className="text-sm text-foreground-muted">Loading issues…</p>
                      ) : issues.length === 0 ? (
                        <p className="text-sm text-foreground-muted">No issues yet.</p>
                      ) : (
                        issues.map((issue) => (
                          <div
                            key={issue.id}
                            className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                          >
                            <button
                              type="button"
                              disabled={saving || loading}
                              onClick={() => selectIssue(issue)}
                              aria-pressed={editing?.id === issue.id}
                              className="aria-pressed:text-primary text-left text-sm"
                            >
                              {issue.title}
                            </button>
                            <span className="text-xs text-foreground-muted">
                              {issue.status} · {issue.priority}
                            </span>
                          </div>
                        ))
                      )}
                    </section>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveIssue();
                      }}
                      className="flex flex-col gap-4 rounded-lg border border-border p-4"
                    >
                      <h3 className="font-medium">{editing ? 'Edit issue' : 'New issue'}</h3>
                      <label className="flex flex-col gap-2 text-sm">
                        Title
                        <Input
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                          maxLength={100}
                          required
                          disabled={saving || loading}
                        />
                      </label>
                      <label className="flex flex-col gap-2 text-sm">
                        Description
                        <Textarea
                          value={description}
                          onChange={(event) => setDescription(event.target.value)}
                          maxLength={20000}
                          disabled={saving || loading}
                        />
                      </label>
                      <label className="flex flex-col gap-2 text-sm">
                        Related audit
                        <select
                          aria-label="Related audit"
                          value={issueAuditId}
                          onChange={(event) => setIssueAuditId(event.target.value)}
                          disabled={saving || loading || auditLoading}
                          className="h-9 rounded-md border border-border bg-background px-2"
                        >
                          <option value="">No related audit</option>
                          {issueAuditId && !audits.some((item) => item.id === issueAuditId) && (
                            <option value={issueAuditId}>
                              Related audit unavailable — {issueAuditId}
                            </option>
                          )}
                          {audits.map((item) => (
                            <option key={item.id} value={item.id}>
                              {auditOptionLabel(item)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {issueAuditId && audits.some((item) => item.id === issueAuditId) && (
                        <div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setViewedAuditId(issueAuditId);
                              setSection('evidence');
                            }}
                          >
                            View related audit
                          </Button>
                        </div>
                      )}
                      <div>
                        <Button type="submit" disabled={saving || loading || !title.trim()}>
                          {saving ? 'Saving…' : 'Save issue'}
                        </Button>
                      </div>
                      {refreshAvailable && (
                        <div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void refreshIssueVersion()}
                            disabled={saving}
                          >
                            Refresh issue version
                          </Button>
                        </div>
                      )}
                      {reviewVersion && (
                        <div className="rounded-md border border-border p-3 text-sm">
                          <p>
                            Your draft is unchanged. Saving overwrites the latest version shown
                            below.
                          </p>
                          <p>Latest title: {reviewVersion.title}</p>
                          <p className="whitespace-pre-wrap">
                            Latest description: {reviewVersion.description || '(empty)'}
                          </p>
                          <p>Latest related audit: {reviewVersion.auditId ?? 'None'}</p>
                        </div>
                      )}
                      {editing && (
                        <section
                          aria-label="Issue investigation detail"
                          className="flex flex-col gap-4 border-t border-border pt-4"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="font-medium">Investigation detail</h4>
                            <p className="text-sm">
                              Status: {editing.status}
                              {editing.staleEvidence ? ' · evidence stale' : ''}
                            </p>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-2 text-sm">
                              Priority
                              <select
                                value={issuePriority}
                                onChange={(event) =>
                                  setIssuePriority(event.target.value as IssuePriority)
                                }
                                disabled={eventBusy}
                                className="h-9 rounded-md border border-border bg-background px-2"
                              >
                                {(['low', 'medium', 'high', 'critical'] as const).map(
                                  (priority) => (
                                    <option key={priority} value={priority}>
                                      {priority}
                                    </option>
                                  )
                                )}
                              </select>
                            </label>
                            <label className="flex flex-col gap-2 text-sm">
                              Owner
                              <Input
                                value={issueOwner}
                                onChange={(event) => setIssueOwner(event.target.value)}
                                maxLength={200}
                                disabled={eventBusy}
                              />
                            </label>
                          </div>
                          <div>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={eventBusy}
                              onClick={() => void saveIssueMetadata()}
                            >
                              Save priority and owner
                            </Button>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                            <label className="flex flex-col gap-2 text-sm">
                              Next status
                              <select
                                value={transitionTarget}
                                onChange={(event) =>
                                  setTransitionTarget(event.target.value as IssueStatus)
                                }
                                disabled={eventBusy}
                                className="h-9 rounded-md border border-border bg-background px-2"
                              >
                                {(['open', 'investigating', 'resolved'] as const).map((status) => (
                                  <option key={status} value={status}>
                                    {status}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="flex flex-col gap-2 text-sm">
                              Transition or stale-evidence rationale
                              <Input
                                value={transitionRationale}
                                onChange={(event) => setTransitionRationale(event.target.value)}
                                maxLength={5000}
                                disabled={eventBusy}
                              />
                            </label>
                            <div className="flex items-end gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                disabled={eventBusy || !transitionRationale.trim()}
                                onClick={() => void changeIssueStatus()}
                              >
                                Change status
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={
                                  eventBusy || !transitionRationale.trim() || editing.staleEvidence
                                }
                                onClick={() => void markEvidenceStale()}
                              >
                                Mark stale
                              </Button>
                            </div>
                          </div>
                          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
                            <h5 className="font-medium">Investigation phase</h5>
                            <p className="text-sm text-foreground-muted">
                              Current phase: <strong>{currentInvestigationState}</strong>. Phase
                              changes are recorded in the issue timeline; they do not resolve the
                              issue.
                            </p>
                            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
                              <label className="flex flex-col gap-2 text-sm">
                                Next phase
                                <select
                                  aria-label="Investigation next phase"
                                  value={investigationTarget}
                                  onChange={(event) =>
                                    setInvestigationTarget(
                                      event.target.value as IssueInvestigationState
                                    )
                                  }
                                  disabled={eventBusy}
                                  className="h-9 rounded-md border border-border bg-background px-2"
                                >
                                  {allowedInvestigationPhases.map((phase) => (
                                    <option key={phase} value={phase}>
                                      {phase}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="flex flex-col gap-2 text-sm">
                                Recorded check outcome (optional)
                                <select
                                  aria-label="Investigation check outcome"
                                  value={investigationOutcome}
                                  onChange={(event) =>
                                    setInvestigationOutcome(
                                      event.target.value as IssueInvestigationOutcome | ''
                                    )
                                  }
                                  disabled={eventBusy}
                                  className="h-9 rounded-md border border-border bg-background px-2"
                                >
                                  <option value="">No check outcome</option>
                                  {checkOutcomes.map((outcome) => (
                                    <option key={outcome} value={outcome}>
                                      {outcome}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="flex flex-col gap-2 text-sm">
                                Linked check run ID
                                <Input
                                  aria-label="Investigation check run ID"
                                  value={investigationRunId}
                                  onChange={(event) => setInvestigationRunId(event.target.value)}
                                  maxLength={36}
                                  disabled={eventBusy}
                                />
                              </label>
                              <div className="flex items-end">
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={
                                    eventBusy ||
                                    !transitionRationale.trim() ||
                                    !allowedInvestigationPhases.includes(investigationTarget) ||
                                    ((investigationTarget === 'verified' ||
                                      investigationTarget === 'failed') &&
                                      (!investigationOutcome || !investigationRunId.trim())) ||
                                    Boolean(investigationOutcome) !==
                                      Boolean(investigationRunId.trim())
                                  }
                                  onClick={() => void changeInvestigationPhase()}
                                >
                                  Advance phase
                                </Button>
                              </div>
                            </div>
                            <p className="text-xs text-foreground-muted">
                              “Verified” requires a linked, recorded check that is itself verified
                              and successful; a successful exit alone is insufficient.
                            </p>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                            <label className="flex flex-col gap-2 text-sm">
                              Latest graph revision reviewed
                              <Input
                                value={reviewRevision}
                                onChange={(event) => setReviewRevision(event.target.value)}
                                maxLength={128}
                                disabled={eventBusy}
                              />
                            </label>
                            <p className="self-end text-sm text-foreground-muted">
                              Clearing stale state requires an explicit review against the latest
                              stored graph revision and a rationale.
                            </p>
                            <div className="flex items-end">
                              <Button
                                type="button"
                                variant="outline"
                                disabled={
                                  eventBusy || !reviewRevision.trim() || !transitionRationale.trim()
                                }
                                onClick={() => void reviewCurrentEvidence()}
                              >
                                Mark evidence current
                              </Button>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                            <h5 className="font-medium">Append investigation event</h5>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <label className="flex flex-col gap-2 text-sm">
                                Event type
                                <select
                                  value={eventType}
                                  onChange={(event) =>
                                    setEventType(event.target.value as typeof eventType)
                                  }
                                  disabled={eventBusy}
                                  className="h-9 rounded-md border border-border bg-background px-2"
                                >
                                  {(
                                    ['observation', 'hypothesis', 'finding', 'evidence'] as const
                                  ).map((type) => (
                                    <option key={type} value={type}>
                                      {type}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {eventType === 'hypothesis' || eventType === 'finding' ? (
                                <p className="self-end text-sm text-foreground-muted">
                                  This criterion event is pinned to the issue’s saved audit snapshot
                                  {selectedIssueAudit?.revision
                                    ? ` at revision ${selectedIssueAudit.revision}`
                                    : ' (revision unavailable)'}
                                  .
                                </p>
                              ) : (
                                <label className="flex flex-col gap-2 text-sm">
                                  Graph revision (optional)
                                  <Input
                                    value={eventRevision}
                                    onChange={(event) => setEventRevision(event.target.value)}
                                    maxLength={128}
                                    disabled={eventBusy}
                                  />
                                </label>
                              )}
                            </div>
                            {eventType === 'finding' && (
                              <label className="flex flex-col gap-2 text-sm">
                                Supported hypothesis / acceptance criterion
                                <select
                                  aria-label="Finding acceptance criterion"
                                  value={findingCriterionId}
                                  onChange={(event) => setFindingCriterionId(event.target.value)}
                                  disabled={eventBusy || linkedHypotheses.length === 0}
                                  className="h-9 rounded-md border border-border bg-background px-2"
                                >
                                  <option value="">Select a persisted hypothesis</option>
                                  {linkedHypotheses.map((entry) => (
                                    <option key={entry.id} value={entry.id}>
                                      {entry.body.slice(0, 160)}
                                    </option>
                                  ))}
                                </select>
                                {linkedHypotheses.length === 0 && (
                                  <span className="text-xs text-foreground-muted">
                                    Attach an issue-linked audit with a graph revision and record a
                                    hypothesis first; revisionless criteria cannot verify the issue.
                                  </span>
                                )}
                              </label>
                            )}
                            <label className="flex flex-col gap-2 text-sm">
                              Recorded detail
                              <Textarea
                                value={eventBody}
                                onChange={(event) => setEventBody(event.target.value)}
                                maxLength={20000}
                                disabled={eventBusy}
                                required
                              />
                            </label>
                            <div>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void addIssueEvent()}
                                disabled={
                                  eventBusy ||
                                  !eventBody.trim() ||
                                  (eventType === 'finding' && !findingCriterionId)
                                }
                              >
                                Append event
                              </Button>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                            <h5 className="font-medium">Link a completed check result</h5>
                            <p className="text-sm text-foreground-muted">
                              The main process reads the terminal runner record and adds its actual
                              status, verification flag, exit code, and effective limits. A note
                              cannot change the recorded outcome.
                            </p>
                            <label className="flex flex-col gap-2 text-sm">
                              Check run ID (must belong to the issue-linked audit)
                              <Input
                                value={eventRunId}
                                onChange={(event) => setEventRunId(event.target.value)}
                                disabled={eventBusy || !issueAuditId}
                              />
                            </label>
                            <label className="flex flex-col gap-2 text-sm">
                              Hypothesis / acceptance criterion (required to mark verified)
                              <select
                                aria-label="Check acceptance criterion"
                                value={checkCriterionId}
                                onChange={(event) => setCheckCriterionId(event.target.value)}
                                disabled={eventBusy || linkedHypotheses.length === 0}
                                className="h-9 rounded-md border border-border bg-background px-2"
                              >
                                <option value="">Record without a verification criterion</option>
                                {linkedHypotheses.map((entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    {entry.body.slice(0, 160)}
                                  </option>
                                ))}
                              </select>
                              <span className="text-xs text-foreground-muted">
                                A recorded check can be used to verify this issue only when it
                                matches a persisted finding linked to the same hypothesis and audit
                                revision.
                              </span>
                              {linkedHypotheses.length === 0 && (
                                <span className="text-xs text-foreground-muted">
                                  Attach an issue-linked audit with a graph revision and record a
                                  hypothesis first; revisionless criteria cannot verify the issue.
                                </span>
                              )}
                            </label>
                            <label className="flex flex-col gap-2 text-sm">
                              Note
                              <Textarea
                                value={eventBody}
                                onChange={(event) => setEventBody(event.target.value)}
                                maxLength={20000}
                                disabled={eventBusy || !issueAuditId}
                              />
                            </label>
                            <div>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void addIssueCheckResult()}
                                disabled={
                                  eventBusy ||
                                  !issueAuditId ||
                                  !eventRunId.trim() ||
                                  !eventBody.trim()
                                }
                              >
                                Link runner result
                              </Button>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                            <h5 className="font-medium">Append issue-linked graph observation</h5>
                            <p className="text-sm text-foreground-muted">
                              Graph edges remain heuristic. This entry and its issue timeline event
                              commit together against one graph revision.
                            </p>
                            <label className="flex flex-col gap-2 text-sm">
                              Graph revision
                              <Input
                                value={graphRevision}
                                onChange={(event) => setGraphRevision(event.target.value)}
                                maxLength={128}
                                disabled={eventBusy}
                                required
                              />
                            </label>
                            <label className="flex flex-col gap-2 text-sm">
                              Observation label
                              <Input
                                value={graphLabel}
                                onChange={(event) => setGraphLabel(event.target.value)}
                                maxLength={1024}
                                disabled={eventBusy}
                                required
                              />
                            </label>
                            <label className="flex flex-col gap-2 text-sm">
                              Reason
                              <Textarea
                                value={graphReason}
                                onChange={(event) => setGraphReason(event.target.value)}
                                maxLength={4096}
                                disabled={eventBusy}
                                required
                              />
                            </label>
                            <div>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void addIssueGraphEntry()}
                                disabled={
                                  eventBusy ||
                                  !graphRevision.trim() ||
                                  !graphLabel.trim() ||
                                  !graphReason.trim()
                                }
                              >
                                Record linked observation
                              </Button>
                            </div>
                          </div>
                          <div className="rounded-md border border-border p-3">
                            <h5 className="font-medium">Append-only timeline</h5>
                            {issueEvents.length === 0 ? (
                              <p className="text-sm text-foreground-muted">No events recorded.</p>
                            ) : (
                              <ol className="mt-2 flex flex-col gap-2">
                                {issueEvents.map((entry) => {
                                  const reportEntry = investigationReport?.events.find(
                                    (candidate) => candidate.id === entry.id
                                  );
                                  return (
                                    <li
                                      key={entry.id}
                                      className="border-l-2 border-border pl-3 text-sm"
                                    >
                                      <p>
                                        {new Date(entry.createdAt).toLocaleString()} · {entry.type}
                                        {reportEntry?.stale ? ' · stale revision' : ''}
                                        {reportEntry?.revisionUnknown ? ' · revision unknown' : ''}
                                      </p>
                                      <p className="whitespace-pre-wrap">{entry.body}</p>
                                      {(entry.revision ||
                                        entry.auditId ||
                                        entry.graphNodeId ||
                                        entry.checkRunId ||
                                        reportEntry?.revisionUnknown) && (
                                        <p className="break-all text-foreground-muted">
                                          {[
                                            entry.revision
                                              ? `revision ${entry.revision}`
                                              : reportEntry?.revisionUnknown
                                                ? 'revision unknown'
                                                : '',
                                            entry.auditId ? `audit ${entry.auditId}` : '',
                                            entry.graphNodeId ? `graph ${entry.graphNodeId}` : '',
                                            entry.checkRunId ? `check ${entry.checkRunId}` : '',
                                            entry.criterionId
                                              ? `criterion ${entry.criterionId}`
                                              : '',
                                          ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                        </p>
                                      )}
                                    </li>
                                  );
                                })}
                              </ol>
                            )}
                          </div>
                          <section
                            aria-label="Investigation report"
                            className="rounded-md border border-border p-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <h5 className="font-medium">Revision-aware investigation report</h5>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={eventBusy}
                                onClick={() => void refreshInvestigationReport()}
                              >
                                Refresh report
                              </Button>
                            </div>
                            <p className="text-sm text-foreground-muted">
                              A recorded check outcome is not issue resolution; stale evidence and
                              incomplete coverage remain explicit.
                            </p>
                            {investigationReport ? (
                              <>
                                <p role="status" className="mt-2 text-sm">
                                  Linked audit{' '}
                                  {investigationReport.auditFreshness?.auditId ?? '(not linked)'}:{' '}
                                  {investigationReport.auditFreshness?.state ?? 'unknown'}
                                  {investigationReport.auditFreshness?.stale === true
                                    ? ' · stale; run a new audit'
                                    : investigationReport.auditFreshness?.stale === null ||
                                        !investigationReport.auditFreshness
                                      ? ' · freshness unknown'
                                      : ' · no change recorded so far'}
                                </p>
                                <pre className="mt-2 max-h-96 overflow-auto text-sm whitespace-pre-wrap">
                                  {investigationReport.markdown}
                                </pre>
                              </>
                            ) : (
                              <p className="text-sm text-foreground-muted">Generating report…</p>
                            )}
                          </section>
                        </section>
                      )}
                    </form>
                  </div>
                  <section
                    aria-label="AI investigation"
                    className="mt-6 flex flex-col gap-4 rounded-lg border border-border p-4"
                  >
                    <h3 className="font-medium">AI investigation</h3>
                    <p className="text-sm text-foreground-muted">
                      Uses the central TraceMind brain and this project's sharing policy. Configure
                      it in TraceMind brain.
                    </p>
                    {editing ? (
                      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void generateAIInvestigation()}
                          disabled={!aiProvider?.configured || aiGenerating || aiBusy || eventBusy}
                        >
                          {aiGenerating ? 'Investigating…' : 'Generate AI investigation'}
                        </Button>
                        <span className="text-sm text-foreground-muted">
                          Sends this task and approved metadata through the central brain policy
                          only when you click Generate. Source contents remain local.
                        </span>
                      </div>
                    ) : (
                      <p className="border-t border-border pt-4 text-sm text-foreground-muted">
                        Select or create an issue to generate an AI investigation.
                      </p>
                    )}
                    {aiError && (
                      <p role="alert" className="text-sm text-destructive">
                        {aiError}
                      </p>
                    )}
                    {aiInvestigation && (
                      <article
                        aria-label="Generated AI investigation"
                        className="flex flex-col gap-3 rounded-md border border-border p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="font-medium">AI-generated investigation · advisory</h4>
                          <span className="text-xs text-foreground-muted">
                            {aiInvestigation.model} ·{' '}
                            {new Date(aiInvestigation.generatedAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm text-foreground-muted">
                          Suggestions are not proof of runtime behavior, a verified check, or issue
                          resolution. Review the cited evidence and freshness before acting.
                        </p>
                        <div>
                          <h5 className="font-medium">Summary</h5>
                          <p className="text-sm whitespace-pre-wrap">{aiInvestigation.summary}</p>
                          <EvidenceCitationList
                            ids={aiInvestigation.summaryEvidenceIds}
                            references={aiInvestigation.evidenceReferences}
                          />
                        </div>
                        <div>
                          <h5 className="font-medium">Ranked hypotheses</h5>
                          {aiInvestigation.hypotheses.length ? (
                            <ol className="mt-2 flex list-decimal flex-col gap-3 pl-5">
                              {aiInvestigation.hypotheses.map((hypothesis) => (
                                <li key={`${hypothesis.rank}-${hypothesis.statement}`}>
                                  <p className="text-sm font-medium">
                                    {hypothesis.statement}{' '}
                                    <span className="font-normal text-foreground-muted">
                                      · {hypothesis.confidence} confidence
                                    </span>
                                  </p>
                                  <p className="text-sm whitespace-pre-wrap text-foreground-muted">
                                    {hypothesis.rationale}
                                  </p>
                                  <EvidenceCitationList
                                    ids={hypothesis.evidenceIds}
                                    references={aiInvestigation.evidenceReferences}
                                  />
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <p className="text-sm text-foreground-muted">
                              No hypotheses were returned.
                            </p>
                          )}
                        </div>
                        <div>
                          <h5 className="font-medium">Ranked recommendations</h5>
                          {aiInvestigation.recommendations.length ? (
                            <ol className="mt-2 flex list-decimal flex-col gap-3 pl-5">
                              {aiInvestigation.recommendations.map((recommendation) => (
                                <li key={`${recommendation.rank}-${recommendation.action}`}>
                                  <p className="text-sm font-medium">{recommendation.action}</p>
                                  <p className="text-sm whitespace-pre-wrap text-foreground-muted">
                                    {recommendation.rationale}
                                  </p>
                                  <EvidenceCitationList
                                    ids={recommendation.evidenceIds}
                                    references={aiInvestigation.evidenceReferences}
                                  />
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <p className="text-sm text-foreground-muted">
                              No recommendations were returned.
                            </p>
                          )}
                        </div>
                        <div className="text-sm">
                          <p role="status">
                            Evidence freshness: {aiInvestigation.freshness}; revision:{' '}
                            {aiInvestigation.evidenceRevision ?? 'unknown'}
                          </p>
                          {aiInvestigation.limitations.length > 0 && (
                            <ul className="mt-1 list-disc pl-5 text-foreground-muted">
                              {aiInvestigation.limitations.map((limitation) => (
                                <li key={limitation}>{limitation}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </article>
                    )}
                  </section>
                </>
              ) : (
                <TraceMindPrerequisite
                  title="Issues & investigations"
                  message="Select or add a local project to create issues and work through their investigation phases."
                  picking={picking}
                  onAddProject={() => void addLocalProject()}
                />
              )}
            </div>
            <div
              id="tracemind-section-evidence"
              role="region"
              aria-label="Evidence collection section"
              hidden={section !== 'evidence'}
            >
              {locationId ? (
                <section
                  aria-label="Project audit"
                  className="flex flex-col gap-4 rounded-lg border border-border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-medium">Project audit</h3>
                      <p className="text-sm text-foreground-muted">
                        Inspect eligible files on this device after approval.
                      </p>
                    </div>
                    <Button
                      type="button"
                      onClick={() => void runAudit()}
                      disabled={auditing || auditLoading || saving}
                    >
                      {auditing ? 'Auditing…' : 'Run audit'}
                    </Button>
                  </div>
                  {auditMessage && (
                    <p role="status" className="text-sm text-foreground-muted">
                      {auditMessage}
                    </p>
                  )}
                  {auditLoading ? (
                    <p className="text-sm text-foreground-muted">Loading audit history…</p>
                  ) : audits.length === 0 ? (
                    <p className="text-sm text-foreground-muted">No audits yet.</p>
                  ) : (
                    <>
                      <label className="flex flex-col gap-2 text-sm">
                        Audit to inspect
                        <select
                          aria-label="Audit to inspect"
                          value={viewedAuditId || audits[0]?.id}
                          onChange={(event) => setViewedAuditId(event.target.value)}
                          className="h-9 rounded-md border border-border bg-background px-2"
                        >
                          {audits.map((item) => (
                            <option key={item.id} value={item.id}>
                              {auditOptionLabel(item)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <AuditDetails
                        key={`${locationId}:${selectedAudit?.id}`}
                        audit={selectedAudit}
                        previous={
                          audits[
                            Math.max(
                              0,
                              audits.findIndex((item) => item.id === selectedAudit?.id)
                            ) + 1
                          ]
                        }
                      />
                    </>
                  )}
                </section>
              ) : (
                <TraceMindPrerequisite
                  title="Evidence collection"
                  message="Select or add a local project before capturing an approved audit snapshot and file evidence."
                  picking={picking}
                  onAddProject={() => void addLocalProject()}
                />
              )}
            </div>
            <div
              id="tracemind-section-checks"
              role="region"
              aria-label="Check discovery and execution section"
              hidden={section !== 'checks'}
            >
              {!locationId ? (
                <TraceMindPrerequisite
                  title="Check discovery & execution"
                  message="Select or add a local project, then capture an audit before discovering its fixed check recipes."
                  picking={picking}
                  onAddProject={() => void addLocalProject()}
                />
              ) : auditLoading ? (
                <p className="rounded-lg border border-border p-6 text-sm text-foreground-muted">
                  Loading project audits before check discovery…
                </p>
              ) : !selectedAudit ? (
                <section className="rounded-lg border border-border p-4">
                  <h3 className="font-medium">Check discovery & execution</h3>
                  <p className="mt-2 text-sm text-foreground-muted">
                    Capture a project audit first. Discovery identifies supported recipes and never
                    starts a command; each run requires separate approval.
                  </p>
                  <Button
                    type="button"
                    className="mt-3"
                    disabled={auditing || saving}
                    onClick={() => void runAudit()}
                  >
                    {auditing ? 'Auditing…' : 'Run project audit'}
                  </Button>
                  {auditMessage && (
                    <p role="status" className="mt-2 text-sm">
                      {auditMessage}
                    </p>
                  )}
                </section>
              ) : (
                <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
                  <div>
                    <h3 className="font-medium">Check discovery & execution</h3>
                    <p className="text-sm text-foreground-muted">
                      Discovery, proposal approval, and command execution are separate steps. A
                      completed check is not proof that an issue is resolved.
                    </p>
                  </div>
                  <label className="flex max-w-xl flex-col gap-2 text-sm">
                    Audit used for check discovery
                    <select
                      aria-label="Check audit"
                      value={selectedAudit.id}
                      onChange={(event) => setViewedAuditId(event.target.value)}
                      className="h-9 rounded-md border border-border bg-background px-2"
                    >
                      {audits.map((item) => (
                        <option key={item.id} value={item.id}>
                          {auditOptionLabel(item)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <AuditAnalysisFreshness
                    context="Check discovery source"
                    analysisVersion={selectedAudit.analysisVersion}
                  />
                  {section === 'checks' && (
                    <CheckDiscoveryPanel
                      key={`checks:${locationId}:${selectedAudit.id}`}
                      locationId={locationId}
                      auditId={selectedAudit.id}
                      analysisVersion={selectedAudit.analysisVersion}
                    />
                  )}
                </section>
              )}
            </div>
            <div
              id="tracemind-section-graph"
              role="region"
              aria-label="Evidence graph section"
              hidden={section !== 'graph' && section !== 'notes'}
            >
              {!locationId ? (
                <TraceMindPrerequisite
                  title="Evidence graph"
                  message="Select or add a local project and run an audit to build a bounded evidence graph."
                  picking={picking}
                  onAddProject={() => void addLocalProject()}
                />
              ) : auditLoading ? (
                <p className="rounded-lg border border-border p-6 text-sm text-foreground-muted">
                  Loading project audits before loading the evidence graph…
                </p>
              ) : selectedAudit ? (
                <GraphPanel
                  graphical={section === 'notes'}
                  onOpenNotes={() => setSection('notes')}
                  key={`graph:${locationId}:${selectedAudit.id}`}
                  locationId={locationId}
                  revision={`audit:${selectedAudit.id}`}
                  analysisVersion={selectedAudit.analysisVersion}
                  coverage={selectedAudit.inventory.graphCoverage}
                  filesParsed={selectedAudit.inventory.filesParsed}
                  filesDiscovered={selectedAudit.inventory.filesDiscovered}
                />
              ) : (
                <TraceMindPrerequisite
                  title="Evidence graph"
                  message="Run an approved project audit to create the evidence graph for inspection."
                  picking={picking}
                  onAddProject={() => void addLocalProject()}
                  onRunAudit={() => void runAudit()}
                />
              )}
            </div>
            <div
              id="tracemind-section-runtime"
              role="region"
              aria-label="Runtime intelligence and monitoring section"
              hidden={section !== 'runtime'}
            >
              {!locationId ? (
                <TraceMindPrerequisite
                  title="Runtime intelligence"
                  message="Select or add a local project before starting a loopback telemetry receiver or comparing its audit snapshots."
                  picking={picking}
                  onAddProject={() => void addLocalProject()}
                />
              ) : auditLoading ? (
                <p className="rounded-lg border border-border p-6 text-sm text-foreground-muted">
                  Loading audit snapshots before runtime monitoring…
                </p>
              ) : selectedAudit ? (
                <RuntimeIntelligencePanel
                  key={`runtime:${locationId}:${selectedAudit.id}`}
                  locationId={locationId}
                  audit={selectedAudit}
                  audits={audits}
                  providerConfigured={aiProvider?.configured === true}
                />
              ) : (
                <section className="rounded-lg border border-border p-4">
                  <h3 className="font-medium">Runtime intelligence</h3>
                  <p className="mt-2 text-sm text-foreground-muted">
                    Run a project audit first. Telemetry is attached to the selected audit revision
                    and is never used to rewrite a project snapshot.
                  </p>
                  <Button
                    type="button"
                    className="mt-3"
                    disabled={auditing || saving}
                    onClick={() => void runAudit()}
                  >
                    {auditing ? 'Auditing…' : 'Run project audit'}
                  </Button>
                </section>
              )}
            </div>
            <div
              id="tracemind-section-local-first"
              role="region"
              aria-label="Local-first section"
              hidden={section !== 'local-first'}
            >
              <LocalFirstSection location={selectedLocation} audit={audits[0]} />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

export const tracemindView = {
  TitlebarSlot: Titlebar,
  MainPanel: TraceMindMainPanel,
  worksWithoutServer: true,
};

function TraceMindPrerequisite({
  title,
  message,
  picking,
  onAddProject,
  onRunAudit,
}: {
  title: string;
  message: string;
  picking: boolean;
  onAddProject: () => void;
  onRunAudit?: () => void;
}) {
  return (
    <section className="rounded-lg border border-border p-4" aria-label={`${title} setup`}>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-2 max-w-3xl text-sm text-foreground-muted">{message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={picking} onClick={onAddProject}>
          {picking ? 'Selecting…' : 'Add local project'}
        </Button>
        {onRunAudit && (
          <Button type="button" variant="outline" onClick={onRunAudit}>
            Run project audit
          </Button>
        )}
      </div>
    </section>
  );
}

function ProjectIntelligencePanel({
  location,
  audit,
  auditLoading,
  auditing,
  picking,
  onAddProject,
  onRunAudit,
}: {
  location: Location | null;
  audit: AuditRecord | undefined;
  auditLoading: boolean;
  auditing: boolean;
  picking: boolean;
  onAddProject: () => void;
  onRunAudit: () => void;
}) {
  if (!location) {
    return (
      <TraceMindPrerequisite
        title="Project intelligence"
        message="Select or add a local project to see its identity, revisions, detected languages, manifests, and dependency coverage."
        picking={picking}
        onAddProject={onAddProject}
      />
    );
  }
  const dependencyInventory = audit?.inventory.dependencyInventory;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div>
        <h3 className="font-medium">Project intelligence</h3>
        <p className="text-sm text-foreground-muted">
          Local project identity and the latest captured inventory.
        </p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs text-foreground-muted">Project</dt>
          <dd className="mt-1 text-sm font-medium break-words">{location.name}</dd>
        </div>
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs text-foreground-muted">Local directory</dt>
          <dd className="mt-1 text-sm break-all">{location.dir}</dd>
        </div>
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs text-foreground-muted">Latest audit</dt>
          <dd className="mt-1 text-sm">
            {audit
              ? new Date(audit.capturedAt).toLocaleString()
              : auditLoading
                ? 'Loading…'
                : 'Not audited yet'}
          </dd>
        </div>
        {audit && (
          <>
            <div
              className="rounded-md border border-border p-3"
              data-analysis-stale={auditNeedsRefresh(audit.analysisVersion) ? 'true' : 'false'}
            >
              <dt className="text-xs text-foreground-muted">Analysis freshness</dt>
              <dd className="mt-1 text-sm">{auditAnalysisLabel(audit.analysisVersion)}</dd>
              {auditNeedsRefresh(audit.analysisVersion) && (
                <dd className="mt-1 text-xs text-foreground-muted">
                  A matching fingerprint does not update saved language, manifest, dependency, or
                  graph analysis. Run a new approved audit to refresh this metadata.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={auditing || auditLoading}
                    onClick={onRunAudit}
                  >
                    {auditing ? 'Auditing…' : 'Run audit to refresh'}
                  </Button>
                </dd>
              )}
            </div>
            <div className="rounded-md border border-border p-3">
              <dt className="text-xs text-foreground-muted">Inventory</dt>
              <dd className="mt-1 text-sm">
                {audit.inventory.filesDiscovered} files inventoried · {audit.inventory.filesParsed}/
                {audit.inventory.filesDiscovered} parsed · {audit.inventory.skipped} skipped
              </dd>
              <dd className="mt-1 text-xs text-foreground-muted">
                Inventory traversal {audit.inventory.inventoryComplete ? 'complete' : 'incomplete'}
                {' · Graph extraction: '}
                {audit.inventory.graphCoverage
                  ? `${audit.inventory.graphCoverage.status}; ${audit.inventory.graphCoverage.omittedFiles} ${audit.inventory.graphCoverage.omittedFiles === 1 ? 'file' : 'files'} omitted`
                  : 'not recorded'}
              </dd>
            </div>
            <div className="rounded-md border border-border p-3">
              <dt className="text-xs text-foreground-muted">Source context</dt>
              <dd className="mt-1 text-sm break-words">
                Revision {audit.revision ?? 'unknown'} ·{' '}
                {audit.dirty === null ? 'working tree unknown' : audit.dirty ? 'dirty' : 'clean'}
              </dd>
              <dd className="mt-1 text-xs text-foreground-muted">
                {audit.inventory.languages.length
                  ? audit.inventory.languages
                      .map((item) => `${item.language} (${item.files})`)
                      .join(', ')
                  : 'No languages detected in this audit.'}
              </dd>
            </div>
            <div className="rounded-md border border-border p-3">
              <dt className="text-xs text-foreground-muted">Dependency inventory</dt>
              <dd className="mt-1 text-sm">
                {dependencyInventory
                  ? `${dependencyInventory.status} · ${dependencyInventory.packages.length} packages · ${dependencyInventory.edges.length} edges`
                  : 'Unavailable in this audit'}
              </dd>
              <dd className="mt-1 text-xs break-words text-foreground-muted">
                {dependencyInventory?.ecosystems.length
                  ? `Ecosystems: ${dependencyInventory.ecosystems.join(', ')}`
                  : 'No supported dependency ecosystem captured.'}
              </dd>
            </div>
            <div className="rounded-md border border-border p-3 sm:col-span-2 xl:col-span-3">
              <dt className="text-xs text-foreground-muted">Project manifests</dt>
              <dd className="mt-1 text-sm break-all">
                {audit.inventory.manifests.length
                  ? audit.inventory.manifests.join(', ')
                  : 'No supported manifests captured.'}
              </dd>
            </div>
          </>
        )}
      </dl>
      {!audit && !auditLoading && (
        <div>
          <p className="text-sm text-foreground-muted">
            Run an approved audit to populate the project inventory.
          </p>
          <Button type="button" className="mt-3" disabled={auditing} onClick={onRunAudit}>
            {auditing ? 'Auditing…' : 'Run project audit'}
          </Button>
        </div>
      )}
    </section>
  );
}

function LocalFirstSection({
  location,
  audit,
}: {
  location: Location | null;
  audit: AuditRecord | undefined;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div>
        <h3 className="font-medium">Local-first architecture</h3>
        <p className="text-sm text-foreground-muted">
          TraceMind sections remain inspectable while the optional Switch server is stopped.
        </p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <dt className="font-medium">Server dependency</dt>
          <dd className="mt-1 text-sm text-foreground-muted">
            A running Switch server is not required to open TraceMind or read its local records.
          </dd>
        </div>
        <div className="rounded-md border border-border p-3">
          <dt className="font-medium">Local records</dt>
          <dd className="mt-1 text-sm text-foreground-muted">
            Project audits, evidence, graph snapshots, issue timelines, and check results use the
            desktop application's local database.
          </dd>
        </div>
        <div className="rounded-md border border-border p-3">
          <dt className="font-medium">Approvals and runtime</dt>
          <dd className="mt-1 text-sm text-foreground-muted">
            Approvals are one-use in-memory grants and are not saved across application restarts.
            Project inspection and check execution are separate approved actions. Checks depend on
            installed local tools and host isolation capabilities; results remain unverified when
            required controls cannot be confirmed.
          </dd>
        </div>
      </dl>
      <p className="text-sm text-foreground-muted">
        {location
          ? `Selected local project: ${location.name} — ${location.dir}`
          : 'No local project is selected. Choose a project to load its records.'}
        {audit ? ` Latest audit: ${new Date(audit.capturedAt).toLocaleString()}.` : ''}
      </p>
    </section>
  );
}

type RuntimeReceiverStatus = {
  active: boolean;
  endpoint: string | null;
  startedAt: number | null;
  auditId: string | null;
};

function RuntimeIntelligencePanel({
  locationId,
  audit,
  audits,
  providerConfigured,
}: {
  locationId: string;
  audit: AuditRecord;
  audits: AuditRecord[];
  providerConfigured: boolean;
}) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [runtimeAISettings, setRuntimeAISettings] = useState<TraceMindRuntimeAISettings | null>(
    null
  );
  const [receiver, setReceiver] = useState<RuntimeReceiverStatus | null>(null);
  const [sessionToken, setSessionToken] = useState('');
  const [jaegerJson, setJaegerJson] = useState('');
  const [previousAuditId, setPreviousAuditId] = useState(
    audits.find((item) => item.id !== audit.id)?.id ?? ''
  );
  const [comparison, setComparison] = useState<EvidenceComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const [nextSnapshot, nextReceiver] = await Promise.all([
          rpc.tracemind.getRuntimeSignals(locationId, audit.id),
          rpc.tracemind.getRuntimeReceiverStatus(locationId),
        ]);
        const nextAISettings = await rpc.tracemind.getRuntimeAISettings(locationId, audit.id);
        if (!active) return;
        setSnapshot(nextSnapshot);
        setReceiver(nextReceiver);
        setRuntimeAISettings(nextAISettings);
      } catch {
        if (active)
          setMessage(
            'Could not load local runtime evidence. Retry after refreshing the audit list.'
          );
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [locationId, audit.id]);

  useEffect(() => {
    setPreviousAuditId((current) =>
      current && current !== audit.id && audits.some((item) => item.id === current)
        ? current
        : (audits.find((item) => item.id !== audit.id)?.id ?? '')
    );
    setComparison(null);
  }, [audit.id, audits]);

  async function start(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await rpc.tracemind.startRuntimeReceiver(locationId, audit.id);
      setReceiver({
        active: result.active,
        endpoint: result.endpoint,
        startedAt: result.startedAt,
        auditId: result.auditId,
      });
      setSessionToken(result.token);
      setMessage(
        'Receiver started on loopback. Telemetry is accepted only from a local exporter with this temporary token.'
      );
    } catch {
      setMessage('Could not start the local receiver. Verify that this audit is still available.');
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      setReceiver(await rpc.tracemind.stopRuntimeReceiver(locationId));
      setSessionToken('');
      setMessage('Receiver stopped. Previously ingested local evidence remains saved.');
    } catch {
      setMessage('Could not stop the local receiver.');
    } finally {
      setBusy(false);
    }
  }

  async function setRuntimeAI(enabled: boolean): Promise<void> {
    if (busy || !providerConfigured) return;
    setBusy(true);
    setMessage('');
    try {
      const settings = await rpc.tracemind.setRuntimeAIEnabled(locationId, audit.id, enabled);
      setRuntimeAISettings(settings);
      setMessage(
        enabled
          ? 'Runtime incident analysis enabled. Only newly received, bounded incident summaries are sent to the saved provider.'
          : settings.statusUnavailable
            ? 'Runtime incident analysis disabled and queued requests canceled. Saved advisory status could not be loaded; refresh to retry.'
            : 'Runtime incident analysis disabled. Queued and in-flight analyses were canceled.'
      );
    } catch {
      if (enabled) {
        setMessage(
          'Runtime AI was not enabled. Check the saved provider and secure key storage, then retry; local telemetry monitoring is unchanged.'
        );
      } else {
        setRuntimeAISettings((current) => (current ? { ...current, enabled: false } : current));
        setMessage(
          'Runtime AI was paused for this session and queued requests were canceled, but the opt-out could not be saved. Retry before restarting.'
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function importJaeger(): Promise<void> {
    if (busy || !jaegerJson.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await rpc.tracemind.importJaegerTelemetry(locationId, audit.id, jaegerJson);
      setSnapshot(result.snapshot);
      setJaegerJson('');
      setMessage(
        `Imported ${result.importedCount} Jaeger span(s); ${result.rejectedCount} malformed, duplicate, or over-limit span(s) were not retained.`
      );
    } catch {
      setMessage(
        'Jaeger JSON was not imported. Check the Jaeger trace response format and 2 MiB limit.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function compareSnapshots(): Promise<void> {
    if (busy || !previousAuditId || previousAuditId === audit.id) return;
    setBusy(true);
    setMessage('');
    try {
      setComparison(
        await rpc.tracemind.compareAuditEvidence(locationId, previousAuditId, audit.id)
      );
    } catch {
      setMessage('Could not compare these audit snapshots. Both audits must be available.');
    } finally {
      setBusy(false);
    }
  }

  const tokenExport = sessionToken
    ? `POST ${receiver?.endpoint ?? ''}/v1/traces\nAuthorization: Bearer ${sessionToken}\nContent-Type: application/json`
    : '';

  return (
    <section
      aria-label="Runtime intelligence"
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
    >
      <div>
        <h3 className="font-medium">Runtime intelligence and monitoring</h3>
        <p className="text-sm text-foreground-muted">
          Runtime data is locally retained and tied to audit <code>{audit.id}</code> at revision{' '}
          <code>{audit.fingerprint ?? audit.revision ?? 'unknown'}</code>. It supplements static
          evidence and does not establish root cause.
        </p>
      </div>

      <section
        aria-label="Local OpenTelemetry receiver"
        className="rounded-md border border-border p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="font-medium">OpenTelemetry receiver</h4>
            <p role="status" className="text-sm text-foreground-muted">
              {receiver?.active
                ? `Listening on this Mac only · ${receiver.endpoint} · audit ${receiver.auditId ?? 'unknown'}`
                : 'Stopped · no process telemetry is being collected'}
            </p>
          </div>
          {receiver?.active ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void stop()}
            >
              Stop receiver
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : 'Start local receiver'}
            </Button>
          )}
        </div>
        <p className="mt-2 text-sm text-foreground-muted">
          Starting is explicit. The listener binds only to <code>127.0.0.1</code>, requires a
          temporary bearer token, rejects browser-origin and compressed requests, and stops when
          Canary exits. OTLP JSON routes are <code>/v1/traces</code>, <code>/v1/logs</code>, and{' '}
          <code>/v1/metrics</code>. The approved project file watcher separately marks snapshots
          stale after observed changes.
        </p>
        {receiver?.active && sessionToken && (
          <div className="mt-3 rounded border border-border p-3">
            <p className="text-sm font-medium">Temporary receiver configuration</p>
            <p className="text-xs text-foreground-muted">
              The bearer token is held in memory and shown only for this live session. Do not commit
              it.
            </p>
            <pre
              aria-label="Telemetry endpoint and bearer token"
              className="bg-muted/30 mt-2 overflow-auto rounded p-2 text-xs break-all whitespace-pre-wrap"
            >
              {tokenExport}
            </pre>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const clipboard = navigator.clipboard;
                if (!clipboard) {
                  setMessage('Copy is unavailable; select and copy the configuration above.');
                  return;
                }
                void clipboard
                  .writeText(tokenExport)
                  .then(() => setMessage('Receiver configuration copied.'))
                  .catch(() =>
                    setMessage('Copy is unavailable; select and copy the configuration above.')
                  );
              }}
            >
              Copy configuration
            </Button>
          </div>
        )}
      </section>

      <section aria-label="Jaeger trace import" className="rounded-md border border-border p-3">
        <h4 className="font-medium">Import Jaeger trace JSON</h4>
        <p className="text-sm text-foreground-muted">
          Paste a Jaeger query response with <code>data</code> traces. Spans are normalized,
          redacted, deduplicated, and linked to this audit.
        </p>
        <Textarea
          aria-label="Jaeger JSON payload"
          className="mt-2 min-h-24"
          maxLength={2 * 1024 * 1024}
          value={jaegerJson}
          onChange={(event) => setJaegerJson(event.target.value)}
          placeholder='{"data":[{"traceID":"…","spans":[],"processes":{}}]}'
        />
        <Button
          type="button"
          className="mt-2"
          variant="outline"
          disabled={busy || !jaegerJson.trim()}
          onClick={() => void importJaeger()}
        >
          Import Jaeger JSON
        </Button>
      </section>

      <section aria-label="Runtime incidents" className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">Correlated runtime signals</h4>
          <span className="text-xs text-foreground-muted">
            {snapshot?.signals.length ?? 0} retained · {snapshot?.acceptedCount ?? 0} accepted total
            · {snapshot?.droppedCount ?? 0} deduplicated/rejected/evicted
          </span>
        </div>
        <p className="text-xs text-foreground-muted">
          {snapshot?.truncated ? 'Retention is bounded; older or excess signals are omitted. ' : ''}
          Trace IDs, five-minute service windows, and 5× metric-vs-prior-median screening group
          signals only; review source records before drawing conclusions.
        </p>
        {!snapshot?.incidents.length ? (
          <p className="mt-2 text-sm text-foreground-muted">
            No error groups or metric deviations detected in retained signals.
          </p>
        ) : (
          <ul aria-label="Runtime incident candidates" className="mt-2 space-y-2">
            {snapshot.incidents.map((incident) => (
              <li key={incident.id} className="rounded border border-border p-2">
                <p className="font-medium">
                  {incident.severity.toUpperCase()} · {incident.title}
                </p>
                <p className="text-sm">
                  {incident.serviceName} · {incident.signalCount} signal(s) ·{' '}
                  {new Date(incident.lastSeenAt).toLocaleString()}
                </p>
                <p className="text-xs text-foreground-muted">{incident.explanation}</p>
                <ul className="mt-1 list-disc pl-5 text-xs text-foreground-muted">
                  {snapshot.signals
                    .filter((signal) => incident.signalIds.includes(signal.id))
                    .slice(0, 5)
                    .map((signal) => (
                      <li key={signal.id}>
                        {signal.kind} · {signal.name}
                        {signal.message ? ` · ${signal.message}` : ''}
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <h5 className="mt-3 text-sm font-medium">Latest signals</h5>
        <ul aria-label="Latest runtime signals" className="max-h-64 overflow-y-auto text-xs">
          {[...(snapshot?.signals ?? [])]
            .reverse()
            .slice(0, 50)
            .map((signal) => (
              <li key={signal.id} className="border-b border-border py-1 break-words">
                {new Date(signal.observedAt).toLocaleString()} · {signal.kind} ·{' '}
                {signal.serviceName} · {signal.name}
                {signal.severity ? ` · ${signal.severity}` : ''}
                {signal.value !== undefined
                  ? ` · ${signal.value}${signal.unit ? ` ${signal.unit}` : ''}`
                  : ''}
                {signal.message ? ` · ${signal.message}` : ''}
              </li>
            ))}
        </ul>
      </section>

      <section aria-label="Runtime AI analysis" className="rounded-md border border-border p-3">
        <div className="flex flex-col gap-2">
          <h4 className="font-medium">Model-assisted incident review</h4>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Send new runtime incident summaries to the configured AI provider"
              checked={runtimeAISettings?.enabled ?? false}
              disabled={busy || !providerConfigured || runtimeAISettings === null}
              onChange={(event) => void setRuntimeAI(event.target.checked)}
            />
            <span>
              Send newly observed incident summaries to the configured provider for advisory
              analysis. This is a separate opt-in from local telemetry collection.
            </span>
          </label>
          <p className="text-xs text-foreground-muted">
            The provider receives at most 10 new incident summaries per request, with at least 60
            seconds between requests. Raw logs, span messages, metric attributes, trace IDs, and
            source code are excluded. Existing incidents are treated as baseline when enabled.
            Disabling cancels queued and in-flight analysis requests. The queue holds up to 100
            incident groups; additional groups beyond that bound are not forwarded automatically.
          </p>
          {!providerConfigured && (
            <p className="text-sm text-foreground-muted">
              Save an AI provider in the issue investigation panel before enabling model analysis.
            </p>
          )}
          {runtimeAISettings?.lastFailureAt !== null &&
            runtimeAISettings?.lastFailureAt !== undefined && (
              <p role="alert" className="text-sm text-destructive">
                Last automatic AI analysis failed at{' '}
                {new Date(runtimeAISettings.lastFailureAt).toLocaleString()}. No provider error
                details were stored; check the saved endpoint and connection.
              </p>
            )}
          {runtimeAISettings?.latestAdvisory && (
            <RuntimeAIAdvisoryCard advisory={runtimeAISettings.latestAdvisory} />
          )}
        </div>
      </section>

      <section
        aria-label="Audit snapshot comparison"
        className="rounded-md border border-border p-3"
      >
        <h4 className="font-medium">Project snapshot comparison</h4>
        <p className="text-sm text-foreground-muted">
          Run a new audit to capture the second snapshot, then compare its file fingerprints against
          an earlier audit.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex min-w-64 flex-col gap-1 text-sm">
            Earlier audit
            <select
              aria-label="Earlier audit snapshot"
              value={previousAuditId}
              onChange={(event) => setPreviousAuditId(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2"
            >
              <option value="">Select an earlier audit</option>
              {audits
                .filter((item) => item.id !== audit.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {auditOptionLabel(item)}
                  </option>
                ))}
            </select>
          </label>
          <p className="text-sm">Current: {auditOptionLabel(audit)}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !previousAuditId || previousAuditId === audit.id}
            onClick={() => void compareSnapshots()}
          >
            Compare snapshots
          </Button>
        </div>
        {comparison?.status === 'compared' && (
          <div role="status" className="mt-2 text-sm">
            <p>
              {comparison.counts.added} added · {comparison.counts.changed} changed ·{' '}
              {comparison.counts.removed} removed
              {comparison.truncated ? ' · path list truncated' : ''}
            </p>
            <ul className="max-h-40 overflow-auto text-xs">
              {comparison.items.slice(0, 100).map((item) => (
                <li key={`${item.change}:${item.path}`}>
                  <code>{item.change}</code> · {item.path}
                </li>
              ))}
            </ul>
          </div>
        )}
        {comparison?.status === 'unavailable' && (
          <p role="status" className="mt-2 text-sm">
            Snapshot comparison is unavailable for these audits.
          </p>
        )}
      </section>

      {message && (
        <p role="status" aria-live="polite" className="text-sm text-foreground-muted">
          {message}
        </p>
      )}
    </section>
  );
}

function RuntimeAIAdvisoryCard({ advisory }: { advisory: TraceMindRuntimeAIAdvisory }) {
  return (
    <article
      aria-label="Latest runtime AI advisory"
      className="rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="font-medium">Advisory · {advisory.model}</h5>
        <span className="text-xs text-foreground-muted">
          {new Date(advisory.generatedAt).toLocaleString()}
        </span>
      </div>
      <p className="mt-2 text-sm whitespace-pre-wrap">{advisory.summary}</p>
      <p className="mt-2 text-xs text-foreground-muted">
        {advisory.incidentIds.length} locally correlated incident(s) · evidence revision{' '}
        {advisory.evidenceRevision ?? 'unknown'} · advisory only; this is not proof of a threat,
        root cause, or remediation.
      </p>
      <ol className="mt-2 list-decimal pl-5 text-sm">
        {advisory.recommendations.map((item) => (
          <li key={`${item.rank}-${item.action}`}>{item.action}</li>
        ))}
      </ol>
    </article>
  );
}

function AuditMonitorPanel({ locationId, auditId }: { locationId: string; auditId: string }) {
  const [status, setStatus] = useState<AuditMonitorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const next = await rpc.tracemind.getAuditMonitorStatus(locationId, auditId);
        if (active) setStatus(next);
      } catch {
        if (active) setMessage('Could not read live-monitor status.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
      // Navigation only releases the UI subscription. The main process owns the watcher.
      // Stop is an explicit user action (or application shutdown), not a view lifecycle effect.
    };
  }, [locationId, auditId]);

  async function start(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const next = await rpc.tracemind.startAuditMonitor(locationId, auditId);
      setStatus(next);
      setMessage(
        next.active ? 'Monitoring started after approval.' : 'Monitoring was not started.'
      );
    } catch {
      setMessage(
        'Could not start monitoring. Confirm the selected project still matches this audit.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      setStatus(await rpc.tracemind.stopAuditMonitor(locationId, auditId));
      setMessage('Monitoring stopped. Run a new audit to establish a fresh snapshot.');
    } catch {
      setMessage('Could not stop monitoring.');
    } finally {
      setBusy(false);
    }
  }

  const invalidation = status?.invalidation ?? null;
  const freshness = invalidation
    ? invalidation.stale
      ? 'Stale — run a new audit before relying on this snapshot.'
      : 'No change recorded so far; this is not proof of complete filesystem freshness.'
    : 'Unknown — no post-audit monitor marker is recorded.';
  const paths = invalidation?.changedPaths ?? [];

  return (
    <section aria-label="Live audit monitoring" className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-medium">Live audit monitoring</h4>
          <p role="status" aria-live="polite" className="text-sm text-foreground-muted">
            State: {status?.state ?? 'loading'} · {freshness}
          </p>
        </div>
        {status?.active ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void stop()}
            disabled={busy}
          >
            Stop monitoring
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void start()}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Start monitoring'}
          </Button>
        )}
      </div>
      {message && (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      )}
      {invalidation && (
        <p className="mt-2 text-sm text-foreground-muted">
          {invalidation.changedCount} changed path event(s); {invalidation.changedPaths.length}{' '}
          unique path(s) retained{invalidation.pathsTruncated ? ' · list truncated' : ''}.
        </p>
      )}
      {paths.length > 0 && (
        <ul className="mt-2 max-h-32 list-disc overflow-auto pl-5 text-sm">
          {paths.slice(0, 20).map((path) => (
            <li key={path} className="break-all">
              <code>{path}</code>
            </li>
          ))}
          {(paths.length > 20 || invalidation?.pathsTruncated) && (
            <li>Additional paths are not shown.</li>
          )}
        </ul>
      )}
    </section>
  );
}

function AuditDetails({
  audit,
  previous,
}: {
  audit: AuditRecord | undefined;
  previous: AuditRecord | undefined;
}) {
  if (!audit) return null;
  const inventory = audit.inventory;
  const comparison = !previous
    ? 'No previous audit for comparison.'
    : 'File comparison below uses the two persisted audit snapshots.';
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-foreground-muted">
        Selected audit: {new Date(audit.capturedAt).toLocaleString()}
      </p>
      <AuditAnalysisFreshness context="Selected audit" analysisVersion={audit.analysisVersion} />
      <p>
        {inventory.filesDiscovered} {inventory.filesDiscovered === 1 ? 'file' : 'files'} inventoried
        · {inventory.filesParsed} parsed · {inventory.skipped} skipped ·{' '}
        {inventory.inventoryComplete ? 'Inventory complete' : 'Inventory incomplete'}
      </p>
      <GraphCoverageNotice
        coverage={inventory.graphCoverage}
        filesParsed={inventory.filesParsed}
        filesDiscovered={inventory.filesDiscovered}
        label="Audit graph coverage"
      />
      <p>
        Revision: {audit.revision ?? 'Unknown'} · Working tree:{' '}
        {audit.dirty === null ? 'Unknown' : audit.dirty ? 'Dirty' : 'Clean'}
      </p>
      <p>Filesystem identity: {audit.identity ?? 'Unavailable in this audit'}</p>
      <p className="break-all">Fingerprint: {audit.fingerprint ?? 'Unavailable'}</p>
      <p>Fingerprints are TraceMind path-aware hashes, not a plain file-content SHA-256.</p>
      <p>
        {comparison} Monitoring is optional and begins only after separate approval; a monitor
        marker is advisory and does not rewrite this snapshot.
      </p>
      <AuditMonitorPanel
        key={`monitor:${audit.locationId}:${audit.id}`}
        locationId={audit.locationId}
        auditId={audit.id}
      />
      {previous && (
        <EvidenceChanges
          key={`${previous.id}:${audit.id}`}
          locationId={audit.locationId}
          previousId={previous.id}
          currentId={audit.id}
        />
      )}
      {inventory.languages.length > 0 && (
        <p>
          Languages:{' '}
          {inventory.languages.map((item) => `${item.language} (${item.files})`).join(', ')}
        </p>
      )}
      {inventory.manifests.length > 0 && (
        <p className="break-words">Manifests: {inventory.manifests.join(', ')}</p>
      )}
      {inventory.skippedEntries &&
        (inventory.skippedEntries.length > 0 || inventory.skipDetailsTruncated) && (
          <div>
            <p className="font-medium">Skipped entries</p>
            <ul className="list-disc pl-5">
              {inventory.skippedEntries.map((item) => (
                <li key={item.path} className="break-all">
                  <code>{item.path}</code>: {item.reason}
                </li>
              ))}
            </ul>
            {inventory.skipDetailsTruncated && <p>Additional skipped entries are not listed.</p>}
          </div>
        )}
      {inventory.skipped > 0 && !inventory.skippedEntries && (
        <p>Skipped-entry details were not recorded for this audit.</p>
      )}
      {inventory.errors.length > 0 && (
        <div>
          <p className="font-medium">Errors</p>
          <ul className="list-disc pl-5">
            {inventory.errors.map((item, index) => (
              <li key={`${item.path}-${index}`}>
                {item.path || '(project root)'}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <EvidencePanel
        key={`evidence:${audit.locationId}:${audit.id}`}
        locationId={audit.locationId}
        auditId={audit.id}
      />
      <AuditReportPanel
        key={`report:${audit.locationId}:${audit.id}`}
        locationId={audit.locationId}
        auditId={audit.id}
      />
      <div>
        <p className="font-medium">Limitations</p>
        <ul className="list-disc pl-5">
          {inventory.limitations.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CheckDiscoveryPanel({
  locationId,
  auditId,
  analysisVersion,
}: {
  locationId: string;
  auditId: string;
  analysisVersion: number | undefined;
}) {
  const analysisStale = auditNeedsRefresh(analysisVersion);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{
    discoveryId: string;
    candidates: CommandProposal[];
    limitations: string[];
  } | null>(null);
  const [saved, setSaved] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const savingRef = useRef(false);
  async function discover(): Promise<void> {
    if (analysisStale) {
      setMessage('Run a new approved audit before discovering checks from stale analysis.');
      return;
    }
    setLoading(true);
    setMessage('');
    setResult(null);
    setSaved({});
    try {
      const found = await rpc.tracemind.discoverAuditChecks(locationId, auditId);
      if (!found) setMessage('Check discovery was not approved.');
      else setResult(found);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Check discovery failed: ${error.message}`
          : 'Check discovery failed.'
      );
    } finally {
      setLoading(false);
    }
  }
  async function save(index: number): Promise<void> {
    if (!result || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage('');
    try {
      const proposal = await rpc.tracemind.saveDiscoveredCheck(
        locationId,
        auditId,
        result.discoveryId,
        index
      );
      setSaved((current) => ({ ...current, [index]: proposal.id }));
      setHistoryVersion((value) => value + 1);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Could not save proposal: ${error.message}`
          : 'Could not save proposal.'
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return (
    <section
      aria-label="Candidate checks"
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <p className="font-medium">Candidate checks</p>
      <p className="text-foreground-muted">
        Discovery asks for approval to inspect the project. It does not run commands.
      </p>
      <Button
        type="button"
        disabled={loading || saving || analysisStale}
        onClick={() => void discover()}
      >
        {loading
          ? 'Discovering…'
          : analysisStale
            ? 'Refresh audit before discovery'
            : 'Discover checks'}
      </Button>
      {message && <p role="status">{message}</p>}
      {result && (
        <>
          {result.candidates.length === 0 && <p>No supported checks found.</p>}
          {result.candidates.map((candidate, index) => (
            <div key={candidate.workingDirectory} className="rounded-md border border-border p-3">
              <p>
                <strong>
                  {candidate.executable} {candidate.args.join(' ')}
                </strong>{' '}
                · {candidate.workingDirectory}
              </p>
              {candidate.declaredScripts.pretest !== undefined && (
                <p className="break-all">
                  Pretest: <code>{candidate.declaredScripts.pretest}</code>
                </p>
              )}
              <p className="break-all">
                Test: <code>{candidate.declaredScripts.test}</code>
              </p>
              {candidate.declaredScripts.posttest !== undefined && (
                <p className="break-all">
                  Posttest: <code>{candidate.declaredScripts.posttest}</code>
                </p>
              )}
              <p className="text-foreground-muted">Proposed only; not executed or verified.</p>
              <p>Effective sandbox mode: {candidate.sandboxMode}</p>
              {saved[index] ? (
                <p>
                  Saved proposal: <code>{saved[index]}</code>
                </p>
              ) : (
                <Button type="button" disabled={saving} onClick={() => void save(index)}>
                  Save proposal
                </Button>
              )}
            </div>
          ))}
          {result.limitations.map((item) => (
            <p key={item} className="text-foreground-muted">
              {item}
            </p>
          ))}
        </>
      )}
      <CheckProposalHistory locationId={locationId} auditId={auditId} refresh={historyVersion} />
    </section>
  );
}

function CheckProposalHistory({
  locationId,
  auditId,
  refresh,
}: {
  locationId: string;
  auditId: string;
  refresh: number;
}) {
  type CheckCapability = {
    platform: string;
    status: string;
    canRunDiscoveredChecks: boolean;
    reason: string;
    missingControls: readonly string[];
  };
  const [items, setItems] = useState<RunProposalSummary[]>([]);
  const [capability, setCapability] = useState<CheckCapability | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [approvedId, setApprovedId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const actionRef = useRef(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setCapability(null);
    void rpc.tracemind.getCheckCapability(locationId).then(
      (result) => {
        if (active) setCapability(result);
      },
      () => {
        if (active)
          setCapability({
            platform: 'unknown',
            status: 'unavailable',
            canRunDiscoveredChecks: false,
            reason: 'Could not verify check capability; approval is withheld.',
            missingControls: [],
          });
      }
    );
    void rpc.tracemind
      .listCheckProposals(locationId, auditId, null)
      .then(
        (page) => {
          if (active) {
            setItems(page.items);
            setCursor(page.nextCursor);
          }
        },
        () => {
          if (active) setMessage('Could not load saved checks.');
        }
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [locationId, auditId, refresh, reload]);
  // A remounted view no longer owns the original run promise. Refresh durable
  // running records so cancellation and terminal outcomes become visible.
  useEffect(() => {
    if (runningId || !items.some((item) => item.state === 'running')) return;
    const timer = setInterval(() => setReload((value) => value + 1), 3000);
    return () => clearInterval(timer);
  }, [items, runningId]);
  async function loadMore(): Promise<void> {
    if (!cursor || busy || actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    try {
      const page = await rpc.tracemind.listCheckProposals(locationId, auditId, cursor);
      setItems((current) => [
        ...current,
        ...page.items.filter((item) => !current.some((existing) => existing.id === item.id)),
      ]);
      setCursor(page.nextCursor);
    } catch {
      setMessage('Could not load more saved checks.');
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }
  async function cancel(item: RunProposalSummary): Promise<void> {
    if (busy || actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      const record = await rpc.tracemind.cancelCheckProposal(
        locationId,
        auditId,
        item.id,
        item.version
      );
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, state: record.state, version: record.version } : entry
        )
      );
    } catch {
      setMessage('Could not cancel proposal; it may have changed. Reload this audit.');
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }
  async function review(item: RunProposalSummary): Promise<void> {
    if (busy || actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      setApprovedId(null);
      const currentCapability = await rpc.tracemind.getCheckCapability(locationId, item.id);
      setCapability(currentCapability);
      if (!currentCapability.canRunDiscoveredChecks) {
        setMessage(`${currentCapability.reason} No approval was requested and no check was run.`);
        return;
      }
      const decision = await rpc.tracemind.requestCheckApproval(locationId, auditId, item.id);
      if (decision === 'approved') {
        setApprovedId(item.id);
        setMessage(
          `Approved once for up to 60 seconds (${item.sandboxMode}). No check has run yet.`
        );
      } else if (decision === 'denied') {
        setMessage('Proposal denied. No check was run.');
        setReload((value) => value + 1);
      } else if (decision === 'unavailable') {
        setMessage(
          'Verification runtime is unavailable on this host. No approval was created and no check was run.'
        );
      } else
        setMessage(
          'Approval was not granted. No check was run. The project may have changed or review was cancelled.'
        );
    } catch (error) {
      setMessage(
        error instanceof Error ? `Check review failed: ${error.message}` : 'Check review failed.'
      );
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }
  async function run(item: RunProposalSummary): Promise<void> {
    if (busy || actionRef.current || approvedId !== item.id) return;
    actionRef.current = true;
    setBusy(true);
    setRunningId(item.id);
    setApprovedId(null);
    setMessage(
      item.sandboxMode === 'macos-sandbox-exec'
        ? 'Running in macOS Seatbelt. Memory/process caps are not enforced, descendant termination is unconfirmed, and this result remains unverified.'
        : item.sandboxMode === 'unavailable'
          ? 'Running without a sandbox. Result will not be verified.'
          : `Running with ${item.sandboxMode}. The result will only be verified if capture, command matching, and termination checks all pass.`
    );
    try {
      const result = await rpc.tracemind.runApprovedCheck(locationId, auditId, item.id);
      setMessage(
        result.state === 'refused'
          ? 'Check refused before target start because required resource controls are unavailable. Inspect the recorded refusal.'
          : 'Check finished. Inspect its recorded outcome and limitations.'
      );
    } catch (error) {
      setMessage(error instanceof Error ? `Check failed: ${error.message}` : 'Check failed.');
    } finally {
      setRunningId(null);
      actionRef.current = false;
      setBusy(false);
      setReload((value) => value + 1);
    }
  }
  async function stop(runId: string): Promise<void> {
    try {
      const requested = await rpc.tracemind.cancelRunningCheck(locationId, auditId, runId);
      setMessage(
        requested
          ? 'Cancellation requested; process-tree termination may remain unconfirmed.'
          : 'No active runner was found. Process-tree termination may still be unconfirmed.'
      );
    } catch {
      setMessage('Could not request cancellation.');
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">Saved checks</p>
      {capability && (
        <div
          role="status"
          aria-label="Check platform capability"
          className="rounded-md border border-border p-3 text-sm"
        >
          <p>
            Platform capability: {capability.platform} · {capability.status}
          </p>
          <p>{capability.reason}</p>
          {capability.missingControls.length > 0 && (
            <p>Requested controls not enforced here: {capability.missingControls.join(', ')}</p>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {!busy && items.length === 0 && (
        <p className="text-foreground-muted">No saved checks for this audit.</p>
      )}
      {items.map((item) => (
        <div key={item.id} className="rounded-md border border-border p-3">
          <p>
            {item.executable} run test · {item.workingDirectory}
          </p>
          <p>
            Status: {item.state}
            {item.resultStatus ? ` · ${item.resultStatus}` : ''} ·{' '}
            {item.verified ? 'verified' : 'not verified'}
          </p>
          <p>Approved sandbox mode: {item.sandboxMode}</p>
          <p>
            Requested caps: process/task limit {item.processCount ?? 'not recorded'} (Linux counts
            threads and sandbox helpers) · memory{' '}
            {item.memoryBytes?.toLocaleString() ?? 'not recorded'} bytes.
          </p>
          <p className="break-all">
            ID: <code>{item.id}</code>
          </p>
          {item.state === 'proposed' && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={busy || !capability || !capability.canRunDiscoveredChecks}
                onClick={() => void review(item)}
              >
                Review check
              </Button>
              {approvedId === item.id && (
                <>
                  <p role="alert">
                    {item.sandboxMode === 'macos-sandbox-exec'
                      ? 'macOS Seatbelt confines project writes and denies network access, but memory/process caps are not enforced and detached descendants may remain. Results stay unverified; a normal command exit allows another separately approved check.'
                      : item.sandboxMode === 'linux-bubblewrap'
                        ? 'Linux PID namespace isolation is active. Process/task and memory caps are enforced only with writable delegated cgroup v2 support; the result will report which limits were effective.'
                        : 'This mode cannot confirm process-tree termination. After it starts, later checks remain blocked until a detected reboot on this host. Recovery requires a detected reboot on this host; older reservations may still require manual investigation.'}
                  </p>
                  <Button type="button" disabled={busy} onClick={() => void run(item)}>
                    Run approved check
                  </Button>
                </>
              )}
              <Button type="button" disabled={busy} onClick={() => void cancel(item)}>
                Cancel proposal
              </Button>
            </div>
          )}
          {(runningId === item.id || item.state === 'running') && (
            <Button type="button" onClick={() => void stop(item.id)}>
              Cancel running check
            </Button>
          )}
          {(item.state === 'finished' || item.state === 'refused') && (
            <CheckResultPreview
              key={item.id}
              locationId={locationId}
              auditId={auditId}
              runId={item.id}
              verified={item.verified}
              processCount={item.processCount ?? undefined}
              memoryBytes={item.memoryBytes ?? undefined}
            />
          )}
          {item.state === 'outcome_unknown' && (
            <p>Outcome unknown; process termination is not confirmed.</p>
          )}
        </div>
      ))}
      {cursor && (
        <Button type="button" disabled={busy} onClick={() => void loadMore()}>
          Load more checks
        </Button>
      )}
    </div>
  );
}

function CheckResultPreview({
  locationId,
  auditId,
  runId,
  verified,
  processCount,
  memoryBytes,
}: {
  locationId: string;
  auditId: string;
  runId: string;
  verified: boolean;
  processCount?: number;
  memoryBytes?: number;
}) {
  const [result, setResult] = useState<NonNullable<
    Awaited<ReturnType<typeof rpc.tracemind.getCheckResultPreview>>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function show(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const data = await rpc.tracemind.getCheckResultPreview(locationId, auditId, runId);
      if (!data) setMessage('Result is unavailable.');
      else setResult(data);
    } catch {
      setMessage('Could not load check result.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" disabled={busy} onClick={() => void show()}>
        {busy ? 'Loading…' : 'View result'}
      </Button>
      {message && <p role="status">{message}</p>}
      <p>
        Requested caps: process/task limit {processCount ?? 'not recorded'} (Linux counts threads
        and sandbox helpers) · memory {memoryBytes?.toLocaleString() ?? 'not recorded'} bytes.
      </p>
      {result && (
        <div className="flex flex-col gap-2">
          <p>
            Outcome: {result.status} · exit: {result.exitCode ?? 'unknown'} · signal:{' '}
            {result.signal ?? 'none'} · {Math.round(result.durationMs)} ms
          </p>
          {result.resourceLimitRefusal && (
            <p role="alert">
              Execution refused before target start on {result.resourceLimitRefusal.platform}:{' '}
              {result.resourceLimitRefusal.reason}. No target exit code exists.
            </p>
          )}
          <p>
            Sandbox: {result.sandboxMode} · capture:{' '}
            {result.capturedComplete ? 'complete' : 'incomplete'} · termination:{' '}
            {result.terminationUnconfirmed ? 'unconfirmed' : 'no termination uncertainty recorded'}{' '}
            · {verified ? 'verified' : 'not verified'}
          </p>
          {result.execution ? (
            <div>
              <p>
                Adapter requested executable:{' '}
                <code className="break-all">{result.execution.executable}</code>
              </p>
              <p>
                Arguments:{' '}
                <code className="break-all">{JSON.stringify(result.execution.args)}</code>
              </p>
              <p>
                Working directory: <code className="break-all">{result.execution.cwd}</code>
              </p>
              <p>
                Adapter child: {result.execution.spawned ? 'started' : 'not started'} · Target
                handoff: {result.execution.targetHandoff ?? 'unknown'}
              </p>
              <p>
                Working-directory binding: {result.execution.workingDirectoryBinding ?? 'unknown'}
              </p>
              <p>Environment keys: {result.execution.environmentKeys.join(', ') || '(none)'}</p>
              <p>
                Requested timeout: {result.execution.timeoutMs} ms · output cap:{' '}
                {result.execution.outputBytes} bytes
              </p>
            </div>
          ) : (
            <p>Recorded execution details are unavailable.</p>
          )}
          {result.effectiveLimits && (
            <p>
              Memory limit:{' '}
              {typeof result.effectiveLimits.memory === 'number'
                ? `${result.effectiveLimits.memory.toLocaleString()} bytes`
                : 'not enforced'}{' '}
              · Process/task limit:{' '}
              {typeof result.effectiveLimits.processCount === 'number'
                ? `${result.effectiveLimits.processCount} ${result.effectiveLimits.processCount === 1 ? 'task' : 'tasks'}`
                : 'not enforced'}{' '}
              · CPU-time limit:{' '}
              {typeof result.effectiveLimits.cpuTimeSeconds === 'number'
                ? `${result.effectiveLimits.cpuTimeSeconds} seconds per process`
                : 'not enforced'}{' '}
              · Timeout: termination request · Concurrency:{' '}
              {result.effectiveLimits.concurrency === 'durable-single-flight'
                ? 'one durable check at a time across the application database'
                : 'per adapter instance'}
            </p>
          )}
          {result.executionMismatch ? (
            <p role="alert">
              The adapter-reported command or effective resource limits did not match the approved
              proposal.
            </p>
          ) : result.executionMatchConfirmed ? (
            <p>Executed command matched the approved proposal.</p>
          ) : (
            <p>Match to approved proposal is unconfirmed; absence of a mismatch is not proof.</p>
          )}
          <details>
            <summary>Output references</summary>
            <p>These references resolve scoped stored UTF-8 previews, not raw output files.</p>
            {result.outputReferences.map((reference) => (
              <p key={reference.stream}>
                {reference.stream}: <code className="break-all">{JSON.stringify(reference)}</code>
              </p>
            ))}
          </details>
          <p>Output hashes describe observed bytes; they may not match a truncated preview.</p>
          <p>
            Stdout SHA-256: <code className="break-all">{result.stdoutHash}</code>
            {result.stdoutTruncated ? ' · capture truncated' : ''}
            {result.stdoutPreviewTruncated ? ' · preview truncated' : ''}
          </p>
          <pre className="max-h-48 overflow-auto rounded-md border border-border p-2 break-all whitespace-pre-wrap">
            {result.stdout || '(empty)'}
          </pre>
          <p>
            Stderr SHA-256: <code className="break-all">{result.stderrHash}</code>
            {result.stderrTruncated ? ' · capture truncated' : ''}
            {result.stderrPreviewTruncated ? ' · preview truncated' : ''}
          </p>
          <pre className="max-h-48 overflow-auto rounded-md border border-border p-2 break-all whitespace-pre-wrap">
            {result.stderr || '(empty)'}
          </pre>
        </div>
      )}
    </div>
  );
}

function AuditReportPanel({ locationId, auditId }: { locationId: string; auditId: string }) {
  const [report, setReport] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(false);
    try {
      const result = await rpc.tracemind.getAuditReport(locationId, auditId);
      if (mounted.current) setReport(result);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  return (
    <section aria-label="Audit report" className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Loading report…' : 'View audit report'}
        </Button>
      </div>
      {error && <p role="alert">Could not load the audit report.</p>}
      {report === null && <p>This older audit has no saved report.</p>}
      {typeof report === 'string' && (
        <pre className="max-h-96 overflow-auto rounded-md border border-border p-3 break-words whitespace-pre-wrap">
          {report}
        </pre>
      )}
    </section>
  );
}

function EvidenceChanges({
  locationId,
  previousId,
  currentId,
}: {
  locationId: string;
  previousId: string;
  currentId: string;
}) {
  const [result, setResult] = useState<EvidenceComparison | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.tracemind.compareAuditEvidence(locationId, previousId, currentId).then(
      (value) => {
        if (active) setResult(value);
      },
      () => {
        if (active) setFailed(true);
      }
    );
    return () => {
      active = false;
    };
  }, [locationId, previousId, currentId]);
  if (failed) return <p>File comparison could not be loaded.</p>;
  if (!result) return <p>Comparing captured file evidence…</p>;
  if (result.status === 'unavailable')
    return <p>File comparison unavailable for incomplete or incompatible audits.</p>;
  return (
    <section aria-label="File evidence changes">
      <p>
        Between the two captured audits: {result.counts.changed} changed, {result.counts.removed}{' '}
        removed, {result.counts.added} added.
      </p>
      <p>
        Added and removed mean present or absent in the eligible-file inventory, not necessarily
        created or deleted on disk.
      </p>
      {(result.counts.changed > 0 || result.counts.removed > 0) && (
        <p>
          Earlier evidence is stale for changed or removed files relative to the selected audit.
        </p>
      )}
      <ul>
        {result.items.map((item) => (
          <li key={item.path}>
            <code>{item.path}</code>: {item.change}
          </li>
        ))}
      </ul>
      {result.truncated && <p>Only the first 200 changed paths are shown.</p>}
    </section>
  );
}

function EvidencePanel({ locationId, auditId }: { locationId: string; auditId: string }) {
  const [items, setItems] = useState<AuditEvidence[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void rpc.tracemind
      .listAuditEvidence(locationId, auditId, 0)
      .then(
        (page) => {
          if (mounted.current) {
            setItems(page.items);
            setNextOffset(page.nextOffset);
          }
        },
        () => {
          if (mounted.current) setError('Could not load captured file evidence.');
        }
      )
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [locationId, auditId]);

  async function loadMore(): Promise<void> {
    if (nextOffset === null || loading) return;
    setLoading(true);
    setError('');
    try {
      const page = await rpc.tracemind.listAuditEvidence(locationId, auditId, nextOffset);
      if (mounted.current) {
        setItems((current) => [...current, ...page.items]);
        setNextOffset(page.nextOffset);
      }
    } catch {
      if (mounted.current) setError('Could not load more file evidence.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  return (
    <section aria-label="Captured file evidence" className="flex flex-col gap-2">
      <p className="font-medium">Captured file evidence</p>
      <p className="text-foreground-muted">
        Project-relative paths and file fingerprints from this audit; no source content is stored
        here.
      </p>
      {error && <p role="alert">{error}</p>}
      {items.length === 0 && !loading && !error && (
        <p className="text-foreground-muted">No file evidence was captured.</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.path} className="rounded-md border border-border p-2 break-all">
              <code>{item.path}</code>
              <p className="text-foreground-muted">Fingerprint: {item.fingerprint}</p>
            </li>
          ))}
        </ul>
      )}
      {loading && <p className="text-foreground-muted">Loading evidence…</p>}
      {nextOffset !== null && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

function GraphCoverageNotice({
  coverage,
  filesParsed,
  filesDiscovered,
  label,
}: {
  coverage?: { status: 'complete' | 'partial'; omittedFiles: number };
  filesParsed?: number;
  filesDiscovered?: number;
  label?: string;
}) {
  if (coverage?.status === 'complete') return null;
  const state = coverage?.status ?? 'unknown';
  return (
    <p role="status" aria-label={label} className="rounded-md border border-border p-3 text-sm">
      Graph coverage is {state}
      {coverage
        ? coverage.omittedFiles > 0
          ? filesParsed !== undefined && filesDiscovered !== undefined
            ? ` · ${filesParsed} of ${filesDiscovered} inventoried files have parser-derived graph evidence · ${coverage.omittedFiles} omitted`
            : ` · at least ${coverage.omittedFiles} eligible ${coverage.omittedFiles === 1 ? 'file lacks' : 'files lack'} parser-derived graph evidence`
          : ' · no file-level parser omissions are currently quantified; additional omissions may be unknown'
        : ''}
      . File inventory and fingerprints may still be available. Some evidence may be missing;
      freshness is not guaranteed, and this graph must not be treated as up to date.
    </p>
  );
}

function GraphParserFailureBrowser({
  locationId,
  revision,
  totalCount,
}: {
  locationId: string;
  revision: string;
  totalCount: number;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const [page, setPage] = useState<GraphParserFailurePage | null | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setPage(undefined);
    setError(false);
    if (totalCount === 0) {
      setPage({ revision, pageSize: 50, failures: [], nextCursor: null });
      return () => {
        active = false;
      };
    }
    void rpc.tracemind.getGraphParserFailurePage(locationId, revision, cursor).then(
      (result) => {
        if (active) setPage(result);
      },
      () => {
        if (active) setError(true);
      }
    );
    return () => {
      active = false;
    };
  }, [locationId, revision, cursor, totalCount]);

  const pageNumber = cursors.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / (page?.pageSize ?? 50)));
  const firstOrdinal = page?.failures[0]?.ordinal;
  const lastOrdinal = page?.failures.at(-1)?.ordinal;

  return (
    <section aria-label="Parser limitations" className="flex flex-col gap-2">
      <h4 className="font-medium">Parser limitations ({totalCount})</h4>
      {error && <p role="alert">Could not load parser limitation details.</p>}
      {page === undefined && !error && <p>Loading parser limitations…</p>}
      {page === null && <p>Parser limitation details are unavailable for this revision.</p>}
      {page && page.failures.length === 0 && totalCount === 0 && (
        <p>No parser limitations recorded.</p>
      )}
      {page && page.failures.length === 0 && totalCount > 0 && (
        <p>No parser limitation details are available on this page.</p>
      )}
      {page && page.failures.length > 0 && (
        <>
          <p role="status">
            Entries {firstOrdinal! + 1}–{lastOrdinal! + 1} of {totalCount} · page {pageNumber} of{' '}
            {pageCount}
          </p>
          <ul>
            {page.failures.map((failure) => (
              <li key={failure.ordinal}>
                <code>{failure.path}</code>: {failure.language} — {failure.message}
              </li>
            ))}
          </ul>
        </>
      )}
      {totalCount > 0 && (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Previous parser limitation page"
            disabled={pageNumber <= 1 || page === undefined}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Previous limitations
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Next parser limitation page"
            disabled={!page?.nextCursor}
            onClick={() => {
              if (page?.nextCursor) setCursors((current) => [...current, page.nextCursor]);
            }}
          >
            Next limitations
          </Button>
        </div>
      )}
    </section>
  );
}

function GraphPanel({
  graphical = false,
  onOpenNotes,
  locationId,
  revision,
  analysisVersion,
  coverage,
  filesParsed,
  filesDiscovered,
}: {
  graphical?: boolean;
  onOpenNotes?: () => void;
  locationId: string;
  revision: string;
  analysisVersion: number | undefined;
  coverage?: { status: 'complete' | 'partial'; omittedFiles: number };
  filesParsed?: number;
  filesDiscovered?: number;
}) {
  const [overview, setOverview] = useState<GraphOverview | null | undefined>(undefined);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const [relationshipPage, setRelationshipPage] = useState<
    GraphRelationshipPage | null | undefined
  >(undefined);
  const [relationshipCursors, setRelationshipCursors] = useState<(string | null)[]>([null]);
  const relationshipCursor = relationshipCursors.at(-1) ?? null;
  const [inspection, setInspection] = useState<GraphInspection | null>(null);
  const [inspectionStart, setInspectionStart] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [benchmark, setBenchmark] = useState<{
    readMs: number;
    traversalMs: number;
    traversalNodes: number;
    traversalRelationships: number;
    truncated: boolean;
    stopReason: 'time_limit' | 'edge_limit' | 'result_limit' | 'memory_limit' | null;
  } | null>(null);
  const [entryKind, setEntryKind] = useState<
    'observation' | 'command_run' | 'hypothesis' | 'evidence' | 'finding'
  >('observation');
  const [entryLabel, setEntryLabel] = useState('');
  const [entryReason, setEntryReason] = useState('');
  const [entryTarget, setEntryTarget] = useState('');
  const [entryRelation, setEntryRelation] = useState<
    'SUPPORTS' | 'CONTRADICTS' | 'VERIFIED_BY' | ''
  >('');
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setRelationshipCursors([null]);
  }, [locationId, revision]);
  useEffect(() => {
    let active = true;
    setError('');
    setOverview(undefined);
    void rpc.tracemind.getGraphOverview(locationId, revision, cursor).then(
      (item) => {
        if (active) setOverview(item);
      },
      () => {
        if (active) setError('Could not load the evidence graph.');
      }
    );
    return () => {
      active = false;
    };
  }, [locationId, revision, cursor]);
  useEffect(() => {
    let active = true;
    setRelationshipPage(undefined);
    void rpc.tracemind.getGraphRelationshipPage(locationId, revision, relationshipCursor).then(
      (page) => {
        if (active) setRelationshipPage(page);
      },
      () => {
        if (active) setError('Could not load the complete revision relationship map.');
      }
    );
    return () => {
      active = false;
    };
  }, [locationId, revision, relationshipCursor]);
  async function inspect(): Promise<void> {
    if (!overview?.rootNodeId) return;
    setError('');
    try {
      setInspection(
        await rpc.tracemind.inspectGraph(
          locationId,
          overview.revision,
          inspectionStart || overview.rootNodeId,
          {
            direction: 'both',
            maxDepth: 4,
            maxResults: 100,
            maxEdges: 5_000,
            maxTimeMs: 1_000,
            maxMemoryBytes: 16 * 1024 * 1024,
          }
        )
      );
    } catch {
      setError('Could not inspect the evidence graph.');
    }
  }
  async function measure(): Promise<void> {
    if (!overview) return;
    try {
      setBenchmark(await rpc.tracemind.benchmarkGraphAdapter(locationId, overview.revision));
    } catch {
      setError('Could not benchmark the local graph adapter.');
    }
  }
  async function recordEntry(): Promise<void> {
    if (
      recordingRef.current ||
      !overview ||
      !entryLabel.trim() ||
      !entryReason.trim() ||
      Boolean(entryTarget) !== Boolean(entryRelation)
    )
      return;
    recordingRef.current = true;
    setRecording(true);
    try {
      await rpc.tracemind.recordGraphEntry(locationId, overview.revision, {
        kind: entryKind,
        label: entryLabel,
        reason: entryReason,
        ...(entryTarget && entryRelation
          ? { targetNodeId: entryTarget, relation: entryRelation }
          : {}),
      });
      setEntryLabel('');
      setEntryReason('');
      setEntryTarget('');
      setEntryRelation('');
      try {
        setOverview(await rpc.tracemind.getGraphOverview(locationId, revision, cursor));
      } catch {
        setError('Entry recorded, but the graph summary could not refresh.');
      }
    } catch {
      setError('Could not record this investigation entry.');
    } finally {
      recordingRef.current = false;
      setRecording(false);
    }
  }
  return (
    <section aria-label="Evidence graph" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-medium">Evidence graph</h2>
        {overview && (
          <p className="text-sm text-foreground-muted">
            {overview.nodeCount} nodes · {overview.relationshipCount} relationships ·{' '}
            {overview.parserFailureCount} parser limitations
          </p>
        )}
      </div>
      <details className="rounded-md border border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer">Coverage, freshness, and provenance</summary>
        <div className="mt-2 space-y-2">
          <AuditAnalysisFreshness context="Graph source" analysisVersion={analysisVersion} />
          <GraphCoverageNotice
            coverage={coverage}
            filesParsed={filesParsed}
            filesDiscovered={filesDiscovered}
          />
          <p className="text-foreground-muted">
            Relationships are extracted leads, not proof. Inspect source locations and provenance
            before drawing conclusions.
          </p>
        </div>
      </details>
      {error && <p role="alert">{error}</p>}
      {overview === undefined && !error && <p>Loading graph…</p>}
      {overview === null && <p>No graph was captured for this audit.</p>}
      {overview && (
        <>
          {graphical ? (
            <GraphFileExplorer
              key={`files:${locationId}:${overview.revision}`}
              locationId={locationId}
              revision={overview.revision}
              rootNodeId={overview.rootNodeId ?? ''}
            />
          ) : (
            <div className="tm-graph-entry">
              <div>
                <h3>Explore the connections</h3>
                <p>
                  Open the dedicated graphical workspace to browse source files, inspect connected
                  notes, and follow evidence.
                </p>
              </div>
              <Button onClick={onOpenNotes}>Open graphical notes ↗</Button>
            </div>
          )}
          <div hidden={graphical}>
            <section aria-label="Project relationship map" className="flex flex-col gap-2">
              <h4 className="font-medium">Revision-wide relationships</h4>
              <p className="text-sm text-foreground-muted">
                Summary counts cover the full indexed revision. Browse all persisted relationships
                in stable pages of up to 50; heuristic links are not proof.
              </p>
              <ul aria-label="Relationship counts by type" className="flex flex-wrap gap-3">
                {Object.entries(overview.relationshipCounts).map(([kind, count]) => (
                  <li key={kind}>
                    <code>{kind}</code>: {count}
                  </li>
                ))}
              </ul>
              {relationshipPage === undefined && <p>Loading relationship page…</p>}
              {relationshipPage === null && (
                <p>No relationships were captured for this revision.</p>
              )}
              {relationshipPage && (
                <>
                  <ul aria-label="Persisted revision relationships" className="flex flex-col gap-2">
                    {relationshipPage.relationships.map((relationship) => (
                      <li key={relationship.id} className="rounded-md border border-border p-2">
                        <code>{relationship.relation}</code> · {relationship.certainty} ·{' '}
                        <code>{relationship.sourceId}</code> → <code>{relationship.targetId}</code>{' '}
                        · {relationship.extractionMethod} · {relationship.provenance}
                        {relationship.source && (
                          <>
                            {' '}
                            ·{' '}
                            <code>
                              {relationship.source.path}:{relationship.source.startLine}
                            </code>
                          </>
                        )}
                        {relationship.stale && <> · stale</>}
                      </li>
                    ))}
                  </ul>
                  <p aria-live="polite">
                    Relationship page {relationshipCursors.length} · up to 50 records.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label="Previous relationship page"
                      disabled={relationshipCursors.length <= 1}
                      onClick={() => setRelationshipCursors((current) => current.slice(0, -1))}
                    >
                      Previous relationships
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label="Next relationship page"
                      disabled={!relationshipPage.nextCursor}
                      onClick={() => {
                        if (relationshipPage.nextCursor)
                          setRelationshipCursors((current) => [
                            ...current,
                            relationshipPage.nextCursor,
                          ]);
                      }}
                    >
                      Next relationships
                    </Button>
                  </div>
                </>
              )}
            </section>
            <label>
              Inspection start
              <select
                aria-label="Graph inspection start"
                value={inspectionStart}
                onChange={(event) => setInspectionStart(event.target.value)}
              >
                <option value="">Revision root</option>
                {inspectionStart && !overview.nodes.some((node) => node.id === inspectionStart) && (
                  <option value={inspectionStart}>{inspectionStart}</option>
                )}
                {overview.nodes
                  .filter((node) => node.id !== overview.rootNodeId)
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.kind} · {node.label}
                    </option>
                  ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void inspect()}>
                Inspect graph
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void measure()}>
                Benchmark local adapter
              </Button>
            </div>
            <div className="order-last grid gap-2 rounded-md border border-border p-3">
              <p className="font-medium">Record investigation entry</p>
              <select
                aria-label="Investigation entry kind"
                value={entryKind}
                onChange={(event) => setEntryKind(event.target.value as typeof entryKind)}
                className="h-9 rounded-md border border-border bg-background px-2"
              >
                <option value="observation">Observation</option>
                <option value="hypothesis">Hypothesis</option>
                <option value="evidence">Evidence</option>
                <option value="command_run">Command run</option>
                <option value="finding">Finding</option>
              </select>
              <Input
                aria-label="Investigation entry label"
                value={entryLabel}
                onChange={(event) => setEntryLabel(event.target.value)}
                maxLength={1024}
                placeholder="Entry label"
              />
              <Textarea
                aria-label="Retrieval or recording rationale"
                value={entryReason}
                onChange={(event) => setEntryReason(event.target.value)}
                maxLength={4096}
                placeholder="Why this evidence was retrieved or recorded"
              />
              <select
                aria-label="Graph relationship target"
                value={entryTarget}
                onChange={(event) => setEntryTarget(event.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2"
              >
                <option value="">No relationship</option>
                {overview.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.kind}: {node.label}
                    {node.stale ? ' · stale' : ''}
                  </option>
                ))}
              </select>
              <p aria-live="polite">Target page {cursors.length} · up to 50 nodes per page.</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={recording || cursors.length <= 1}
                  onClick={() => {
                    setEntryTarget('');
                    setEntryRelation('');
                    setCursors((current) => current.slice(0, -1));
                  }}
                >
                  Previous targets
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={recording || !overview.nextCursor}
                  onClick={() => {
                    if (overview.nextCursor) {
                      setEntryTarget('');
                      setEntryRelation('');
                      setCursors((current) => [...current, overview.nextCursor]);
                    }
                  }}
                >
                  Next targets
                </Button>
              </div>
              {entryTarget && (
                <select
                  aria-label="Graph relationship type"
                  value={entryRelation}
                  onChange={(event) => setEntryRelation(event.target.value as typeof entryRelation)}
                  className="h-9 rounded-md border border-border bg-background px-2"
                >
                  <option value="">Select relationship</option>
                  <option value="SUPPORTS">Supports</option>
                  <option value="CONTRADICTS">Contradicts</option>
                  <option value="VERIFIED_BY">Verified by</option>
                </select>
              )}
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    recording ||
                    !entryLabel.trim() ||
                    !entryReason.trim() ||
                    Boolean(entryTarget) !== Boolean(entryRelation)
                  }
                  onClick={() => void recordEntry()}
                >
                  Record entry
                </Button>
              </div>
            </div>
            {benchmark && (
              <p>
                Normalized SQLite counts: {benchmark.readMs.toFixed(2)} ms · bounded traversal:{' '}
                {benchmark.traversalMs.toFixed(2)} ms · {benchmark.traversalNodes} nodes /{' '}
                {benchmark.traversalRelationships} relationships ·{' '}
                {benchmark.truncated
                  ? `bounded traversal stopped at ${benchmark.stopReason ?? 'unknown limit'}`
                  : 'bounded traversal completed within limits'}
                .
              </p>
            )}
            <GraphParserFailureBrowser
              key={`${locationId}:${overview.revision}`}
              locationId={locationId}
              revision={overview.revision}
              totalCount={overview.parserFailureCount}
            />
            {inspection && (
              <>
                <p>
                  {inspection.nodes.length} reachable nodes · {inspection.relationships.length}{' '}
                  inspected relationships
                  {inspection.truncated ? ` · truncated by ${inspection.stopReason}` : ''}.
                </p>
                <div className="space-y-4">
                  <GraphCanvas
                    inspection={inspection}
                    selectedId={selectedNodeId}
                    onSelect={(id) => {
                      setInspectionStart(id);
                      setSelectedNodeId(id);
                    }}
                  />
                  <SelectedNodeDetails inspection={inspection} nodeId={selectedNodeId} />
                </div>
                <ul aria-label="Inspected graph nodes" className="flex flex-col gap-2">
                  {inspection.nodes.map((node) => (
                    <li key={node.id} className="rounded-md border border-border p-2">
                      <code>{node.kind}</code> · {node.label}
                      {node.source && (
                        <>
                          {' '}
                          ·{' '}
                          <code>
                            {node.source.path}:{node.source.startLine}
                          </code>
                        </>
                      )}
                      {node.stale && <> · stale</>}
                    </li>
                  ))}
                </ul>
                <ul className="flex flex-col gap-2">
                  {inspection.relationships.map((relationship) => (
                    <li key={relationship.id} className="rounded-md border border-border p-2">
                      <code>{relationship.relation}</code> ·{' '}
                      {inspection.nodes.find((node) => node.id === relationship.sourceId)?.label ??
                        relationship.sourceId}{' '}
                      →{' '}
                      {inspection.nodes.find((node) => node.id === relationship.targetId)?.label ??
                        relationship.targetId}{' '}
                      · {relationship.extractionMethod} · {relationship.provenance}
                      {relationship.source && (
                        <>
                          {' '}
                          ·{' '}
                          <code>
                            {relationship.source.path}:{relationship.source.startLine}
                          </code>
                        </>
                      )}
                      {relationship.stale && <> · stale</>}
                    </li>
                  ))}
                </ul>
                <p>
                  Retrieval rationale:{' '}
                  {overview.retrievalReasons.map((item) => item.reason).join(' ') ||
                    'No evidence retrieval rationale recorded.'}
                </p>
                {inspection.relationships.some((item) => item.relation === 'CONTRADICTS') && (
                  <p>
                    Contradictory evidence is preserved and shown alongside supporting evidence; it
                    is not discarded.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Loads source-path nodes from every page, not just the revision preview. */
function GraphFileExplorer({
  locationId,
  revision,
  rootNodeId,
}: {
  locationId: string;
  revision: string;
  rootNodeId: string;
}) {
  const [query, setQuery] = useState('');
  const [searchCursors, setSearchCursors] = useState<(string | null)[]>([null]);
  const [searchPage, setSearchPage] = useState<GraphFileSearchPage | null | undefined>();
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [fileNodes, setFileNodes] = useState<Record<string, PersistentGraphNode[] | null>>({});
  const [fileInspections, setFileInspections] = useState<Record<string, GraphInspection>>({});
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [visibleNodePage, setVisibleNodePage] = useState(0);
  const [error, setError] = useState('');
  const [showAllLabels, setShowAllLabels] = useState(true);
  const [showGenerated, setShowGenerated] = useState(false);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [rootInspection, setRootInspection] = useState<GraphInspection | null>(null);
  const [rootLoading, setRootLoading] = useState(true);
  const inFlight = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const searchCursor = searchCursors.at(-1) ?? null;
  useEffect(() => {
    let active = true;
    setSearchPage(undefined);
    void rpc.tracemind.searchGraphFiles(locationId, revision, query, searchCursor).then(
      (page) => {
        if (active) setSearchPage(page);
      },
      () => {
        if (active) setError('Could not search graph files.');
      }
    );
    return () => {
      active = false;
    };
  }, [locationId, revision, query, searchCursor]);
  useEffect(() => {
    let active = true;
    if (!rootNodeId) {
      setRootLoading(false);
      return () => {
        active = false;
      };
    }
    setRootLoading(true);
    void rpc.tracemind
      .inspectGraph(locationId, revision, rootNodeId, {
        direction: 'outgoing',
        maxDepth: 2,
        maxResults: 100,
        maxEdges: 5_000,
        maxTimeMs: 2_000,
        maxMemoryBytes: 32 * 1024 * 1024,
      })
      .then(
        (result) => {
          if (active) setRootInspection(result);
        },
        () => {
          if (active)
            setError(
              'Could not load the revision graph preview. Search and select a file to inspect its saved nodes.'
            );
        }
      )
      .finally(() => {
        if (active) setRootLoading(false);
      });
    return () => {
      active = false;
    };
  }, [locationId, revision, rootNodeId]);
  async function loadFile(path: string, fileNodeId: string): Promise<void> {
    if (inFlight.current.has(path) || Object.hasOwn(fileNodes, path)) return;
    inFlight.current.add(path);
    setFileNodes((current) => ({ ...current, [path]: null }));
    const nodes: PersistentGraphNode[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    try {
      while (true) {
        const page = await rpc.tracemind.getGraphFileNodesPage(locationId, revision, path, cursor);
        if (!page) throw new Error('Graph file disappeared');
        nodes.push(...page.nodes);
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error('Graph file pagination repeated a cursor');
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      if (alive.current) setFileNodes((current) => ({ ...current, [path]: nodes }));
      // The complete file-node list is authoritative for details. A bounded
      // adjacency read supplies only persisted links for the spatial view.
      try {
        const inspected = await rpc.tracemind.inspectGraph(locationId, revision, fileNodeId, {
          direction: 'both',
          maxDepth: 2,
          maxResults: 1000,
          maxEdges: 100_000,
          maxTimeMs: 10_000,
          maxMemoryBytes: 128 * 1024 * 1024,
        });
        if (alive.current) setFileInspections((current) => ({ ...current, [path]: inspected }));
      } catch {
        if (alive.current)
          setError(`Saved nodes loaded, but relationships for ${path} could not be inspected.`);
      }
    } catch {
      if (alive.current) {
        setFileNodes((current) => {
          const next = { ...current };
          delete next[path];
          return next;
        });
        setError(`Could not load all graph nodes for ${path}.`);
      }
    } finally {
      inFlight.current.delete(path);
    }
  }
  function toggleFile(path: string, fileNodeId?: string): void {
    setSelectedPaths((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
    );
    if (fileNodeId && !Object.hasOwn(fileNodes, path)) void loadFile(path, fileNodeId);
  }
  async function reveal(path: string): Promise<void> {
    setError('');
    try {
      await rpc.tracemind.revealGraphFileInFinder(locationId, revision, path);
    } catch {
      setError(`Could not reveal ${path} in Finder. The file may have moved since this audit.`);
    }
  }
  const selectedNodes = useMemo(
    () => selectedPaths.flatMap((path) => fileNodes[path] ?? []),
    [selectedPaths, fileNodes]
  );
  const nodesPerVisualPage = 80;
  const visualPageCount = Math.max(1, Math.ceil(selectedNodes.length / nodesPerVisualPage));
  const effectiveVisualPage = Math.min(visibleNodePage, visualPageCount - 1);
  const visibleNodes = selectedNodes.slice(
    effectiveVisualPage * nodesPerVisualPage,
    (effectiveVisualPage + 1) * nodesPerVisualPage
  );
  const selectedRelationships = useMemo(() => {
    const ids = new Set(selectedNodes.map((node) => node.id));
    const edges = new Map<string, GraphInspection['relationships'][number]>();
    for (const path of selectedPaths) {
      for (const edge of fileInspections[path]?.relationships ?? []) {
        if (ids.has(edge.sourceId) && ids.has(edge.targetId)) edges.set(edge.id, edge);
      }
    }
    return [...edges.values()];
  }, [selectedNodes, selectedPaths, fileInspections]);
  const displayInspection = useMemo<GraphInspection>(
    () => ({
      nodes: selectedNodes,
      relationships: selectedRelationships,
      truncated: selectedPaths.some((path) => fileInspections[path]?.truncated),
      stopReason:
        selectedPaths.map((path) => fileInspections[path]?.stopReason).find(Boolean) ?? null,
    }),
    [selectedNodes, selectedRelationships, selectedPaths, fileInspections]
  );
  const canvasInspection = useMemo<GraphInspection>(() => {
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    return {
      ...displayInspection,
      nodes: visibleNodes,
      relationships: selectedRelationships.filter(
        (edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)
      ),
    };
  }, [displayInspection, visibleNodes, selectedRelationships]);
  const loadingCount = selectedPaths.filter((path) => fileNodes[path] === null).length;
  const activeInspection = useMemo(
    () =>
      sourceGraphInspection(
        selectedPaths.length ? canvasInspection : rootInspection,
        showGenerated
      ),
    [selectedPaths.length, canvasInspection, rootInspection, showGenerated]
  );
  const detailInspection = useMemo(
    () =>
      sourceGraphInspection(
        selectedPaths.length ? displayInspection : rootInspection,
        showGenerated
      ),
    [selectedPaths.length, displayInspection, rootInspection, showGenerated]
  );
  const noteNodes = activeInspection?.nodes ?? [];
  const activeNodeId = detailInspection?.nodes.some((node) => node.id === selectedNodeId)
    ? selectedNodeId
    : (noteNodes[0]?.id ?? '');
  const relatedNotes = connectionNotes(detailInspection, activeNodeId);
  const displayedNotes = connectedOnly ? relatedNotes : noteNodes;
  const visibleFiles =
    searchPage?.files.filter((file) => showGenerated || isGraphSourcePath(file.path)) ?? [];
  return (
    <section
      aria-label="Graph file explorer"
      className="min-w-0 rounded-lg border border-border bg-background p-3"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-medium">Graphical notes</h4>
          <p className="text-xs text-foreground-muted">
            Browse indexed files and notes beside the spatial graph. A selected note shows its full
            saved details.
          </p>
        </div>
        {selectedPaths.length > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={() => setSelectedPaths([])}>
            Show revision overview
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div
        aria-label="Full-page graph workspace"
        className="grid min-w-0 gap-3 xl:grid-cols-[minmax(220px,22%)_minmax(0,1fr)_minmax(280px,25%)]"
      >
        <aside
          aria-label="Graph file navigator"
          className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
        >
          <h5 className="font-medium">Files</h5>
          <Input
            aria-label="Search graph file names"
            value={query}
            maxLength={256}
            placeholder="Search file name or path"
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchCursors([null]);
            }}
          />
          <label className="tm-filter">
            <input
              type="checkbox"
              checked={showGenerated}
              onChange={(event) => setShowGenerated(event.target.checked)}
            />
            Show generated & auxiliary files
          </label>
          {searchPage && visibleFiles.length < searchPage.files.length && (
            <p className="text-xs text-foreground-muted">
              {searchPage.files.length - visibleFiles.length} auxiliary files hidden on this page.
            </p>
          )}
          {searchPage === undefined && <p>Searching files…</p>}
          {searchPage && (
            <>
              <ul
                aria-label="Graph file search results"
                className="max-h-[calc(100vh-20rem)] min-h-48 overflow-y-auto"
              >
                {visibleFiles.map((file) => (
                  <li key={file.id} className="border-b border-border py-2">
                    <label className="flex min-w-0 items-start gap-2">
                      <input
                        type="checkbox"
                        aria-label={`Show graph nodes for ${file.path}`}
                        checked={selectedPaths.includes(file.path)}
                        onChange={() => toggleFile(file.path, file.id)}
                      />
                      <code className="min-w-0 text-xs break-all">{file.path}</code>
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void reveal(file.path)}
                    >
                      Reveal in Finder
                    </Button>
                    {file.stale && <span className="text-xs"> · stale</span>}
                  </li>
                ))}
              </ul>
              {visibleFiles.length === 0 && (
                <p>No source files on this page. Try the next page or show auxiliary files.</p>
              )}
              <p aria-live="polite" className="text-xs">
                File search page {searchCursors.length} · up to 50 matching files per page.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={searchCursors.length <= 1}
                  onClick={() => setSearchCursors((current) => current.slice(0, -1))}
                >
                  Previous files
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!searchPage.nextCursor}
                  onClick={() => {
                    if (searchPage.nextCursor)
                      setSearchCursors((current) => [...current, searchPage.nextCursor]);
                  }}
                >
                  Next files
                </Button>
              </div>
            </>
          )}
        </aside>
        <div aria-label="Graph visualization" className="flex min-w-0 flex-col gap-2">
          {selectedPaths.length > 0 ? (
            <>
              <p aria-live="polite" className="text-xs">
                {selectedPaths.length} selected files · {selectedNodes.length} saved nodes loaded
                {loadingCount ? ` · ${loadingCount} files loading` : ' · all pages loaded'}.{' '}
                {selectedRelationships.length} saved relationships visible between selected nodes
                {displayInspection.truncated
                  ? ` · adjacency inspection stopped at ${displayInspection.stopReason}`
                  : ''}
                .
              </p>
              <ul aria-label="Selected graph files" className="flex flex-wrap gap-1">
                {selectedPaths.map((path) => (
                  <li key={path} className="rounded border border-border px-2 py-1 text-xs">
                    <code className="break-all">{path}</code> ·{' '}
                    {fileNodes[path]?.length ?? 'loading'} nodes{' '}
                    <button
                      type="button"
                      aria-label={`Remove ${path}`}
                      onClick={() => toggleFile(path)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-foreground-muted">
              Revision preview · {activeInspection?.nodes.length ?? 0} of the saved nodes shown
              {rootInspection?.truncated ? ` · stopped at ${rootInspection.stopReason}` : ''}.
              Select files to browse every saved node in those files. Auxiliary nodes follow the
              file filter.
            </p>
          )}
          {activeInspection && activeInspection.nodes.length > 0 ? (
            <GraphCanvas
              inspection={activeInspection}
              selectedId={activeNodeId}
              onSelect={setSelectedNodeId}
              showAllLabels={showAllLabels}
              fullPage
            />
          ) : (
            <div className="flex min-h-[60vh] items-center justify-center rounded-lg border border-border text-sm text-foreground-muted">
              {rootLoading || loadingCount ? 'Loading graph…' : 'No graph nodes in this selection.'}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showAllLabels}
              onChange={(event) => setShowAllLabels(event.target.checked)}
            />
            Show readable node labels
          </label>
          <p className="text-xs text-foreground-muted">
            Spatial grouping is a navigation view, not a persisted relationship.
          </p>
        </div>
        <aside
          aria-label="Graph note navigator"
          className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
        >
          <h5 className="font-medium">
            {selectedPaths.length ? 'File notes' : 'Preview notes'} · {noteNodes.length}
            {selectedPaths.length ? ` of ${selectedNodes.length}` : ''}
          </h5>
          {selectedPaths.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-1 text-xs"
              aria-label="Graph node page controls"
            >
              <span>
                Spatial node page {effectiveVisualPage + 1} of {visualPageCount} ·{' '}
                {visibleNodes.length} of {selectedNodes.length} saved nodes rendered
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={effectiveVisualPage === 0}
                onClick={() => setVisibleNodePage((page) => Math.max(0, page - 1))}
              >
                Previous nodes
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={effectiveVisualPage + 1 >= visualPageCount}
                onClick={() => setVisibleNodePage((page) => page + 1)}
              >
                Next nodes
              </Button>
            </div>
          )}
          <label className="tm-filter">
            <input
              type="checkbox"
              checked={connectedOnly}
              onChange={(event) => setConnectedOnly(event.target.checked)}
            />
            Connected to selected note ({relatedNotes.length})
          </label>
          {connectedOnly && relatedNotes.length === 0 && (
            <p className="text-xs text-foreground-muted">
              No adjacent notes in the loaded evidence. Load related files to expand the view.
            </p>
          )}
          <ul
            aria-label="All selected file graph nodes"
            className="max-h-[24vh] min-h-32 overflow-y-auto text-sm"
          >
            {displayedNotes.map((node) => (
              <li key={node.id} className="border-b border-border py-1">
                <button
                  type="button"
                  aria-current={activeNodeId === node.id ? 'true' : undefined}
                  className="aria-[current=true]:text-primary w-full text-left break-all"
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <code>{node.kind}</code> · {node.label}
                </button>
                {node.source && (
                  <code className="block text-xs break-all text-foreground-muted">
                    {node.source.path}:{node.source.startLine}
                  </code>
                )}
              </li>
            ))}
          </ul>
          {detailInspection && (
            <div className="max-h-[42vh] min-h-0 overflow-y-auto">
              <SelectedNodeDetails inspection={detailInspection} nodeId={activeNodeId} />
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

/** Shows only data returned by the currently inspected, bounded subgraph. */
function SelectedNodeDetails({
  inspection,
  nodeId,
}: {
  inspection: GraphInspection;
  nodeId: string;
}) {
  const node = inspection.nodes.find((item) => item.id === nodeId);
  if (!node)
    return (
      <p className="text-sm text-foreground-muted">
        Select a node to see its details and connected relationships.
      </p>
    );
  const relationships = inspection.relationships.filter(
    (edge) => edge.sourceId === node.id || edge.targetId === node.id
  );
  return (
    <aside
      aria-label="Selected node details"
      className="rounded-lg border border-border p-4 text-sm"
    >
      <p className="font-medium">Selected node · {node.kind}</p>
      <p className="break-all">{node.label}</p>
      <dl className="mt-3 grid gap-2 text-foreground-muted">
        <div>
          <dt className="inline font-medium">Revision: </dt>
          <dd className="inline break-all">{node.revision}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Source: </dt>
          <dd className="inline break-all">
            {node.source
              ? `${node.source.path}:${node.source.startLine}–${node.source.endLine}`
              : 'Not recorded'}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Extraction: </dt>
          <dd className="inline">{node.extractionMethod}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Provenance: </dt>
          <dd className="inline break-all">{node.provenance}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Status: </dt>
          <dd className="inline">{node.stale ? 'Stale' : 'Not marked stale in this snapshot'}</dd>
        </div>
      </dl>
      <p className="mt-3 font-medium">Connected relationships · {relationships.length}</p>
      <p className="text-xs text-foreground-muted">
        Only relationships in this inspection are shown; graph links are not proof.
      </p>
      <ul className="mt-2 space-y-1">
        {relationships.map((edge) => {
          const incoming = edge.targetId === node.id;
          const other = inspection.nodes.find(
            (item) => item.id === (incoming ? edge.sourceId : edge.targetId)
          );
          return (
            <li key={edge.id} className="break-words">
              <code>{edge.relation}</code> · {incoming ? 'Incoming from' : 'Outgoing to'}{' '}
              {other?.label ?? (incoming ? edge.sourceId : edge.targetId)} · {edge.extractionMethod}{' '}
              · {edge.provenance}
              {edge.stale ? ' · stale' : ''}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

type GraphPoint3D = { x: number; y: number; z: number };
type ProjectedGraphPoint = { x: number; y: number; depth: number; scale: number };
type GraphCanvasLabel = { id: string; text: string; x: number; y: number };

const graphCanvasWidth = 1200;
const graphCanvasHeight = 800;

function readableGraphLabel(node: PersistentGraphNode): string {
  const prefix = node.source ? `${node.source.path}:` : '';
  const local =
    prefix && node.label.startsWith(prefix) ? node.label.slice(prefix.length) : node.label;
  const short = local.length > 32 ? `${local.slice(0, 31)}…` : local;
  return node.kind === 'config' && node.source
    ? `${short || node.kind} · L${node.source.startLine}`
    : short || node.kind.replace('_', ' ');
}

/** Places useful labels without rendering a wall of overlapping text. */
export function layoutGraphCanvasLabels(
  nodes: PersistentGraphNode[],
  projected: Map<string, ProjectedGraphPoint>,
  selectedId: string,
  hoveredId: string,
  showLabels: boolean
): GraphCanvasLabel[] {
  const occupied: { left: number; top: number; right: number; bottom: number }[] = [];
  const labels: GraphCanvasLabel[] = [];
  const ordered = [...nodes].sort((a, b) => {
    const priority = (node: PersistentGraphNode): number =>
      node.id === selectedId ? 0 : node.id === hoveredId ? 1 : node.kind === 'file' ? 2 : 3;
    return priority(a) - priority(b) || a.id.localeCompare(b.id);
  });
  for (const node of ordered) {
    if (!showLabels && node.id !== selectedId && node.id !== hoveredId) continue;
    const point = projected.get(node.id);
    if (!point) continue;
    const label = readableGraphLabel(node);
    const width = Math.min(280, label.length * 7.3 + 8);
    const height = 20;
    let x = point.x + 12 * point.scale;
    let y = point.y - 11 * point.scale;
    if (x + width > graphCanvasWidth - 12) x = point.x - width - 12 * point.scale;
    if (y - height < 8) y = point.y + height + 8 * point.scale;
    const box = { left: x - 3, top: y - height, right: x + width, bottom: y + 4 };
    if (
      box.left < 8 ||
      box.right > graphCanvasWidth - 8 ||
      box.bottom > graphCanvasHeight - 8 ||
      occupied.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top
      )
    )
      continue;
    occupied.push(box);
    labels.push({ id: node.id, text: label, x, y });
  }
  return labels;
}

function initialGraphPositions(inspection: GraphInspection): Map<string, GraphPoint3D> {
  return connectionPositions(inspection);
}

function projectGraphPoint(point: GraphPoint3D, yaw: number, pitch: number): ProjectedGraphPoint {
  const yawX = point.x * Math.cos(yaw) + point.z * Math.sin(yaw);
  const yawZ = -point.x * Math.sin(yaw) + point.z * Math.cos(yaw);
  const pitchY = point.y * Math.cos(pitch) - yawZ * Math.sin(pitch);
  const depth = point.y * Math.sin(pitch) + yawZ * Math.cos(pitch);
  const scale = 800 / Math.max(300, 800 - depth);
  return { x: 600 + yawX * scale * 1.3, y: 400 + pitchY * scale, depth, scale };
}

/** 3D spatial projection with orbit, depth drag, zoom and per-node movement. */
function GraphCanvas({
  inspection,
  onSelect,
  selectedId,
  showAllLabels = true,
  fullPage = false,
}: {
  inspection: GraphInspection;
  onSelect: (id: string) => void;
  selectedId: string;
  showAllLabels?: boolean;
  fullPage?: boolean;
}) {
  const nodes = inspection.nodes;
  const [positions, setPositions] = useState(() => initialGraphPositions(inspection));
  const positionsRef = useRef(positions);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [yaw, setYaw] = useState(0.25);
  const [pitch, setPitch] = useState(-0.2);
  const [hoveredId, setHoveredId] = useState('');
  const [expanded, setExpanded] = useState(false);
  const drag = useRef<{
    nodeId: string | null;
    x: number;
    y: number;
    moved: boolean;
    depth: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const next = initialGraphPositions(inspection);
    positionsRef.current = next;
    setPositions(next);
  }, [inspection]);
  const projected = new Map(
    nodes.flatMap((node) => {
      const point = positions.get(node.id);
      return point ? [[node.id, projectGraphPoint(point, yaw, pitch)] as const] : [];
    })
  );
  const labels = layoutGraphCanvasLabels(nodes, projected, selectedId, hoveredId, showAllLabels);
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const movePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    const bounds = svg.current?.getBoundingClientRect();
    if (!active || !bounds || !bounds.width || !bounds.height) return;
    const pixelX = event.clientX - active.x;
    const pixelY = event.clientY - active.y;
    const dx = (pixelX * graphCanvasWidth) / (bounds.width * zoom * 1.3);
    const dy = (pixelY * graphCanvasHeight) / (bounds.height * zoom);
    if (Math.abs(pixelX) + Math.abs(pixelY) > 1) active.moved = true;
    active.x = event.clientX;
    active.y = event.clientY;
    if (active.nodeId) {
      const point = positionsRef.current.get(active.nodeId);
      if (point) {
        if (active.depth) point.z += dy;
        else {
          point.x += dx;
          point.y += dy;
        }
        setPositions(new Map(positionsRef.current));
      }
    } else {
      setYaw((value) => value + pixelX * 0.008);
      setPitch((value) => Math.max(-1.4, Math.min(1.4, value + pixelY * 0.008)));
    }
  };
  const beginDrag = (event: React.PointerEvent<SVGElement>, nodeId: string | null) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    drag.current = {
      nodeId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      depth: event.shiftKey,
    };
    svg.current?.setPointerCapture?.(event.pointerId);
  };
  const endDrag = () => {
    suppressClick.current = drag.current?.moved ?? false;
    drag.current = null;
  };
  return (
    <div
      data-graph-canvas
      className={
        expanded
          ? 'fixed inset-3 z-50 flex flex-col rounded-lg border border-border bg-background p-2 shadow-2xl'
          : 'min-w-0 rounded-lg border border-border bg-background p-2'
      }
      onKeyDown={(event) => {
        if (event.key === 'Escape') setExpanded(false);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs text-foreground-muted">
        <span className="mr-auto">
          3D spatial view · drag background to orbit · drag node to move · Shift-drag node for depth
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Rotate graph left"
          onClick={() => setYaw((value) => value - Math.PI / 8)}
        >
          ↶
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Rotate graph right"
          onClick={() => setYaw((value) => value + Math.PI / 8)}
        >
          ↷
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Zoom out graph"
          onClick={() => setZoom((value) => Math.max(0.5, value / 1.25))}
        >
          −
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Zoom in graph"
          onClick={() => setZoom((value) => Math.min(4, value * 1.25))}
        >
          +
        </Button>
        {!fullPage && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={expanded ? 'Close expanded graph' : 'Expand graph'}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Close' : 'Expand'}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
            setYaw(0.25);
            setPitch(-0.2);
          }}
        >
          Reset view
        </Button>
      </div>
      <svg
        ref={svg}
        aria-label="Inspected evidence graph"
        role="group"
        viewBox={`${600 - 600 / zoom + pan.x} ${400 - 400 / zoom + pan.y} ${graphCanvasWidth / zoom} ${graphCanvasHeight / zoom}`}
        className="w-full min-w-0 flex-1 touch-none text-foreground-muted"
        style={{
          height: expanded ? '90vh' : fullPage ? 'calc(100vh - 22rem)' : '78vh',
          maxHeight: expanded || fullPage ? undefined : '840px',
          minHeight: fullPage ? '520px' : '640px',
        }}
        onPointerDown={(event) => beginDrag(event, null)}
        onPointerMove={movePointer}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <title>3D evidence graph projection. Select a node to inspect its saved details.</title>
        {inspection.relationships.map((edge) => {
          const from = projected.get(edge.sourceId);
          const to = projected.get(edge.targetId);
          return from && to ? (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className="stroke-current opacity-30"
              strokeWidth="1"
            />
          ) : null;
        })}
        {[...nodes]
          .sort((a, b) => (projected.get(a.id)?.depth ?? 0) - (projected.get(b.id)?.depth ?? 0))
          .map((node) => {
            const point = projected.get(node.id);
            if (!point) return null;
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`Inspect from ${node.kind}: ${node.label}`}
                onPointerDown={(event) => beginDrag(event, node.id)}
                onPointerEnter={() => setHoveredId(node.id)}
                onPointerLeave={() =>
                  setHoveredId((current) => (current === node.id ? '' : current))
                }
                onFocus={() => setHoveredId(node.id)}
                onBlur={() => setHoveredId((current) => (current === node.id ? '' : current))}
                onClick={() => {
                  if (!suppressClick.current) onSelect(node.id);
                  suppressClick.current = false;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
                className="focus-visible:outline-primary cursor-grab focus-visible:outline-2"
              >
                <title>{`${node.kind}: ${node.label}${node.stale ? ' (stale)' : ''}`}</title>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={
                    (node.id === selectedId ? 9 : node.kind === 'repository_revision' ? 8 : 5) *
                    point.scale
                  }
                  stroke={node.id === selectedId ? 'currentColor' : 'none'}
                  strokeWidth={node.id === selectedId ? 2 : 0}
                  className={
                    node.stale ? 'fill-current text-destructive' : 'fill-current text-foreground'
                  }
                />
                {labelsById.get(node.id) && (
                  <text
                    x={labelsById.get(node.id)!.x}
                    y={labelsById.get(node.id)!.y}
                    className="pointer-events-none fill-current stroke-background text-[13px] font-medium text-foreground [paint-order:stroke]"
                    strokeWidth="3"
                  >
                    {labelsById.get(node.id)!.text}
                  </text>
                )}
              </g>
            );
          })}
      </svg>
      <p className="px-2 pb-1 text-xs text-foreground-muted">
        {nodes.length} nodes on this page · {labels.length} non-overlapping titles shown. Hover or
        select any node for its full title. Lines show saved relationships only; spatial proximity
        has no evidentiary meaning.
      </p>
    </div>
  );
}
