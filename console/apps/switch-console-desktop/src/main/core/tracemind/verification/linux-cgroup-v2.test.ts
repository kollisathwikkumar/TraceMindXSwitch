import { describe, expect, it, vi } from 'vitest';
import { preflightLinuxCgroupLimits, type LinuxCgroupLimits } from './linux-cgroup-v2';

const limits: LinuxCgroupLimits = { processCount: 32, memoryBytes: 1_073_741_824 };

describe('Linux cgroup capability preflight', () => {
  it('reports ready only after the transient configured group is cleaned up', async () => {
    const cleanup = vi.fn().mockResolvedValue(true);
    const prepare = vi.fn().mockResolvedValue({
      procsFd: 17,
      terminate: vi.fn(),
      cleanup,
    });

    await expect(preflightLinuxCgroupLimits(limits, prepare)).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledWith(limits);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('fails closed when setup is unavailable or cleanup cannot be confirmed', async () => {
    const unavailable = vi.fn().mockResolvedValue(null);
    await expect(preflightLinuxCgroupLimits(limits, unavailable)).resolves.toBe(false);

    const cleanup = vi.fn().mockResolvedValue(false);
    const prepared = vi.fn().mockResolvedValue({
      procsFd: 18,
      terminate: vi.fn(),
      cleanup,
    });
    await expect(preflightLinuxCgroupLimits(limits, prepared)).resolves.toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();

    const rejectedCleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
    const preparedWithRejectedCleanup = vi.fn().mockResolvedValue({
      procsFd: 19,
      terminate: vi.fn(),
      cleanup: rejectedCleanup,
    });
    await expect(preflightLinuxCgroupLimits(limits, preparedWithRejectedCleanup)).resolves.toBe(
      false
    );
    expect(rejectedCleanup).toHaveBeenCalledOnce();

    const failedSetup = vi.fn().mockRejectedValue(new Error('cgroup unavailable'));
    await expect(preflightLinuxCgroupLimits(limits, failedSetup)).resolves.toBe(false);
  });
});
