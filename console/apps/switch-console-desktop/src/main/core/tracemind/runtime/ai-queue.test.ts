import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceMindRuntimeAIAdvisory } from '@shared/core/tracemind/ai-investigation';
import { TraceMindAIGateway, type TraceMindAISecretStore } from '../ai/gateway';
import { generateRuntimeAIAdvisory } from './ai-advisor';
import { TraceMindRuntimeAIQueue } from './ai-queue';
import type { RuntimeIncident, RuntimeSnapshot, RuntimeSignal } from './model';

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
const incident: RuntimeIncident = {
  id: 'b'.repeat(64),
  severity: 'error',
  serviceName: 'payments',
  title: 'Errors in one service time window',
  firstSeenAt: signal.observedAt,
  lastSeenAt: signal.observedAt,
  signalCount: 1,
  signalIds: [signal.id],
  correlation: 'service_time_window',
  explanation: 'Signals share a time bucket.',
};
const snapshot: RuntimeSnapshot = {
  locationId: 'project-1',
  auditId: '00000000-0000-4000-8000-000000000101',
  auditRevision: 'rev-1',
  signals: [signal],
  incidents: [incident],
  acceptedCount: 1,
  droppedCount: 0,
  lastReceivedAt: signal.observedAt,
  truncated: false,
};

function advisory(incidentId: string): TraceMindRuntimeAIAdvisory {
  return {
    schemaVersion: 1,
    id: '00000000-0000-4000-8000-000000000201',
    provider: 'openai-compatible',
    model: 'fixture',
    generatedAt: Date.now(),
    projectId: snapshot.locationId,
    auditId: snapshot.auditId,
    evidenceRevision: 'rev-1',
    incidentIds: [incidentId],
    summary: 'Observed error.',
    summaryEvidenceIds: [incidentId],
    hypotheses: [
      {
        rank: 1,
        statement: 'Maybe an error occurred.',
        confidence: 'low',
        rationale: 'One signal.',
        evidenceIds: [incidentId],
      },
    ],
    recommendations: [
      {
        rank: 1,
        action: 'Review locally.',
        rationale: 'More evidence is needed.',
        evidenceIds: [incidentId],
      },
    ],
    limitations: ['Advisory only.'],
  };
}

describe('TraceMind runtime AI queue', () => {
  afterEach(() => vi.useRealTimers());

  it('does not call the provider until explicit opt-in, then excludes baseline incidents and deduplicates', async () => {
    vi.useFakeTimers();
    const analyze = vi.fn(
      async (_snapshot: RuntimeSnapshot, incidents: readonly RuntimeIncident[]) =>
        advisory(incidents[0]!.id)
    );
    const persist = vi.fn(async (_result: TraceMindRuntimeAIAdvisory) => undefined);
    const queue = new TraceMindRuntimeAIQueue({ analyze, persist });
    const fresh: RuntimeIncident = { ...incident, id: 'c'.repeat(64), title: 'Another error' };

    queue.observe({ ...snapshot, incidents: [incident, fresh] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(analyze).not.toHaveBeenCalled();

    queue.enable(snapshot);
    queue.observe({ ...snapshot, incidents: [incident, fresh] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0]?.[1].map((item) => item.id)).toEqual([fresh.id]);
    expect(persist).toHaveBeenCalledWith(advisory(fresh.id));

    queue.observe({ ...snapshot, incidents: [incident, fresh] });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(analyze).toHaveBeenCalledOnce();
  });

  it('coalesces new incident batches during the cooldown and stops queued egress when disabled', async () => {
    vi.useFakeTimers();
    const analyze = vi.fn(
      async (_snapshot: RuntimeSnapshot, incidents: readonly RuntimeIncident[]) =>
        advisory(incidents[0]!.id)
    );
    const persist = vi.fn(async (_result: TraceMindRuntimeAIAdvisory) => undefined);
    const queue = new TraceMindRuntimeAIQueue({ analyze, persist });
    queue.enable({ ...snapshot, incidents: [] });
    const first: RuntimeIncident = { ...incident, id: 'c'.repeat(64) };
    const second: RuntimeIncident = { ...incident, id: 'd'.repeat(64) };
    queue.observe({ ...snapshot, incidents: [first] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(analyze).toHaveBeenCalledOnce();

    queue.observe({ ...snapshot, incidents: [first, second] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(analyze).toHaveBeenCalledOnce();
    queue.disable(snapshot.locationId, snapshot.auditId);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(analyze).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight provider request when the user disables runtime analysis', async () => {
    vi.useFakeTimers();
    let abortObserved = false;
    const analyze = vi.fn(
      async (
        _snapshot: RuntimeSnapshot,
        _incidents: readonly RuntimeIncident[],
        signal?: AbortSignal
      ) =>
        await new Promise<TraceMindRuntimeAIAdvisory>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              abortObserved = true;
              reject(new Error('aborted'));
            },
            { once: true }
          );
        })
    );
    const persist = vi.fn(async (_result: TraceMindRuntimeAIAdvisory) => undefined);
    const queue = new TraceMindRuntimeAIQueue({ analyze, persist });
    queue.enable({ ...snapshot, incidents: [] });
    const fresh: RuntimeIncident = { ...incident, id: 'e'.repeat(64) };
    queue.observe({ ...snapshot, incidents: [fresh] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(analyze).toHaveBeenCalledOnce();
    const signalArg = analyze.mock.calls[0]?.[2];
    expect(signalArg).toBeInstanceOf(AbortSignal);

    queue.disable(snapshot.locationId, snapshot.auditId);
    await Promise.resolve();
    expect(abortObserved).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('records a generic per-audit failure status without forwarding provider error details', async () => {
    vi.useFakeTimers();
    const onError = vi.fn(async (_scope: { locationId: string; auditId: string }) => undefined);
    const analyze = vi.fn(async () => {
      throw new Error('https://provider.invalid/?token=synthetic-secret');
    });
    const queue = new TraceMindRuntimeAIQueue({ analyze, onError });
    queue.enable({ ...snapshot, incidents: [] });
    queue.observe(snapshot);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(onError).toHaveBeenCalledWith({
      locationId: snapshot.locationId,
      auditId: snapshot.auditId,
    });
    expect(JSON.stringify(onError.mock.calls)).not.toContain('synthetic-secret');
  });

  it('retries a transient provider failure once and persists the recovered advisory', async () => {
    vi.useFakeTimers();
    const fresh: RuntimeIncident = { ...incident, id: 'f'.repeat(64) };
    const analyze = vi
      .fn<
        (
          current: RuntimeSnapshot,
          incidents: readonly RuntimeIncident[]
        ) => Promise<TraceMindRuntimeAIAdvisory>
      >()
      .mockRejectedValueOnce(new Error('provider failed: synthetic-provider-secret'))
      .mockResolvedValueOnce(advisory(fresh.id));
    const persist = vi.fn(async (_result: TraceMindRuntimeAIAdvisory) => undefined);
    const onError = vi.fn(async (_scope: { locationId: string; auditId: string }) => undefined);
    const queue = new TraceMindRuntimeAIQueue({
      analyze,
      persist,
      onError,
      debounceMs: 1,
      cooldownMs: 0,
      retryBaseMs: 100,
    });
    queue.enable({ ...snapshot, incidents: [] });
    queue.observe({ ...snapshot, incidents: [fresh] });

    await vi.advanceTimersByTimeAsync(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Observed error.', incidentIds: [fresh.id] })
    );
    queue.disable(snapshot.locationId, snapshot.auditId);
  });

  it('stops after the initial attempt and two bounded retries', async () => {
    vi.useFakeTimers();
    const fresh: RuntimeIncident = { ...incident, id: '1'.repeat(64) };
    const analyze = vi.fn(async () => {
      throw new Error('provider failed: do-not-log-this-secret');
    });
    const onError = vi.fn(async (_scope: { locationId: string; auditId: string }) => undefined);
    const queue = new TraceMindRuntimeAIQueue({
      analyze,
      onError,
      debounceMs: 1,
      cooldownMs: 0,
      retryBaseMs: 100,
    });
    queue.enable({ ...snapshot, incidents: [] });
    queue.observe({ ...snapshot, incidents: [fresh] });

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(onError.mock.calls)).not.toContain('do-not-log-this-secret');
    queue.disable(snapshot.locationId, snapshot.auditId);
  });

  it('runs an opted-in runtime signal through the gateway and persists a synthetic-provider report', async () => {
    vi.useFakeTimers();
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
    const modelAnswer = {
      summary: 'A runtime error needs review.',
      summaryEvidenceIds: [incident.id],
      hypotheses: [
        {
          rank: 1,
          statement: 'An error occurred.',
          confidence: 'low' as const,
          rationale: 'A local group contained one error.',
          evidenceIds: [incident.id],
        },
      ],
      recommendations: [
        {
          rank: 1,
          action: 'Review the trace locally.',
          rationale: 'The grouping is heuristic.',
          evidenceIds: [incident.id],
        },
      ],
      limitations: ['Advisory, not proof.'],
    };
    const secrets = new MemorySecrets();
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelAnswer) } }] })
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
    const persist = vi.fn(async (_result: TraceMindRuntimeAIAdvisory) => undefined);
    const queue = new TraceMindRuntimeAIQueue({
      analyze: (current, incidents, signal) =>
        generateRuntimeAIAdvisory(
          current,
          incidents,
          (bundle, requestSignal) => gateway.generateResponse(bundle, { signal: requestSignal }),
          signal
        ),
      persist,
    });
    queue.enable({ ...snapshot, incidents: [] });

    queue.observe(snapshot);
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      summary: modelAnswer.summary,
      incidentIds: [incident.id],
      model: 'fixture',
    });
    const payload = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(payload).not.toContain('runtime-secret-12345678');
    expect(payload).not.toContain('runtime-token-value');
  });
});
