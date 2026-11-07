import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRuntimeReceiver } from './receiver';
import type { RuntimeSignal } from './model';

describe('local runtime receiver', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('binds only to IPv4 loopback, authenticates, ingests OTLP JSON, and stops', async () => {
    const batches: RuntimeSignal[][] = [];
    const receiver = await startRuntimeReceiver(async (signals) => { batches.push(signals); });
    close = receiver.close;
    expect(receiver.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const payload = JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{ name: 'request', startTimeUnixNano: '1730000000000000000' }] }] }] });
    const missingAuth = await fetch(`${receiver.endpoint}/v1/traces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
    });
    expect(missingAuth.status).toBe(401);
    const browserPost = await fetch(`${receiver.endpoint}/v1/traces`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${receiver.token}`, origin: 'http://localhost:3000' }, body: payload,
    });
    expect(browserPost.status).toBe(403);
    const accepted = await fetch(`${receiver.endpoint}/v1/traces`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${receiver.token}` }, body: payload,
    });
    expect(accepted.status).toBe(200);
    expect(batches.flat()).toMatchObject([{ name: 'request', source: 'otlp' }]);
    await receiver.close();
    close = null;
    expect(receiver.active).toBe(false);
  });

  it('rejects unsupported methods, routes, content encodings and malformed payloads', async () => {
    const receiver = await startRuntimeReceiver(async () => undefined);
    close = receiver.close;
    const headers = { authorization: `Bearer ${receiver.token}`, 'content-type': 'application/json' };
    expect((await fetch(`${receiver.endpoint}/v1/logs`, { method: 'GET', headers })).status).toBe(404);
    expect((await fetch(`${receiver.endpoint}/unknown`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
    expect((await fetch(`${receiver.endpoint}/v1/logs`, { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: '{}' })).status).toBe(415);
    expect((await fetch(`${receiver.endpoint}/v1/logs`, { method: 'POST', headers, body: '{broken' })).status).toBe(400);
  });
});
