import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
const { getRuntimeSignals, ingestRuntimeSignals } = await import('./telemetry-store');
const { parseRuntimeJson } = await import('./model');

describe('TraceMind runtime telemetry persistence', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('persists and reloads audit-linked signals and deterministic incidents', async () => {
    const auditId = '00000000-0000-4000-8000-000000000101';
    const payload = JSON.stringify({ resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payments' } }] },
      scopeLogs: [{ logRecords: [{ timeUnixNano: '1730000000000000000', severityText: 'ERROR', body: { stringValue: 'declined' }, traceId: '0123456789abcdef0123456789abcdef' }] }],
    }] });
    const batch = parseRuntimeJson('logs', payload);
    const first = await ingestRuntimeSignals('project-1', auditId, 'fingerprint-1', batch.signals);
    const second = await ingestRuntimeSignals('project-1', auditId, 'fingerprint-1', batch.signals);
    const reopened = await getRuntimeSignals('project-1', auditId);
    expect(first).toMatchObject({ locationId: 'project-1', auditId, auditRevision: 'fingerprint-1', acceptedCount: 1, incidents: [{ correlation: 'trace_id' }] });
    expect(second.acceptedCount).toBe(1);
    expect(reopened).toEqual(second);
    expect(await getRuntimeSignals('project-2', auditId)).toMatchObject({ signals: [], incidents: [], acceptedCount: 0 });
  });

  it('bounds retention and accounts for payload rejections and prior-record duplicates', async () => {
    const auditId = '00000000-0000-4000-8000-000000000102';
    const span = parseRuntimeJson('traces', JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{ name: 'request', startTimeUnixNano: '1730000000000000000' }] }] }] })).signals[0]!;
    const duplicate = await ingestRuntimeSignals('project-1', auditId, null, [span, span], 3);
    expect(duplicate.signals).toHaveLength(1);
    expect(duplicate.acceptedCount).toBe(1);
    expect(duplicate.droppedCount).toBe(4);
  });
});
