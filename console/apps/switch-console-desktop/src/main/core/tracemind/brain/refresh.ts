import type { AuditInvalidation } from '../audit/audit-store';
import type { BrainChange } from './store';

/** Single-flight, fixed-window coalescing: edits during a scan cause one additional scan. */
export class BrainRefreshQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: AuditInvalidation | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private lastSequence = 0;
  constructor(
    private readonly deps: {
      refresh(active: () => boolean): Promise<string>;
      record(change: BrainChange): Promise<void>;
      delayMs?: number;
    }
  ) {}
  observe(marker: AuditInvalidation): void {
    if (this.closed || marker.sequence <= this.lastSequence) return;
    this.lastSequence = marker.sequence;
    if (marker.state !== 'watching') {
      this.closed = true;
      this.pending = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (!marker.stale || marker.changedCount === 0) return;
    this.pending = marker;
    this.schedule();
  }
  private schedule(): void {
    if (this.closed || this.timer || this.running || !this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.flush().finally(() => {
        this.running = null;
        this.schedule();
      });
    }, this.deps.delayMs ?? 3000);
    this.timer.unref?.();
  }
  private async flush(): Promise<void> {
    const marker = this.pending;
    this.pending = null;
    if (!marker || this.closed) return;
    let auditId: string | null = null;
    let state: BrainChange['state'] = 'error';
    try {
      auditId = await this.deps.refresh(() => !this.closed);
      state = this.closed ? 'stopped' : 'refreshed';
    } catch {
      /* Keep raw filesystem/provider errors out of persisted notes. */
    }
    try {
      await this.deps.record({
        sequence: marker.sequence,
        at: Date.now(),
        paths: marker.changedPaths,
        truncated: marker.pathsTruncated,
        state,
        auditId,
      });
    } catch {
      this.closed = true;
      this.pending = null;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }
}
