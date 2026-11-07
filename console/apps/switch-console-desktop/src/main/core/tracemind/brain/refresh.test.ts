import { afterEach, expect, it, vi } from 'vitest';
import { BrainRefreshQueue } from './refresh';
const marker = {
  locationId: 'p1',
  auditId: 'a1',
  state: 'watching' as const,
  stale: true,
  sequence: 1,
  eventAt: 1,
  changedCount: 1,
  changedPaths: ['src/a.ts'],
  pathsTruncated: false,
};
afterEach(() => vi.useRealTimers());
it('coalesces bursts, refreshes locally and keeps a second change arriving during refresh', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const refresh = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve('a2');
        })
    )
    .mockResolvedValue('a3');
  const record = vi.fn();
  const queue = new BrainRefreshQueue({ refresh, record, delayMs: 10 });
  queue.observe(marker);
  queue.observe({ ...marker, sequence: 2 });
  await vi.advanceTimersByTimeAsync(10);
  expect(refresh).toHaveBeenCalledTimes(1);
  queue.observe({ ...marker, sequence: 3 });
  finish();
  await vi.advanceTimersByTimeAsync(20);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(record).toHaveBeenLastCalledWith(
    expect.objectContaining({ sequence: 3, state: 'refreshed', auditId: 'a3' })
  );
  await queue.close();
});
it('cancels pending work on stop and records failed refresh without retry loops', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockRejectedValue(new Error('private error'));
  const record = vi.fn();
  const queue = new BrainRefreshQueue({ refresh, record, delayMs: 10 });
  queue.observe(marker);
  await vi.advanceTimersByTimeAsync(10);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
  expect(JSON.stringify(record.mock.calls)).not.toContain('private error');
  queue.observe({ ...marker, sequence: 2 });
  await queue.close();
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(1);
});
it('does not refresh after overflow or a terminal watcher state', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const queue = new BrainRefreshQueue({ refresh, record: vi.fn(), delayMs: 10 });
  queue.observe(marker);
  queue.observe({ ...marker, sequence: 2, state: 'overflow' });
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).not.toHaveBeenCalled();
  await queue.close();
});
