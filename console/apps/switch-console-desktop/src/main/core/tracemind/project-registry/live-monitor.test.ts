import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { auditSnapshotMatchesCurrent, runLocalAudit } from '../audit/audit-service';
import type { AuditInvalidation, AuditInvalidationInput } from '../audit/audit-store';
import { AUDIT_ANALYZER_VERSION } from '../audit/audit-version';
import type { NativeProjectFs } from '../native/access-registry';
import {
  LIVE_MONITOR_MAX_CHANGED_PATHS,
  LIVE_MONITOR_MAX_BATCH_EVENTS,
  createTraceMindLiveMonitor,
  type LiveMonitorCallback,
  type LiveMonitorEvent,
} from './live-monitor';

vi.mock('../audit/audit-store', () => ({ recordAuditInvalidation: vi.fn() }));

const locationId = 'local-1';
const auditId = '70000000-0000-4000-8000-000000000001';

function getNative(): NativeProjectFs {
  return createRequire(import.meta.url)(
    join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
  ) as NativeProjectFs;
}

function fixture(
  identityValues: (string | null)[] = ['1:2'],
  options: { verifySnapshot?: () => Promise<boolean>; onSubscribe?: () => void } = {}
) {
  const persisted: AuditInvalidationInput[] = [];
  let previous: AuditInvalidation | null = null;
  let callback: LiveMonitorCallback | null = null;
  const unsubscribe = vi.fn(async () => undefined);
  let sequence = 0;
  const currentIdentity = vi.fn(async () => identityValues.shift() ?? '1:2');
  const monitor = createTraceMindLiveMonitor(
    { locationId, auditId, root: '/repo', identity: '1:2' },
    {
      currentIdentity,
      verifySnapshot: options.verifySnapshot ?? (async () => true),
      subscribe: async (root, nextCallback) => {
        expect(root).toBe('/repo');
        callback = nextCallback;
        options.onSubscribe?.();
        return { unsubscribe };
      },
      persist: async (projectId, audit, input) => {
        expect(projectId).toBe(locationId);
        expect(audit).toBe(auditId);
        persisted.push(input);
        sequence++;
        const paths = [
          ...new Set([...(previous?.changedPaths ?? []), ...input.changedPaths]),
        ].sort();
        const marker: AuditInvalidation = {
          locationId,
          auditId,
          state: input.state,
          stale:
            Boolean(previous?.stale) ||
            input.state !== 'watching' ||
            input.changedCount > 0 ||
            input.changedPaths.length > 0 ||
            input.pathsTruncated,
          sequence,
          eventAt: Math.max(previous?.eventAt ?? 0, input.eventAt),
          changedCount: (previous?.changedCount ?? 0) + input.changedCount,
          changedPaths: paths.slice(0, 200),
          pathsTruncated:
            Boolean(previous?.pathsTruncated) || input.pathsTruncated || paths.length > 200,
        };
        previous = marker;
        return marker;
      },
      now: () => sequence + 1,
    }
  );
  function emit(events: LiveMonitorEvent[], error: Error | null = null): void {
    if (!callback) throw new Error('watcher callback not registered');
    callback(error, events);
  }
  return { monitor, persisted, emit, unsubscribe, currentIdentity };
}

describe('TraceMind live local change monitor', () => {
  it('binds subscription to the audited identity, persists lifecycle, and tears down deterministically', async () => {
    const f = fixture();
    await f.monitor.start();
    expect(f.monitor.snapshot).toMatchObject({ state: 'watching', started: true, closed: false });
    expect(f.currentIdentity).toHaveBeenCalledTimes(2);
    expect(f.persisted).toMatchObject([{ state: 'watching', changedCount: 0, changedPaths: [] }]);

    await f.monitor.stop();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.monitor.snapshot).toMatchObject({ state: 'stopped', closed: true });
    expect(f.persisted.map(({ state }) => state)).toEqual(['watching', 'stopped']);
    expect(f.monitor.snapshot.lastInvalidation?.stale).toBe(true);
    await f.monitor.stop();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    await expect(f.monitor.start()).rejects.toThrow('once');
  });

  it('deduplicates changed paths, normalizes them relative to the root, and ignores excluded paths', async () => {
    const f = fixture();
    await f.monitor.start();
    f.emit([
      { type: 'update', path: '/repo/src/a.ts' },
      { type: 'create', path: '/repo/src/a.ts' },
      { type: 'delete', path: '/repo/src/b.ts' },
      { type: 'update', path: '/repo/.env.local' },
      { type: 'update', path: '/repo/node_modules/secret.txt' },
    ]);
    await f.monitor.whenIdle();
    expect(f.persisted.at(-1)).toMatchObject({
      state: 'watching',
      changedCount: 2,
      changedPaths: ['src/a.ts', 'src/b.ts'],
      pathsTruncated: false,
    });
    expect(f.monitor.snapshot.lastInvalidation?.stale).toBe(true);
    expect(JSON.stringify(f.persisted)).not.toContain('.env');
    expect(JSON.stringify(f.persisted)).not.toContain('secret.txt');
  });

  it('tracks an eligible file whose basename matches an excluded-directory name', async () => {
    const f = fixture();
    await f.monitor.start();
    f.emit([{ type: 'update', path: '/repo/src/build' }]);
    await f.monitor.whenIdle();

    expect(f.persisted.at(-1)).toMatchObject({
      state: 'watching',
      changedCount: 1,
      changedPaths: ['src/build'],
      pathsTruncated: false,
    });
    expect(f.monitor.snapshot.lastInvalidation?.stale).toBe(true);
  });

  it('marks invalid/out-of-root events as watcher error without persisting the foreign path', async () => {
    const f = fixture();
    await f.monitor.start();
    f.emit([{ type: 'update', path: '/outside/private/file.ts' }]);
    await f.monitor.whenIdle();
    expect(f.monitor.snapshot).toMatchObject({ state: 'error', closed: true });
    expect(f.persisted.at(-1)).toMatchObject({ state: 'error', changedPaths: [], changedCount: 0 });
    expect(JSON.stringify(f.persisted)).not.toContain('/outside');
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('marks bounded event/path overflow stale and stops collecting events', async () => {
    const f = fixture();
    await f.monitor.start();
    f.emit(
      Array.from({ length: LIVE_MONITOR_MAX_CHANGED_PATHS + 1 }, (_, index) => ({
        type: 'create' as const,
        path: `/repo/src/${index}.ts`,
      }))
    );
    await f.monitor.whenIdle();
    expect(f.monitor.snapshot).toMatchObject({ state: 'overflow', closed: true });
    expect(f.persisted.at(-1)?.state).toBe('overflow');
    expect(f.persisted.at(-1)?.changedPaths).toHaveLength(LIVE_MONITOR_MAX_CHANGED_PATHS);
    expect(f.persisted.at(-1)?.pathsTruncated).toBe(true);
    expect(f.monitor.snapshot.lastInvalidation?.stale).toBe(true);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);

    const oversized = fixture();
    await oversized.monitor.start();
    oversized.emit(
      Array.from({ length: LIVE_MONITOR_MAX_BATCH_EVENTS + 1 }, (_, index) => ({
        type: 'update' as const,
        path: `/repo/src/${index}.ts`,
      }))
    );
    await oversized.monitor.whenIdle();
    expect(oversized.monitor.snapshot.state).toBe('overflow');
    expect(oversized.persisted.at(-1)?.pathsTruncated).toBe(true);
  });

  it('distinguishes overflow and generic watcher loss while omitting raw native errors', async () => {
    const overrun = fixture();
    await overrun.monitor.start();
    overrun.emit([], new Error('native overflow: /private/secret/path'));
    await overrun.monitor.whenIdle();
    expect(overrun.monitor.snapshot.state).toBe('overflow');
    expect(overrun.persisted.at(-1)).toMatchObject({ state: 'overflow', pathsTruncated: true });
    expect(JSON.stringify(overrun.persisted)).not.toContain('/private/secret');

    const failed = fixture();
    await failed.monitor.start();
    failed.emit([], new Error('permission denied at /private/secret/path'));
    await failed.monitor.whenIdle();
    expect(failed.monitor.snapshot.state).toBe('error');
    expect(failed.persisted.at(-1)?.state).toBe('error');
    expect(JSON.stringify(failed.persisted)).not.toContain('/private/secret');
  });

  it('stops and invalidates evidence if the root identity changes during monitoring', async () => {
    const f = fixture(['1:2', '1:2', '9:9']);
    await f.monitor.start();
    f.emit([{ type: 'update', path: '/repo/src/a.ts' }]);
    await f.monitor.whenIdle();
    expect(f.monitor.snapshot).toMatchObject({ state: 'error', closed: true });
    expect(f.persisted.at(-1)).toMatchObject({ state: 'error', changedPaths: [], changedCount: 0 });
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('persists an error rather than leaving a watching marker when unsubscribe fails on stop', async () => {
    const f = fixture();
    await f.monitor.start();
    f.unsubscribe.mockRejectedValueOnce(new Error('native unsubscribe failed'));

    await f.monitor.stop();

    expect(f.monitor.snapshot).toMatchObject({ state: 'error', closed: true });
    expect(f.persisted.at(-1)).toMatchObject({
      state: 'error',
      changedCount: 0,
      changedPaths: [],
      pathsTruncated: false,
    });
    expect(f.monitor.snapshot.lastInvalidation).toMatchObject({ state: 'error', stale: true });
  });

  it('closes and retries a terminal stale marker after an event persistence failure', async () => {
    const persisted: AuditInvalidationInput[] = [];
    let callback: LiveMonitorCallback | null = null;
    let sequence = 0;
    const monitor = createTraceMindLiveMonitor(
      { locationId, auditId, root: '/repo', identity: '1:2' },
      {
        currentIdentity: async () => '1:2',
        verifySnapshot: async () => true,
        subscribe: async (_root, nextCallback) => {
          callback = nextCallback;
          return { unsubscribe: async () => undefined };
        },
        persist: async (projectId, audit, input) => {
          persisted.push(input);
          if (persisted.length === 2) throw new Error('transient storage failure');
          sequence++;
          return {
            locationId: projectId,
            auditId: audit,
            state: input.state,
            stale:
              input.state !== 'watching' ||
              input.changedCount > 0 ||
              input.changedPaths.length > 0 ||
              input.pathsTruncated,
            sequence,
            eventAt: input.eventAt,
            changedCount: input.changedCount,
            changedPaths: input.changedPaths,
            pathsTruncated: input.pathsTruncated,
          };
        },
      }
    );
    await monitor.start();
    const emit = callback as LiveMonitorCallback | null;
    if (!emit) throw new Error('watcher callback not registered');
    emit(null, [{ type: 'update', path: '/repo/src/a.ts' }]);
    await monitor.whenIdle();

    expect(monitor.snapshot).toMatchObject({ state: 'error', closed: true });
    expect(persisted.map(({ state }) => state)).toEqual(['watching', 'watching', 'error']);
    expect(monitor.snapshot.lastInvalidation).toMatchObject({ state: 'error', stale: true });
    emit(null, [{ type: 'update', path: '/repo/src/b.ts' }]);
    await monitor.whenIdle();
    expect(persisted).toHaveLength(3);
  });

  it('does not subscribe when the audit root identity changed before start', async () => {
    const f = fixture(['3:4']);
    await expect(f.monitor.start()).rejects.toThrow('identity changed');
    expect(f.monitor.snapshot).toMatchObject({ state: 'error', closed: true });
    expect(f.persisted.at(-1)?.state).toBe('error');
    expect(f.currentIdentity).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and marks the audit stale if the root is replaced during subscription setup', async () => {
    const f = fixture(['1:2', '9:9']);
    await expect(f.monitor.start()).rejects.toThrow('identity changed while monitoring started');
    expect(f.monitor.snapshot).toMatchObject({ state: 'error', closed: true });
    expect(f.persisted.at(-1)?.state).toBe('error');
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('fails stale when the persisted snapshot changed before watcher attachment', async () => {
    let subscribed = false;
    const f = fixture(['1:2', '1:2'], {
      onSubscribe: () => {
        subscribed = true;
      },
      verifySnapshot: async () => {
        expect(subscribed).toBe(true);
        return false;
      },
    });

    await expect(f.monitor.start()).rejects.toThrow('snapshot changed');

    expect(f.monitor.snapshot).toMatchObject({ state: 'error', closed: true });
    expect(f.persisted).toMatchObject([
      {
        state: 'error',
        changedCount: 0,
        changedPaths: [],
        pathsTruncated: false,
      },
    ]);
    expect(f.monitor.snapshot.lastInvalidation?.stale).toBe(true);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it('preserves a watcher change queued while snapshot verification is pending', async () => {
    let callback: LiveMonitorCallback | null = null;
    let sequence = 0;
    let resolveVerification!: (matches: boolean) => void;
    let notifyVerificationStarted: (() => void) | null = null;
    const verificationStarted = new Promise<void>((resolve) => {
      notifyVerificationStarted = resolve;
    });
    const verification = new Promise<boolean>((resolve) => {
      resolveVerification = resolve;
    });
    const persisted: AuditInvalidationInput[] = [];
    const monitor = createTraceMindLiveMonitor(
      { locationId, auditId, root: '/repo', identity: '1:2' },
      {
        currentIdentity: async () => '1:2',
        subscribe: async (_root, nextCallback) => {
          callback = nextCallback;
          return { unsubscribe: async () => undefined };
        },
        verifySnapshot: async () => {
          const emit = callback;
          if (!emit) throw new Error('subscription was not installed');
          emit(null, [{ type: 'update', path: '/repo/src/during-preflight.ts' }]);
          notifyVerificationStarted?.();
          return verification;
        },
        persist: async (projectId, audit, input) => {
          persisted.push(input);
          sequence++;
          return {
            locationId: projectId,
            auditId: audit,
            state: input.state,
            stale:
              input.state !== 'watching' ||
              input.changedCount > 0 ||
              input.changedPaths.length > 0 ||
              input.pathsTruncated,
            sequence,
            eventAt: input.eventAt,
            changedCount: input.changedCount,
            changedPaths: input.changedPaths,
            pathsTruncated: input.pathsTruncated,
          };
        },
      }
    );

    const starting = monitor.start();
    await verificationStarted;
    resolveVerification(true);
    await starting;

    expect(persisted).toEqual([
      expect.objectContaining({
        state: 'watching',
        changedCount: 1,
        changedPaths: ['src/during-preflight.ts'],
      }),
    ]);
    expect(monitor.snapshot).toMatchObject({ state: 'watching', closed: false });
    expect(monitor.snapshot.lastInvalidation?.stale).toBe(true);
  });

  it('revalidates the actual saved audit after subscribing and invalidates an audit-to-watch edit', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'tracemind-audit-watch-gap-'));
    const root = await realpath(temporaryRoot);
    try {
      const filePath = join(root, 'main.ts');
      await writeFile(filePath, 'export const value = 1;\n');
      const info = await stat(root, { bigint: true });
      const identity = `${info.dev}:${info.ino}`;
      const native = getNative();
      const audit = await runLocalAudit(locationId, {
        consume: async () => ({ locationId, root, identity }),
        native,
        save: async (record) => ({
          ...record,
          id: auditId,
          analysisVersion: AUDIT_ANALYZER_VERSION,
        }),
      });
      expect(await auditSnapshotMatchesCurrent(audit, native)).toBe(true);

      // This edit occurs after the saved audit but before the watcher is installed.
      await writeFile(filePath, 'export const value = 2;\n');
      let subscribed = false;
      let sequence = 0;
      const persisted: AuditInvalidationInput[] = [];
      const monitor = createTraceMindLiveMonitor(
        { locationId, auditId, root, identity },
        {
          currentIdentity: async () => identity,
          subscribe: async () => {
            subscribed = true;
            return { unsubscribe: async () => undefined };
          },
          verifySnapshot: async () => {
            expect(subscribed).toBe(true);
            return auditSnapshotMatchesCurrent(audit, native);
          },
          persist: async (projectId, persistedAuditId, input) => {
            persisted.push(input);
            sequence++;
            return {
              ...input,
              locationId: projectId,
              auditId: persistedAuditId,
              stale: input.state !== 'watching' || input.changedCount > 0,
              sequence,
            };
          },
        }
      );

      await expect(monitor.start()).rejects.toThrow('snapshot changed');
      expect(monitor.snapshot).toMatchObject({ state: 'error', closed: true });
      expect(persisted).toMatchObject([
        {
          state: 'error',
          changedCount: 0,
          changedPaths: [],
          pathsTruncated: false,
        },
      ]);
      expect(monitor.snapshot.lastInvalidation?.stale).toBe(true);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('receives a real local file event from the native watcher and persists its relative path', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'tracemind-live-monitor-'));
    const root = await realpath(temporaryRoot);
    const persisted: AuditInvalidationInput[] = [];
    let sequence = 0;
    const monitor = createTraceMindLiveMonitor(
      { locationId, auditId, root, identity: '1:2' },
      {
        currentIdentity: async () => '1:2',
        verifySnapshot: async () => true,
        persist: async (projectId, audit, input) => {
          persisted.push(input);
          sequence++;
          return {
            locationId: projectId,
            auditId: audit,
            state: input.state,
            stale:
              input.state !== 'watching' ||
              input.changedCount > 0 ||
              input.changedPaths.length > 0 ||
              input.pathsTruncated,
            sequence,
            eventAt: input.eventAt,
            changedCount: input.changedCount,
            changedPaths: input.changedPaths,
            pathsTruncated: input.pathsTruncated,
          };
        },
      }
    );
    try {
      await monitor.start();
      await writeFile(join(root, 'src-check.ts'), 'export const value = 1;\n');
      const deadline = Date.now() + 5_000;
      while (
        !persisted.some((item) => item.changedPaths.includes('src-check.ts')) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await monitor.whenIdle();
      expect(persisted.some((item) => item.changedPaths.includes('src-check.ts'))).toBe(true);
      expect(monitor.snapshot.lastInvalidation?.stale).toBe(true);
    } finally {
      await monitor.stop();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
