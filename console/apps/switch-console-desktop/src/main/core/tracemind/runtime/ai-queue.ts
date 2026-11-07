import type { TraceMindRuntimeAIAdvisory } from '@shared/core/tracemind/ai-investigation';
import { generateRuntimeAIAdvisory } from './ai-advisor';
import type { RuntimeIncident, RuntimeSnapshot } from './model';

export const RUNTIME_AI_DEBOUNCE_MS = 2_000;
export const RUNTIME_AI_MIN_INTERVAL_MS = 60_000;
export const RUNTIME_AI_MAX_INCIDENTS_PER_CALL = 10;
export const RUNTIME_AI_MAX_PENDING_INCIDENTS = 100;
export const RUNTIME_AI_MAX_SEEN_INCIDENTS = 2_000;
export const RUNTIME_AI_MAX_ATTEMPTS_PER_BATCH = 3;
export const RUNTIME_AI_RETRY_BASE_MS = 60_000;
export const RUNTIME_AI_RETRY_MAX_MS = 300_000;

export interface TraceMindRuntimeAIQueueOptions {
  analyze?: (
    snapshot: RuntimeSnapshot,
    incidents: readonly RuntimeIncident[],
    signal?: AbortSignal
  ) => Promise<TraceMindRuntimeAIAdvisory>;
  persist?: (advisory: TraceMindRuntimeAIAdvisory) => Promise<void>;
  onError?: (scope: Pick<RuntimeSnapshot, 'locationId' | 'auditId'>) => void | Promise<void>;
  now?: () => number;
  debounceMs?: number;
  cooldownMs?: number;
  retryBaseMs?: number;
}

interface RuntimeAIQueueState {
  enabled: boolean;
  latest: RuntimeSnapshot;
  knownIncidentIds: Set<string>;
  pending: Map<string, RuntimeIncident>;
  attempts: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  abortController: AbortController | null;
  lastStartedAt: number | null;
  retryNotBefore: number;
}

function queueKey(snapshot: Pick<RuntimeSnapshot, 'locationId' | 'auditId'>): string {
  return `${snapshot.locationId}:${snapshot.auditId}`;
}

/**
 * Coalesces only newly received incident groups. A persisted per-audit opt-in
 * must call `enable` before any data can reach the provider. At most ten
 * incidents are sent per model call, calls are debounced and cooled down, and
 * no raw log, span, metric attribute, trace id, or code is passed to `analyze`.
 */
export class TraceMindRuntimeAIQueue {
  private readonly states = new Map<string, RuntimeAIQueueState>();
  private readonly analyze: NonNullable<TraceMindRuntimeAIQueueOptions['analyze']>;
  private readonly persist: NonNullable<TraceMindRuntimeAIQueueOptions['persist']>;
  private readonly onError: NonNullable<TraceMindRuntimeAIQueueOptions['onError']>;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly cooldownMs: number;
  private readonly retryBaseMs: number;

  constructor(options: TraceMindRuntimeAIQueueOptions = {}) {
    this.analyze =
      options.analyze ??
      ((snapshot, incidents, signal) =>
        generateRuntimeAIAdvisory(snapshot, incidents, undefined, signal));
    this.persist = options.persist ?? (async () => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? RUNTIME_AI_DEBOUNCE_MS;
    this.cooldownMs = options.cooldownMs ?? RUNTIME_AI_MIN_INTERVAL_MS;
    this.retryBaseMs = Math.min(
      Math.max(0, options.retryBaseMs ?? RUNTIME_AI_RETRY_BASE_MS),
      RUNTIME_AI_RETRY_MAX_MS
    );
  }

  /** Enables egress from this point forward; incidents already in the snapshot are baseline only. */
  enable(snapshot: RuntimeSnapshot): void {
    const key = queueKey(snapshot);
    const prior = this.states.get(key);
    if (prior) {
      prior.enabled = true;
      prior.latest = snapshot;
      for (const incident of snapshot.incidents) this.remember(prior.knownIncidentIds, incident.id);
      return;
    }
    const knownIncidentIds = new Set<string>();
    for (const incident of snapshot.incidents) this.remember(knownIncidentIds, incident.id);
    this.states.set(key, {
      enabled: true,
      latest: snapshot,
      knownIncidentIds,
      pending: new Map<string, RuntimeIncident>(),
      attempts: new Map<string, number>(),
      timer: null,
      running: false,
      abortController: null,
      lastStartedAt: null,
      retryNotBefore: 0,
    });
  }

  disable(locationId: string, auditId: string): void {
    const key = `${locationId}:${auditId}`;
    const state = this.states.get(key);
    if (!state) return;
    state.enabled = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.pending.clear();
    state.abortController?.abort();
    this.states.delete(key);
  }

  closeAll(): void {
    for (const key of this.states.keys()) {
      const separator = key.indexOf(':');
      this.disable(key.slice(0, separator), key.slice(separator + 1));
    }
  }

  observe(snapshot: RuntimeSnapshot): void {
    const key = queueKey(snapshot);
    const state = this.states.get(key);
    if (!state?.enabled) return;
    state.latest = snapshot;
    for (const incident of snapshot.incidents) {
      if (state.knownIncidentIds.has(incident.id)) continue;
      this.remember(state.knownIncidentIds, incident.id);
      if (state.pending.size >= RUNTIME_AI_MAX_PENDING_INCIDENTS) continue;
      state.pending.set(incident.id, incident);
    }
    if (state.pending.size > 0) this.schedule(key, state);
  }

  private schedule(key: string, state: RuntimeAIQueueState): void {
    if (!state.enabled || state.running || state.timer || state.pending.size === 0) return;
    const cooldownRemaining =
      state.lastStartedAt === null ? 0 : state.lastStartedAt + this.cooldownMs - this.now();
    const retryRemaining = state.retryNotBefore - this.now();
    const delay = Math.max(this.debounceMs, cooldownRemaining, retryRemaining);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.drain(key, state);
    }, delay);
  }

  private remember(known: Set<string>, id: string): void {
    known.add(id);
    while (known.size > RUNTIME_AI_MAX_SEEN_INCIDENTS) {
      const oldest = known.values().next().value;
      if (!oldest) return;
      known.delete(oldest);
    }
  }

  private async drain(key: string, state: RuntimeAIQueueState): Promise<void> {
    if (!state.enabled || this.states.get(key) !== state || state.running) return;
    const incidents = [...state.pending.values()].slice(0, RUNTIME_AI_MAX_INCIDENTS_PER_CALL);
    if (incidents.length === 0) return;
    for (const incident of incidents) {
      state.pending.delete(incident.id);
      state.attempts.set(incident.id, (state.attempts.get(incident.id) ?? 0) + 1);
    }
    const snapshot = state.latest;
    state.running = true;
    const abortController = new AbortController();
    state.abortController = abortController;
    state.lastStartedAt = this.now();
    try {
      const advisory = await this.analyze(snapshot, incidents, abortController.signal);
      if (state.enabled && this.states.get(key) === state) {
        await this.persist(advisory);
        for (const incident of incidents) state.attempts.delete(incident.id);
        state.retryNotBefore = 0;
      }
    } catch {
      // Provider details may contain endpoint or request metadata; do not log them.
      if (state.enabled && this.states.get(key) === state) {
        let retryDelay = 0;
        for (const incident of incidents) {
          const attempts = state.attempts.get(incident.id) ?? 1;
          if (
            attempts < RUNTIME_AI_MAX_ATTEMPTS_PER_BATCH &&
            state.pending.size < RUNTIME_AI_MAX_PENDING_INCIDENTS
          ) {
            state.pending.set(incident.id, incident);
            retryDelay = Math.max(
              retryDelay,
              Math.min(this.retryBaseMs * 2 ** (attempts - 1), RUNTIME_AI_RETRY_MAX_MS)
            );
          } else {
            state.attempts.delete(incident.id);
          }
        }
        if (retryDelay > 0) {
          state.retryNotBefore = Math.max(state.retryNotBefore, this.now() + retryDelay);
        }
      }
      try {
        await this.onError({ locationId: snapshot.locationId, auditId: snapshot.auditId });
      } catch {
        // A status sink must not break the receiver's ingestion loop.
      }
    } finally {
      state.running = false;
      state.abortController = null;
      this.schedule(key, state);
    }
  }
}
