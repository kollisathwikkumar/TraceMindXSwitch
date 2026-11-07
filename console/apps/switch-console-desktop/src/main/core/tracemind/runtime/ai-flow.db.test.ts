import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type {
  TraceMindAIInvestigation,
  TraceMindAIModelResponse,
} from '@shared/core/tracemind/ai-investigation';
import { TraceMindAIGateway, type TraceMindAISecretStore } from '../ai/gateway';
import { retrieveAIInvestigationEvidence } from '../investigation/ai-evidence';
import {
  createIssue,
  getIssue,
  listIssueEvents,
  recordAIInvestigation,
} from '../investigation/issue-store';
import { generateRuntimeAIAdvisory } from './ai-advisor';
import { TraceMindRuntimeAIQueue } from './ai-queue';
import {
  getLatestRuntimeAIAdvisory,
  getRuntimeAIEnabled,
  recordRuntimeAIAdvisory,
  setRuntimeAIEnabled,
} from './ai-state-store';
import { parseRuntimeJson, type RuntimeSnapshot } from './model';
import { getRuntimeSignals, ingestRuntimeSignals } from './telemetry-store';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));

class MemorySecrets implements TraceMindAISecretStore {
  readonly values = new Map<string, string>();
  async getSecret(key: string) {
    return this.values.get(key) ?? null;
  }
  async setSecret(key: string, value: string) {
    this.values.set(key, value);
  }
  async deleteSecret(key: string) {
    this.values.delete(key);
  }
}

function incidentAnswer(id: string): TraceMindAIModelResponse {
  return {
    summary: 'A runtime error was observed.',
    summaryEvidenceIds: [id],
    hypotheses: [
      {
        rank: 1,
        statement: 'A service may have returned an error.',
        confidence: 'low',
        rationale: 'A single local correlation group was found.',
        evidenceIds: [id],
      },
    ],
    recommendations: [
      {
        rank: 1,
        action: 'Review the trace locally.',
        rationale: 'The incident grouping is heuristic.',
        evidenceIds: [id],
      },
    ],
    limitations: ['Advisory only; no root cause is established.'],
  };
}

function issueAnswer(id: string): TraceMindAIModelResponse {
  return {
    summary: 'The report describes a nested-path lookup miss.',
    summaryEvidenceIds: [id],
    hypotheses: [
      {
        rank: 1,
        statement: 'The lookup may use a non-normalized path.',
        confidence: 'low',
        rationale: 'The local issue record describes only the symptom.',
        evidenceIds: [id],
      },
    ],
    recommendations: [
      {
        rank: 1,
        action: 'Add a nested-path regression fixture.',
        rationale: 'A focused fixture would reproduce the reported behavior.',
        evidenceIds: [id],
      },
    ],
    limitations: ['No source excerpt or runtime trace was linked to the issue.'],
  };
}

describe('TraceMind runtime AI end-to-end local flow', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    vi.useRealTimers();
    fixture.close();
    mocks.db = undefined;
  });

  it('keeps egress off by default, then sends bounded incident summaries through the fake gateway into a local report', async () => {
    const projectId = 'project-1';
    const disabledAuditId = '00000000-0000-4000-8000-000000000301';
    const enabledAuditId = '00000000-0000-4000-8000-000000000302';
    const payload = JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payments' } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1730000000000000000',
                  severityText: 'ERROR',
                  body: { stringValue: 'authorization: Bearer synthetic-runtime-secret-123456' },
                  attributes: [
                    { key: 'access_token', value: { stringValue: 'runtime-token-secret' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const signals = parseRuntimeJson('logs', payload).signals;
    const secrets = new MemorySecrets();
    let citationId = '';
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(incidentAnswer(citationId)) } }],
          })
        )
    );
    const gateway = new TraceMindAIGateway({
      secrets,
      fetcher: fetcher as typeof fetch,
      projectPolicy: async () => ({
        enabled: true,
        bridgeEnabled: false,
        shareNotes: true,
        allowedPaths: [],
        endpoint: 'https://api.example.test/v1',
        model: 'fixture',
        root: '/fixture',
        identity: '1:2',
      }),
    });
    await gateway.configureProvider({
      endpoint: 'https://api.example.test/v1',
      model: 'fixture',
      apiKey: 'synthetic-provider-key',
    });
    const queue = new TraceMindRuntimeAIQueue({
      analyze: (snapshot, incidents, signal) =>
        generateRuntimeAIAdvisory(
          snapshot,
          incidents,
          (bundle, requestSignal) => gateway.generateResponse(bundle, { signal: requestSignal }),
          signal
        ),
      persist: (advisory) =>
        recordRuntimeAIAdvisory(advisory.projectId, advisory.auditId, advisory),
    });

    expect(await getRuntimeAIEnabled(projectId, disabledAuditId)).toBe(false);
    const disabledSnapshot = await ingestRuntimeSignals(
      projectId,
      disabledAuditId,
      'rev-1',
      signals
    );
    if (await getRuntimeAIEnabled(projectId, disabledAuditId)) queue.observe(disabledSnapshot);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await getLatestRuntimeAIAdvisory(projectId, disabledAuditId)).toBeNull();

    await setRuntimeAIEnabled(projectId, enabledAuditId, true);
    const baseline: RuntimeSnapshot = await getRuntimeSignals(projectId, enabledAuditId);
    vi.useFakeTimers();
    queue.enable(baseline);
    const observed = await ingestRuntimeSignals(projectId, enabledAuditId, 'rev-2', signals);
    citationId = observed.incidents[0]!.id;
    if (await getRuntimeAIEnabled(projectId, enabledAuditId)) queue.observe(observed);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledOnce();
    const latest = await getLatestRuntimeAIAdvisory(projectId, enabledAuditId);
    expect(latest).toMatchObject({
      projectId,
      auditId: enabledAuditId,
      model: 'fixture',
      summary: 'A runtime error was observed.',
      incidentIds: [citationId],
    });
    const requestBody = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(requestBody).not.toContain('synthetic-runtime-secret-123456');
    expect(requestBody).not.toContain('runtime-token-secret');
    expect(requestBody).not.toContain('runtime-token');
  });
});

describe('TraceMind issue AI end-to-end local flow', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('retrieves a local issue, tests the saved provider, generates a cited advisory, and persists it without resolving the issue', async () => {
    const projectId = 'project-1';
    const root = await mkdtemp(join(tmpdir(), 'tracemind-issue-ai-e2e-'));
    try {
      const issue = await createIssue(projectId, {
        title: 'Nested lookup misses a result',
        description:
          'The lookup misses files under nested folders. api_key=synthetic-issue-secret-123456',
      });
      const bundle = await retrieveAIInvestigationEvidence(projectId, issue, root);
      const issueEvidence = bundle.evidence.find((item) => item.kind === 'issue');
      expect(issueEvidence).toBeDefined();

      const secrets = new MemorySecrets();
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/models')) return new Response('{"data":[]}');
        const request = JSON.parse(String(init?.body)) as {
          messages: { role: string; content: string }[];
        };
        const userContent = JSON.parse(
          request.messages.find((message) => message.role === 'user')!.content
        ) as { evidence: { id: string }[] };
        const citationId = userContent.evidence.find((item) => item.id === issueEvidence!.id)!.id;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(issueAnswer(citationId)) } }],
          })
        );
      });
      const gateway = new TraceMindAIGateway({
        secrets,
        fetcher: fetcher as typeof fetch,
        projectPolicy: async () => ({
          enabled: true,
          bridgeEnabled: false,
          shareNotes: true,
          allowedPaths: [],
          endpoint: 'https://api.example.test/v1',
          model: 'fixture',
          root: '/fixture',
          identity: '1:2',
        }),
      });
      await gateway.configureProvider({
        endpoint: 'https://api.example.test/v1',
        model: 'fixture',
        apiKey: 'synthetic-provider-key',
      });

      await expect(gateway.testConnection()).resolves.toMatchObject({ connected: true });
      const { model, response } = await gateway.generateResponse(bundle);
      const citedIds = new Set([
        ...response.summaryEvidenceIds,
        ...response.hypotheses.flatMap((hypothesis) => hypothesis.evidenceIds),
        ...response.recommendations.flatMap((recommendation) => recommendation.evidenceIds),
      ]);
      const investigation: TraceMindAIInvestigation = {
        ...response,
        schemaVersion: 1,
        id: randomUUID(),
        provider: 'openai-compatible',
        model,
        generatedAt: Date.now(),
        evidenceRevision: bundle.currentRevision,
        freshness: 'unknown',
        evidenceReferences: bundle.evidence
          .filter((item) => citedIds.has(item.id))
          .map(({ excerpt: _excerpt, ...reference }) => reference),
      };
      const recorded = await recordAIInvestigation(
        projectId,
        issue.id,
        issue.version,
        issue.currentRevision,
        investigation
      );
      const storedEvents = await listIssueEvents(projectId, issue.id);
      const storedAdvisory = storedEvents.find((event) => event.type === 'ai_investigation');
      const requestBody = String(fetcher.mock.calls[1]?.[1]?.body);

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.test/v1/models');
      expect(requestBody).not.toContain('synthetic-issue-secret-123456');
      expect(recorded.issue).toMatchObject({
        id: issue.id,
        version: issue.version + 1,
        status: 'open',
        investigationState: 'reported',
        resolutionRationale: null,
        resolvedAt: null,
      });
      expect(storedAdvisory?.aiInvestigation).toMatchObject({
        summary: 'The report describes a nested-path lookup miss.',
        evidenceReferences: [{ id: issueEvidence!.id }],
      });
      expect(storedAdvisory?.aiInvestigation?.evidenceReferences[0]).not.toHaveProperty('excerpt');
      expect((await getIssue(projectId, issue.id))?.status).toBe('open');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
