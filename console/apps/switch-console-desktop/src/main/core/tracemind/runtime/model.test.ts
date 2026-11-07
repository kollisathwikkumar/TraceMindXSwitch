import { describe, expect, it } from 'vitest';
import { correlateRuntimeIncidents, parseRuntimeJson, type RuntimeSignal } from './model';

describe('TraceMind runtime signal normalization', () => {
  it('normalizes OTLP spans and redacts credential-like attributes', () => {
    const parsed = parseRuntimeJson('traces', JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
        scopeSpans: [{ spans: [{
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
          name: 'POST /checkout',
          startTimeUnixNano: '1730000000000000000',
          status: { code: 2 },
          attributes: [
            { key: 'http.route', value: { stringValue: '/checkout' } },
            { key: 'api_key', value: { stringValue: 'do-not-store-this' } },
          ],
        }] }],
      }],
    }));
    expect(parsed.signals).toHaveLength(1);
    expect(parsed.signals[0]).toMatchObject({
      kind: 'span', source: 'otlp', serviceName: 'api', name: 'POST /checkout', status: 'error',
      traceId: '0123456789abcdef0123456789abcdef', observedAt: 1_730_000_000_000,
      attributes: { 'http.route': '/checkout', '[redacted-key]': '[REDACTED]' },
    });
    expect(JSON.stringify(parsed)).not.toContain('do-not-store-this');
  });

  it('normalizes OTLP log bodies and scalar metrics', () => {
    const logs = parseRuntimeJson('logs', JSON.stringify({
      resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'worker' } }] }, scopeLogs: [{ logRecords: [{
        timeUnixNano: '1730000000000000000', severityText: 'ERROR', body: { stringValue: 'password=private failed' },
        traceId: '0123456789abcdef0123456789abcdef',
      }] }] }],
    }));
    expect(logs.signals[0]).toMatchObject({ kind: 'log', severity: 'ERROR', message: 'password=[REDACTED] failed', serviceName: 'worker' });
    const metrics = parseRuntimeJson('metrics', JSON.stringify({
      resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'worker' } }] }, scopeMetrics: [{ metrics: [{
        name: 'queue.depth', unit: 'items', gauge: { dataPoints: [{ timeUnixNano: '1730000000000000000', asDouble: 12.5, attributes: [] }] },
      }] }] }],
    }));
    expect(metrics.signals[0]).toMatchObject({ kind: 'metric', name: 'queue.depth', value: 12.5, unit: 'items' });
  });

  it('imports Jaeger query JSON and deduplicates identical spans', () => {
    const response = JSON.stringify({ data: [{
      traceID: '0123456789abcdef',
      spans: [{ traceID: '0123456789abcdef', spanID: 'fedcba9876543210', operationName: 'db.query', startTime: 1730000000000000, processID: 'p1', tags: [{ key: 'error', type: 'bool', value: true }] }],
      processes: { p1: { serviceName: 'database', tags: [] } },
    }] });
    const parsed = parseRuntimeJson('jaeger', response);
    expect(parseRuntimeJson('jaeger', response).signals).toEqual(parsed.signals);
    expect(parsed).toMatchObject({ rejectedCount: 0, signals: [{ source: 'jaeger', kind: 'span', serviceName: 'database', status: 'error', observedAt: 1_730_000_000_000 }] });
  });

  it('rejects malformed, wrong-route, and oversized payloads', () => {
    expect(() => parseRuntimeJson('traces', '{not json')).toThrow('valid JSON');
    expect(() => parseRuntimeJson('logs', JSON.stringify({ resourceSpans: [] }))).toThrow('missing its logs');
    expect(() => parseRuntimeJson('jaeger', 'x'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MiB');
  });
});

describe('runtime incident correlation', () => {
  function signal(overrides: Partial<RuntimeSignal>): RuntimeSignal {
    return {
      id: `${'a'.repeat(63)}0`, kind: 'log', source: 'otlp', observedAt: 1_730_000_000_000,
      serviceName: 'api', name: 'log:ERROR', severity: 'ERROR', attributes: {}, ...overrides,
    };
  }

  it('groups errors by shared trace id, but keeps unrelated traces separated', () => {
    const incidents = correlateRuntimeIncidents([
      signal({ id: 'a'.repeat(64), traceId: '1'.repeat(32) }),
      signal({ id: 'b'.repeat(64), traceId: '1'.repeat(32), observedAt: 1_730_000_000_100 }),
      signal({ id: 'c'.repeat(64), traceId: '2'.repeat(32) }),
    ]);
    expect(incidents).toHaveLength(2);
    expect(incidents.find((item) => item.correlation === 'trace_id' && item.signalCount === 2)).toBeDefined();
    expect(incidents.every((item) => item.explanation.includes('not proof'))).toBe(true);
  });

  it('flags a metric point at least five times its prior median and ignores ordinary values', () => {
    const baseline = [1, 2, 2, 3, 2].map((value, index) => signal({
      id: index.toString(16).padStart(64, '0'), kind: 'metric', name: 'latency', severity: 'INFO',
      value, observedAt: 1_730_000_000_000 + index,
    }));
    expect(correlateRuntimeIncidents([...baseline, signal({ id: 'f'.repeat(64), kind: 'metric', name: 'latency', severity: 'INFO', value: 20, observedAt: 1_730_000_000_005 })]).some((item) => item.correlation === 'metric_deviation')).toBe(true);
    expect(correlateRuntimeIncidents([...baseline, signal({ id: 'e'.repeat(64), kind: 'metric', name: 'latency', severity: 'INFO', value: 4, observedAt: 1_730_000_000_005 })])).toHaveLength(0);
  });
});
