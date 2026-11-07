import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMacosCheckCapability, macosMissingResourceControls } from './macos-capability';
import { ProcessAdapter } from './process-adapter';
import { detectSandboxMode } from './sandbox';

describe('macOS discovered-check capability', () => {
  it('allows Seatbelt-confined execution while identifying the mode as unverified', () => {
    expect(getMacosCheckCapability('macos-sandbox-exec')).toEqual({
      platform: 'darwin',
      status: 'runtime-available-unverified',
      canRunDiscoveredChecks: true,
      sandboxMode: 'macos-sandbox-exec',
      sandboxAvailable: true,
      missingControls: ['memoryBytes', 'processCount'],
      reason: expect.stringContaining('every result remains unverified'),
    });
  });

  it('also reports missing sandbox support without claiming resource control', () => {
    const capability = getMacosCheckCapability('unavailable');
    expect(capability).toMatchObject({
      platform: 'darwin',
      status: 'unavailable',
      canRunDiscoveredChecks: false,
      sandboxAvailable: false,
      missingControls: macosMissingResourceControls,
    });
    expect(capability.reason).toContain('sandbox is unavailable');
  });

  it('refuses to start a Darwin check when Seatbelt is unavailable, even without resource caps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracemind-macos-unavailable-'));
    const marker = join(directory, 'must-not-start');
    const handle = await open(directory, 'r');
    try {
      const info = await handle.stat({ bigint: true });
      await expect(
        new ProcessAdapter('darwin').run({
          executable: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
          cwd: directory,
          env: {},
          timeoutMs: 5_000,
          outputBytes: 1_000,
          sandboxMode: 'unavailable',
          pinnedCwd: {
            fd: handle.fd,
            identity: `${info.dev}:${info.ino}`,
            helperExecutable: process.execPath,
          },
        })
      ).rejects.toThrow('macOS checks require the available Seatbelt sandbox');
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'runs a check under Seatbelt and records requested memory/process caps as unenforced',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'tracemind-macos-capability-'));
      const marker = join(directory, 'target-started');
      try {
        const result = await new ProcessAdapter().run({
          executable: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');console.log('native-check-ran')`,
          ],
          cwd: directory,
          env: {},
          timeoutMs: 5_000,
          outputBytes: 1_000,
          sandboxMode: 'macos-sandbox-exec',
          processCount: 2,
          memoryBytes: 64 * 1024 * 1024,
        });
        expect(result).toMatchObject({
          status: 'exited',
          exitCode: 0,
          sandboxMode: 'macos-sandbox-exec',
          terminationUnconfirmed: true,
          capturedComplete: false,
          effectiveLimits: { processCount: false, memory: false },
        });
        expect(result.stdout).toContain('native-check-ran');
        expect(await readFile(marker, 'utf8')).toBe('started');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'darwin' || detectSandboxMode() !== 'macos-sandbox-exec')(
    'allows multiple separately approved clean checks while keeping each result unverified',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'tracemind-macos-sequential-'));
      const adapter = new ProcessAdapter();
      try {
        const run = (message: string) =>
          adapter.run({
            executable: process.execPath,
            args: ['-e', `process.stdout.write(${JSON.stringify(message)})`],
            cwd: directory,
            env: {},
            timeoutMs: 5_000,
            outputBytes: 1_000,
            sandboxMode: 'macos-sandbox-exec',
          });
        const first = await run('first-check');
        const second = await run('second-check');

        expect(first).toMatchObject({
          status: 'exited',
          exitCode: 0,
          stdout: 'first-check',
          sandboxMode: 'macos-sandbox-exec',
          terminationUnconfirmed: true,
          capturedComplete: false,
          effectiveLimits: { processCount: false, memory: false },
        });
        expect(second).toMatchObject({
          status: 'exited',
          exitCode: 0,
          stdout: 'second-check',
          sandboxMode: 'macos-sandbox-exec',
          terminationUnconfirmed: true,
          capturedComplete: false,
          effectiveLimits: { processCount: false, memory: false },
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
