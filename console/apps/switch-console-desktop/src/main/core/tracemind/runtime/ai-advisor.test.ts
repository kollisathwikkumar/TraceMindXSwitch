import { describe, expect, it, vi } from 'vitest';
import type { TraceMindEvidenceBundle } from '@shared/core/tracemind/ai-investigation';
import { TraceMindAIGateway, type TraceMindAISecretStore } from '../ai/gateway';
import { generateRuntimeAIAdvisory } from './ai-advisor';
import type { RuntimeIncident, RuntimeSnapshot, RuntimeSignal } from './model';

const signal: RuntimeSignal = {
  id: 'a'.repeat(64),
  kind: 'log',
  source: 'otlp',
  observedAt: 1_730_000_000_000,
  serviceName: 'payments',
  name: 'authorization_failure',
  severity: 'ERROR',
  status: 'error',
  message: 'authorization: Bearer runtime-secret-12345678',
  attributes: { access_token: 'runtime-token-value' },
};

const incident: RuntimeIncident = {
  id: 'b'.repeat(64),
  severity: 'error',
  serviceName: 'payments',
  title: 'Errors in one service time window',
  firstSeenAt: 1_730_000_000_000,
  lastSeenAt: 1_730_000_000_000,
  signalCount: 1,
  signalIds: [signal.id],
  correlation: 'service_time_window',
  explanation: 'Signals share a time window; this is not causal proof.',
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

describe('TraceMind runtime AI advisor', () => {
  it('completes the incident-to-gateway workflow with a synthetic provider and no raw telemetry', async () => {
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
      summary: 'The payment service emitted an error.',
      summaryEvidenceIds: [incident.id],
      hypotheses: [
        {
          rank: 1,
          statement: 'The payment service returned an error.',
          confidence: 'low' as const,
          rationale: 'The local correlator grouped one error signal.',
          evidenceIds: [incident.id],
        },
      ],
      recommendations: [
        {
          rank: 1,
          action: 'Inspect the matching telemetry locally.',
          rationale: 'The incident is a triage hint, not proof of root cause.',
          evidenceIds: [incident.id],
        },
      ],
      limitations: ['AI output is advisory.'],
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
        model: 'fixture-model',
        root: '/fixture',
        identity: '1:2',
      }),
    });
    await gateway.configureProvider({
      endpoint: 'https://api.example.test/v1',
      model: 'fixture-model',
      apiKey: 'synthetic-provider-key',
    });

    const advisory = await generateRuntimeAIAdvisory(snapshot, [incident], (bundle) =>
      gateway.generateResponse(bundle)
    );

    expect(advisory.summary).toBe(modelAnswer.summary);
    expect(advisory.incidentIds).toEqual([incident.id]);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-provider-key');
    const payload = String(init?.body);
    expect(payload).toContain('Runtime incident review');
    expect(payload).not.toContain('Runtime incident 1'); // Free-form labels are not an egress field.
    expect(payload).not.toContain('runtime-secret-12345678');
    expect(payload).not.toContain('runtime-token-value');
    expect(payload).not.toContain('payment_failure');
  });

  it('sends only bounded, allow-listed incident summaries and returns cited advisory output', async () => {
    const generate = vi.fn(async (_bundle: TraceMindEvidenceBundle) => ({
      model: 'fixture-model',
      response: {
        summary: 'A runtime error was observed.',
        summaryEvidenceIds: [incident.id],
        hypotheses: [
          {
            rank: 1,
            statement: 'The payment service returned an error.',
            confidence: 'low' as const,
            rationale: 'The deterministic telemetry correlator grouped one error.',
            evidenceIds: [incident.id],
          },
        ],
        recommendations: [
          {
            rank: 1,
            action: 'Inspect the matching trace in the local telemetry viewer.',
            rationale: 'The incident points to a trace-level correlation.',
            evidenceIds: [incident.id],
          },
        ],
        limitations: ['This is not proof of root cause.'],
      },
    }));

    const advisory = await generateRuntimeAIAdvisory(snapshot, [incident], generate);

    expect(generate).toHaveBeenCalledOnce();
    const bundle = generate.mock.calls[0]?.[0];
    expect(bundle?.evidence).toHaveLength(1);
    expect(bundle?.evidence[0]).toMatchObject({
      id: incident.id,
      kind: 'runtime',
      path: null,
      revision: 'rev-1',
      freshness: 'fresh',
    });
    expect(JSON.stringify(bundle)).not.toContain('runtime-secret-12345678');
    expect(JSON.stringify(bundle)).not.toContain('runtime-token-value');
    expect(JSON.stringify(bundle)).not.toContain('signalIds');
    expect(advisory).toMatchObject({
      provider: 'openai-compatible',
      model: 'fixture-model',
      incidentIds: [incident.id],
      evidenceRevision: 'rev-1',
      summary: 'A runtime error was observed.',
    });
    expect(advisory.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects empty incident input without calling the provider', async () => {
    const generate = vi.fn();
    await expect(generateRuntimeAIAdvisory(snapshot, [], generate)).rejects.toThrow(
      'No new runtime incidents are available for analysis.'
    );
    expect(generate).not.toHaveBeenCalled();
  });
});
