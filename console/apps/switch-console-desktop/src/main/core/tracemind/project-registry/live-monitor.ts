import { isAbsolute, relative, resolve, sep } from 'node:path';
import parcelWatcher from '@parcel/watcher';
import {
  recordAuditInvalidation,
  type AuditInvalidation,
  type AuditInvalidationInput,
} from '../audit/audit-store';
import { isExcludedPathEntry } from '../audit/exclusions';

export const LIVE_MONITOR_MAX_BATCH_EVENTS = 1_000;
export const LIVE_MONITOR_MAX_CHANGED_PATHS = 200;
const locationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const auditIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identityPattern = /^\d{1,40}:\d{1,40}$/;

export type LiveMonitorState = 'idle' | 'watching' | 'overflow' | 'error' | 'stopped';
export type LiveMonitorEvent = { path: string; type: 'create' | 'update' | 'delete' };
export type LiveMonitorCallback = (error: Error | null, events: LiveMonitorEvent[]) => void;
export type LiveMonitorSubscription = { unsubscribe(): Promise<void> };
export type LiveMonitorSubscribe = (
  root: string,
  callback: LiveMonitorCallback,
  options?: { ignore?: string[] }
) => Promise<LiveMonitorSubscription>;

export interface LiveMonitorTarget {
  locationId: string;
  auditId: string;
  /** Canonical absolute audit root, never supplied by a renderer. */
  root: string;
  /** Filesystem identity captured by the audit. */
  identity: string;
}

export interface LiveMonitorDependencies {
  /** Reopens the canonical root and returns its current filesystem identity. */
  currentIdentity(root: string): Promise<string | null>;
  /** Revalidates the persisted audit fingerprint after subscription is attached. */
  verifySnapshot?: () => Promise<boolean>;
  subscribe?: LiveMonitorSubscribe;
  persist?: typeof recordAuditInvalidation;
  now?: () => number;
}

export interface LiveMonitorSnapshot {
  state: LiveMonitorState;
  started: boolean;
  closed: boolean;
  lastInvalidation: AuditInvalidation | null;
}

function normalizeEventPath(root: string, absolutePath: string): string | null {
  if (!isAbsolute(absolutePath) || /[\x00-\x1f\x7f]/.test(absolutePath)) return null;
  const relativePath = relative(root, resolve(absolutePath)).split(sep).join('/');
  if (
    !relativePath ||
    relativePath === '.' ||
    relativePath.startsWith('../') ||
    relativePath === '..' ||
    relativePath.startsWith('/') ||
    relativePath.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(relativePath)
  )
    return null;
  const parts = relativePath.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return null;

  // Exclusions are checked component-by-component. Excluded names are never persisted,
  // which prevents an ignored credential path from appearing in an audit report.
  for (let index = 0; index < parts.length; index++) {
    const prefix = parts.slice(0, index + 1).join('/');
    // Only ancestors are known directories. Treating the final component as a
    // directory drops eligible files named `build`, `target`, `dist`, etc., so
    // later changes to those files would never invalidate the snapshot.
    if (isExcludedPathEntry(parts[index]!, index < parts.length - 1, prefix)) return null;
  }
  return relativePath;
}

function isOverflowError(error: Error): boolean {
  return /overflow|dropped events|queue (?:is )?full|resource exhaustion/i.test(error.message);
}

/**
 * Watches changes after a persisted audit without changing its snapshot or fingerprint.
 * Callers must explicitly start this object after user consent and bind it to the audit's
 * captured root identity. A stopped/error/overflow marker makes freshness unknown/stale.
 */
export class TraceMindLiveMonitor {
  private stateValue: LiveMonitorState = 'idle';
  private subscription: LiveMonitorSubscription | null = null;
  private started = false;
  private closed = false;
  private lastInvalidation: AuditInvalidation | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<(snapshot: LiveMonitorSnapshot) => void>();

  constructor(
    private readonly target: LiveMonitorTarget,
    private readonly dependencies: LiveMonitorDependencies
  ) {
    if (!locationIdPattern.test(target.locationId)) throw new Error('Invalid project location');
    if (!auditIdPattern.test(target.auditId)) throw new Error('Invalid audit identity');
    if (!isAbsolute(target.root) || resolve(target.root) !== target.root)
      throw new Error('A canonical absolute audit root is required');
    if (!identityPattern.test(target.identity)) throw new Error('Invalid audit root identity');
    if (typeof dependencies.currentIdentity !== 'function')
      throw new Error('Root identity verifier is required');
  }

  get snapshot(): LiveMonitorSnapshot {
    return {
      state: this.stateValue,
      started: this.started,
      closed: this.closed,
      lastInvalidation: this.lastInvalidation,
    };
  }

  /** Subscribes the main-process controller to persisted status changes; raw native error text is never emitted. */
  onUpdate(listener: (snapshot: LiveMonitorSnapshot) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot);
    } catch {
      // A subscriber cannot prevent later status notifications.
    }
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Live monitor can only be started once');
    this.started = true;
    this.stateValue = 'watching';
    if (!(await this.rootIdentityMatches())) {
      await this.fail('error');
      throw new Error('Audit root identity changed before monitoring started');
    }

    try {
      const subscribe = this.dependencies.subscribe ?? parcelWatcher.subscribe;
      const subscription = await subscribe(this.target.root, (error, events) => {
        this.enqueueEvents(error, events);
      });
      if (this.closed) {
        await subscription.unsubscribe();
        return;
      }
      this.subscription = subscription;
      if (!(await this.rootIdentityMatches())) {
        await this.fail('error');
        throw new Error('Audit root identity changed while monitoring started');
      }
      if (this.closed) return;
      let snapshotMatches = false;
      try {
        snapshotMatches = (await this.dependencies.verifySnapshot?.()) === true;
      } catch {
        // Snapshot verification is advisory state, but monitoring must fail closed
        // when it cannot establish that the subscribed tree matches the audit.
      }
      if (!snapshotMatches) {
        await this.fail('error');
        throw new Error(
          'Audit snapshot changed or could not be verified before monitoring started'
        );
      }
      await this.whenIdle();
      if (this.closed) {
        const finalState = this.snapshot.state;
        if (finalState === 'error' || finalState === 'overflow') {
          throw new Error('Live monitor stopped while snapshot verification was finishing');
        }
        return;
      }
      // A watcher event may have arrived while the snapshot verification was in
      // flight. It already persisted the stronger changed-path marker; do not
      // append a zero-change startup record over that evidence.
      if (this.lastInvalidation?.stale) return;
      this.lastInvalidation = await this.persist({
        state: 'watching',
        changedCount: 0,
        changedPaths: [],
        pathsTruncated: false,
      });
      this.notify();
    } catch (error) {
      if (!this.closed) await this.fail('error');
      throw error instanceof Error ? error : new Error('Live monitor could not start');
    }
  }

  async stop(): Promise<void> {
    if (this.closed) {
      await this.queue;
      // A prior storage error may have left only a non-stale `watching` marker.
      // Retrying the terminal transition here makes shutdown/repeated stop a
      // recovery opportunity without reopening the monitor.
      if (this.stateValue === 'error' && this.lastInvalidation?.state !== 'error') {
        await this.persistFailureState('error');
      }
      return;
    }
    if (!this.started) {
      this.closed = true;
      this.stateValue = 'stopped';
      this.notify();
      return;
    }
    this.closed = true;
    await this.unsubscribe();
    await this.queue;
    if (
      this.stateValue === 'watching' ||
      this.stateValue === 'idle' ||
      this.stateValue === 'error'
    ) {
      const terminalState = this.stateValue === 'error' ? 'error' : 'stopped';
      this.stateValue = terminalState;
      this.lastInvalidation = await this.persist({
        state: terminalState,
        changedCount: 0,
        changedPaths: [],
        pathsTruncated: false,
      });
      this.notify();
    }
  }

  /** Waits for already delivered native events to finish their persistence transition. */
  async whenIdle(): Promise<void> {
    while (true) {
      const queued = this.queue;
      await queued;
      if (queued === this.queue) return;
    }
  }

  private enqueueEvents(error: Error | null, events: LiveMonitorEvent[]): void {
    if (this.closed) return;
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return;
        if (error) {
          await this.fail(isOverflowError(error) ? 'overflow' : 'error');
          return;
        }
        await this.processEvents(events);
      })
      .catch(async () => {
        await this.fail('error');
      });
  }

  private async processEvents(events: LiveMonitorEvent[]): Promise<void> {
    if (!(await this.rootIdentityMatches())) {
      await this.fail('error');
      return;
    }
    const overflow = events.length > LIVE_MONITOR_MAX_BATCH_EVENTS;
    const unique = new Set<string>();
    let invalidPath = false;
    for (const event of events.slice(0, LIVE_MONITOR_MAX_BATCH_EVENTS)) {
      if (!event || !['create', 'update', 'delete'].includes(event.type)) {
        invalidPath = true;
        continue;
      }
      if (typeof event.path === 'string' && isAbsolute(event.path)) {
        const relativeEventPath = relative(this.target.root, resolve(event.path));
        // Parcel may emit the watched root itself as a synthetic initial-create event.
        if (relativeEventPath === '' || relativeEventPath === '.') continue;
      }
      const path = normalizeEventPath(this.target.root, event.path);
      if (path === null) {
        // Excluded paths intentionally have no persisted marker. Other invalid/out-of-root
        // paths are treated as watcher loss rather than being silently accepted.
        if (typeof event.path !== 'string' || !isAbsolute(event.path)) invalidPath = true;
        else {
          const relativePath = relative(this.target.root, resolve(event.path));
          const withinRoot =
            relativePath !== '..' &&
            !relativePath.startsWith(`..${sep}`) &&
            !isAbsolute(relativePath);
          if (!withinRoot) invalidPath = true;
          else if (relativePath === '' || relativePath === '.') invalidPath = true;
          else if (relativePath.length > 4096) invalidPath = true;
          else if (/[\x00-\x1f\x7f]/.test(relativePath)) invalidPath = true;
          else if (
            relativePath.split(sep).some((part) => part === '.' || part === '..' || part === '')
          )
            invalidPath = true;
        }
        continue;
      }
      unique.add(path);
    }
    const changedPaths = [...unique].sort().slice(0, LIVE_MONITOR_MAX_CHANGED_PATHS);
    const pathsTruncated = overflow || invalidPath || unique.size > LIVE_MONITOR_MAX_CHANGED_PATHS;
    if (unique.size === 0 && !pathsTruncated) return;
    const state = invalidPath ? 'error' : pathsTruncated ? 'overflow' : 'watching';
    this.stateValue = state;
    try {
      this.lastInvalidation = await this.persist({
        state,
        changedCount: Math.min(
          1_000_000,
          unique.size + (overflow ? events.length - LIVE_MONITOR_MAX_BATCH_EVENTS : 0)
        ),
        changedPaths,
        pathsTruncated,
      });
    } catch {
      // Do not leave the process-local subscription able to resume after an
      // invalidation write failed. Retry a terminal error marker once; even if
      // storage stays unavailable, the in-memory monitor closes as stale/error.
      await this.fail('error');
      return;
    }
    if (state !== 'watching') {
      this.closed = true;
      await this.unsubscribe();
    }
    this.notify();
  }

  private async rootIdentityMatches(): Promise<boolean> {
    try {
      return (await this.dependencies.currentIdentity(this.target.root)) === this.target.identity;
    } catch {
      return false;
    }
  }

  private async fail(state: 'overflow' | 'error'): Promise<void> {
    this.stateValue = state;
    this.closed = true;
    await this.unsubscribe();
    await this.persistFailureState(state);
  }

  private async persistFailureState(state: 'overflow' | 'error'): Promise<void> {
    try {
      this.lastInvalidation = await this.persist({
        state,
        changedCount: 0,
        changedPaths: [],
        pathsTruncated: state === 'overflow',
      });
      this.notify();
    } catch {
      // Keep an in-memory error state when durable storage is itself unavailable.
      this.stateValue = 'error';
      this.notify();
    }
  }

  private async persist(
    input: Omit<AuditInvalidationInput, 'eventAt'>
  ): Promise<AuditInvalidation> {
    const persist = this.dependencies.persist ?? recordAuditInvalidation;
    return persist(this.target.locationId, this.target.auditId, {
      ...input,
      eventAt: this.dependencies.now?.() ?? Date.now(),
    });
  }

  private async unsubscribe(): Promise<void> {
    const subscription = this.subscription;
    this.subscription = null;
    if (!subscription) return;
    try {
      await subscription.unsubscribe();
    } catch {
      this.stateValue = 'error';
      this.notify();
    }
  }

  private notify(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A renderer/status subscriber cannot interrupt filesystem monitoring or persistence.
      }
    }
  }
}

export function createTraceMindLiveMonitor(
  target: LiveMonitorTarget,
  dependencies: LiveMonitorDependencies
): TraceMindLiveMonitor {
  return new TraceMindLiveMonitor(target, dependencies);
}
