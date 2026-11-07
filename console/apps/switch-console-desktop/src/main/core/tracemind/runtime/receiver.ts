import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RUNTIME_MAX_BODY_BYTES, parseRuntimeJson, type RuntimeSignal } from './model';

const loopbackHost = '127.0.0.1';
const maxHeaderBytes = 16 * 1024;

export type RuntimeReceiverRoute = 'traces' | 'logs' | 'metrics' | 'jaeger';
export type RuntimeReceiverStatus = {
  active: boolean;
  endpoint: string | null;
  startedAt: number | null;
};
export type RuntimeReceiverHandle = RuntimeReceiverStatus & {
  token: string;
  close(): Promise<void>;
};

function reply(response: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ accepted: status >= 200 && status < 300, message });
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function routeFor(request: IncomingMessage): RuntimeReceiverRoute | null {
  if (request.method !== 'POST') return null;
  switch (new URL(request.url ?? '/', 'http://127.0.0.1').pathname) {
    case '/v1/traces':
      return 'traces';
    case '/v1/logs':
      return 'logs';
    case '/v1/metrics':
      return 'metrics';
    case '/v1/jaeger/traces':
      return 'jaeger';
    default:
      return null;
  }
}

function hasValidBearer(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const length = request.headers['content-length'];
  if (typeof length === 'string' && (!/^\d+$/.test(length) || Number(length) > RUNTIME_MAX_BODY_BYTES)) {
    throw new Error('Telemetry payload exceeds the 2 MiB request limit');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > RUNTIME_MAX_BODY_BYTES) throw new Error('Telemetry payload exceeds the 2 MiB request limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export async function startRuntimeReceiver(
  onSignals: (signals: RuntimeSignal[], rejectedCount: number) => Promise<unknown>,
  options: { port?: number; now?: () => number } = {}
): Promise<RuntimeReceiverHandle> {
  const token = randomBytes(32).toString('base64url');
  const now = options.now ?? Date.now;
  let closePromise: Promise<void> | null = null;
  let isActive = false;
  let server: Server;

  server = createServer({ maxHeaderSize: maxHeaderBytes }, (request, response) => {
    void (async () => {
      if (request.headers.origin) {
        reply(response, 403, 'Browser-origin requests are not accepted');
        request.resume();
        return;
      }
      if (!hasValidBearer(request, token)) {
        reply(response, 401, 'A valid local receiver bearer token is required');
        request.resume();
        return;
      }
      const route = routeFor(request);
      if (!route) {
        reply(response, 404, 'Unsupported telemetry endpoint');
        request.resume();
        return;
      }
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        reply(response, 415, 'Content-Type must be application/json');
        request.resume();
        return;
      }
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
        reply(response, 415, 'Compressed payloads are not supported');
        request.resume();
        return;
      }
      try {
        const parsed = parseRuntimeJson(route, await readBody(request));
        await onSignals(parsed.signals, parsed.rejectedCount);
        reply(response, 200, `Accepted ${parsed.signals.length} signal(s)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Telemetry payload could not be accepted';
        const status = /2 MiB|limit/i.test(message) ? 413 : 400;
        reply(response, status, message.slice(0, 256));
      }
    })().catch(() => {
      if (!response.headersSent) reply(response, 500, 'Telemetry ingestion failed');
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.port ?? 0, loopbackHost, () => {
      server.off('error', onError);
      isActive = true;
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== loopbackHost) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Runtime telemetry receiver could not bind exclusively to IPv4 loopback');
  }
  server.on('close', () => { isActive = false; });
  // Errors after the initial bind are reflected through the active status rather
  // than becoming an unhandled EventEmitter error in the desktop main process.
  server.on('error', () => { isActive = false; });
  const endpoint = `http://${loopbackHost}:${address.port}`;
  const startedAt = now();
  return {
    get active() { return isActive; },
    endpoint,
    startedAt,
    token,
    close: () => {
      if (!closePromise) {
        closePromise = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
      return closePromise;
    },
  };
}
