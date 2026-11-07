import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProcessAdapter, ResourceLimitRefusalError } from './process-adapter';
import { detectSandboxMode } from './sandbox';

if (process.env.TRACEMIND_REQUIRE_WINDOWS === '1' && process.platform !== 'win32') {
  throw new Error('TRACEMIND_REQUIRE_WINDOWS=1 requires a Windows runner');
}

it.skipIf(process.platform === 'linux')(
  'does not claim unavailable memory/process controls and requires Seatbelt for native macOS runs',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracemind-resource-fail-closed-'));
    const marker = join(directory, 'must-not-exist');
    const base = {
      executable: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      cwd: directory,
      env: {},
      timeoutMs: 5000,
      outputBytes: 1000,
    };
    try {
      if (process.platform === 'darwin') {
        await expect(
          new ProcessAdapter().run({
            ...base,
            sandboxMode: 'unavailable',
            memoryBytes: 64 * 1024 * 1024,
            processCount: 2,
          })
        ).rejects.toThrow('macOS checks require the available Seatbelt sandbox');
        await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        if (detectSandboxMode() === 'macos-sandbox-exec') {
          const result = await new ProcessAdapter().run({
            ...base,
            sandboxMode: 'macos-sandbox-exec',
            memoryBytes: 64 * 1024 * 1024,
            processCount: 2,
          });
          expect(result).toMatchObject({
            status: 'exited',
            exitCode: 0,
            effectiveLimits: { memory: false, processCount: false },
            terminationUnconfirmed: true,
            capturedComplete: false,
          });
          expect(await readFile(marker, 'utf8')).toBe('started');
        }
        return;
      }
      const memory = new ProcessAdapter().run({ ...base, memoryBytes: 64 * 1024 * 1024 });
      await expect(memory).rejects.toBeInstanceOf(ResourceLimitRefusalError);
      await expect(memory).rejects.toMatchObject({
        platform: process.platform,
        missingControls: ['memoryBytes'],
      });
      await expect(new ProcessAdapter().run({ ...base, processCount: 2 })).rejects.toMatchObject({
        platform: process.platform,
        missingControls: ['processCount'],
      });
      await expect(
        new ProcessAdapter().run({
          ...base,
          memoryBytes: 64 * 1024 * 1024,
          processCount: 2,
        })
      ).rejects.toMatchObject({
        platform: process.platform,
        missingControls: ['memoryBytes', 'processCount'],
      });
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
