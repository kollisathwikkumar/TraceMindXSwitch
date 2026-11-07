import type { SandboxMode } from './sandbox';

export const macosMissingResourceControls = ['memoryBytes', 'processCount'] as const;
export type MacosMissingResourceControl = (typeof macosMissingResourceControls)[number];

export interface MacosCheckCapability {
  platform: 'darwin';
  status: 'runtime-available-unverified' | 'unavailable';
  canRunDiscoveredChecks: boolean;
  sandboxMode: SandboxMode;
  sandboxAvailable: boolean;
  missingControls: readonly MacosMissingResourceControl[];
  reason: string;
}

/**
 * Describes the honest native macOS execution mode. Seatbelt can confine writes
 * and block network access, but no supported per-run memory/process-tree limit
 * or complete descendant termination proof is available. Checks may therefore
 * run in Seatbelt only as unverified evidence; missing limits remain visible.
 */
export function getMacosCheckCapability(sandboxMode: SandboxMode): MacosCheckCapability {
  const sandboxAvailable = sandboxMode === 'macos-sandbox-exec';
  const canRunDiscoveredChecks = sandboxAvailable;
  return {
    platform: 'darwin',
    status: canRunDiscoveredChecks ? 'runtime-available-unverified' : 'unavailable',
    canRunDiscoveredChecks,
    sandboxMode,
    sandboxAvailable,
    missingControls: macosMissingResourceControls,
    reason: sandboxAvailable
      ? 'macOS checks can run inside Seatbelt with writes confined to the approved project and temporary directory and network access denied. Per-run memory and process-count caps are not enforced, and detached descendants cannot be confirmed; every result remains unverified.'
      : 'The macOS Seatbelt sandbox is unavailable. Checks are withheld because this runner does not start unconfined project scripts.',
  };
}
