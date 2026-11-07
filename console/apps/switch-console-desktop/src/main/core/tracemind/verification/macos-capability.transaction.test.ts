import { describe, expect, it } from 'vitest';
import { getMacosCheckCapability } from './macos-capability';
import { detectSandboxMode, getSandboxExecutable } from './sandbox';

describe('macOS capability transaction', () => {
  it.skipIf(process.platform !== 'darwin')(
    'derives run eligibility from the live Seatbelt probe and fixed executable',
    () => {
      const mode = detectSandboxMode('darwin');
      const capability = getMacosCheckCapability(mode);

      if (mode === 'macos-sandbox-exec') {
        expect(getSandboxExecutable(mode)).toBe('/usr/bin/sandbox-exec');
        expect(capability).toMatchObject({
          status: 'runtime-available-unverified',
          canRunDiscoveredChecks: true,
          sandboxAvailable: true,
          missingControls: ['memoryBytes', 'processCount'],
        });
      } else {
        expect(capability).toMatchObject({
          status: 'unavailable',
          canRunDiscoveredChecks: false,
          sandboxAvailable: false,
        });
      }
    }
  );

  it('does not advertise run eligibility for an unavailable sandbox mode', () => {
    expect(getMacosCheckCapability('unavailable')).toMatchObject({
      status: 'unavailable',
      canRunDiscoveredChecks: false,
      sandboxAvailable: false,
    });
  });
});
