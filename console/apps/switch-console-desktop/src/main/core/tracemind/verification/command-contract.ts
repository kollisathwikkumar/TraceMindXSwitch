import { posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { sandboxModes, type SandboxMode } from './sandbox';

/** A proposal is data, never an authorization to start a process. */
const safeRelativeDirectory = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    if (value === '.') return true;
    return (
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      !/[\x00-\x1f\x7f]/.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    );
  });

export const checkKinds = [
  'npm-script',
  'pnpm-script',
  'yarn-script',
  'bun-script',
  'python-pytest',
  'python-unittest',
  'go-test',
  'cargo-test',
  'maven-test',
  'gradle-test',
] as const;
export type CheckKind = (typeof checkKinds)[number];
export const checkExecutables = [
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'python3',
  'go',
  'cargo',
  'mvn',
  'gradle',
] as const;
export type CheckExecutable = (typeof checkExecutables)[number];

const commandShapes: Record<CheckKind, { executable: string; args: readonly string[] }> = {
  'npm-script': { executable: 'npm', args: ['run', 'test'] },
  'pnpm-script': { executable: 'pnpm', args: ['run', 'test'] },
  'yarn-script': { executable: 'yarn', args: ['test'] },
  'bun-script': { executable: 'bun', args: ['run', 'test'] },
  'python-pytest': { executable: 'python3', args: ['-m', 'pytest'] },
  'python-unittest': { executable: 'python3', args: ['-m', 'unittest', 'discover'] },
  'go-test': { executable: 'go', args: ['test', './...'] },
  'cargo-test': { executable: 'cargo', args: ['test', '--locked', '--offline'] },
  'maven-test': { executable: 'mvn', args: ['--offline', '--batch-mode', 'test'] },
  'gradle-test': { executable: 'gradle', args: ['--offline', 'test'] },
};

const scriptSchema = z
  .object({
    pretest: z.string().max(4096).optional(),
    test: z.string().max(4096).default(''),
    posttest: z.string().max(4096).optional(),
  })
  .strict();

export const commandProposalObjectSchema = z
  .object({
    /** Logical tool name only; production paths are resolved and fingerprinted by main process. */
    executable: z.enum(checkExecutables),
    args: z.array(z.string().max(4096)).min(1).max(16),
    /** Empty for fixed recipes; populated only by package-manager script proposals. */
    declaredScripts: scriptSchema.default({ test: '' }),
    checkKind: z.enum(checkKinds).default('npm-script'),
    workingDirectory: safeRelativeDirectory,
    revision: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/),
    environmentAllowlist: z.array(z.enum(['CI', 'NO_COLOR', 'FORCE_COLOR'])).max(3),
    limits: z
      .object({
        timeoutMs: z.number().int().min(1).max(600_000),
        outputBytes: z.number().int().min(1).max(10_000_000),
        processCount: z.number().int().min(1).max(128),
        memoryBytes: z.number().int().min(1).max(2_147_483_648),
      })
      .strict(),
    sandboxMode: z.enum(sandboxModes),
  })
  .strict();

export const commandProposalSchema = commandProposalObjectSchema.superRefine(
  (proposal, context) => {
    const expected = commandShapes[proposal.checkKind];
    if (
      proposal.executable !== expected.executable ||
      JSON.stringify(proposal.args) !== JSON.stringify(expected.args)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['args'],
        message: 'Command does not match recipe',
      });
    }
    const isPackageScript = proposal.checkKind.endsWith('-script');
    if (
      (isPackageScript && proposal.declaredScripts.test.length === 0) ||
      (!isPackageScript &&
        (proposal.declaredScripts.test.length > 0 ||
          proposal.declaredScripts.pretest !== undefined ||
          proposal.declaredScripts.posttest !== undefined))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['declaredScripts'],
        message: 'Package script metadata must match the selected recipe',
      });
    }
  }
);
export type CommandProposal = z.infer<typeof commandProposalSchema>;

const packageSchema = z
  .object({
    scripts: z
      .object({
        pretest: z.string().max(4096).optional(),
        test: z.string().min(1).max(4096).optional(),
        posttest: z.string().max(4096).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const defaultLimits = {
  timeoutMs: 60_000,
  outputBytes: 1_000_000,
  processCount: 32,
  memoryBytes: 1_073_741_824,
};

function makeProposal(
  checkKind: CheckKind,
  workingDirectory: string,
  revision: string,
  sandboxMode: SandboxMode,
  declaredScripts?: z.input<typeof scriptSchema>
): CommandProposal {
  const shape = commandShapes[checkKind];
  return commandProposalSchema.parse({
    executable: shape.executable,
    args: [...shape.args],
    declaredScripts: declaredScripts ?? { test: '' },
    checkKind,
    workingDirectory,
    revision,
    environmentAllowlist: [],
    limits: defaultLimits,
    sandboxMode,
  });
}

/** Only identifies a named script; its arbitrary project-controlled contents are never executed here. */
export function discoverPackageChecks(
  manifest: string,
  workingDirectory: string,
  revision: string,
  sandboxMode: SandboxMode = 'unavailable'
): CommandProposal[] {
  if (Buffer.byteLength(manifest, 'utf8') > 1_000_000)
    throw new Error('Manifest exceeds discovery limit');
  let parsed: z.infer<typeof packageSchema>;
  try {
    parsed = packageSchema.parse(JSON.parse(manifest));
  } catch {
    throw new Error('Invalid package manifest');
  }
  if (!parsed.scripts?.test) return [];
  const candidate = makeProposal('npm-script', workingDirectory, revision, sandboxMode, {
    test: parsed.scripts.test,
    ...(parsed.scripts.pretest !== undefined ? { pretest: parsed.scripts.pretest } : {}),
    ...(parsed.scripts.posttest !== undefined ? { posttest: parsed.scripts.posttest } : {}),
  });
  return [candidate];
}

export interface DiscoveryManifest {
  path: string;
  content: string;
}

const allowedManifestNames = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'Cargo.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
]);

/** Returns whether an audited path is one of the finite check-discovery inputs. */
export function isSupportedCheckManifest(path: string): boolean {
  try {
    return allowedManifestNames.has(posix.basename(checkedManifestPath(path)));
  } catch {
    return false;
  }
}

function checkedManifestPath(value: string): string {
  if (
    value.length < 1 ||
    value.length > 4096 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error('Invalid manifest path');
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error('Invalid manifest path');
  return normalized;
}

function parsePackageManager(content: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const parsed = JSON.parse(content) as { packageManager?: unknown };
  if (typeof parsed.packageManager === 'string') {
    const declared = /^(npm|pnpm|yarn|bun)@/.exec(parsed.packageManager)?.[1];
    if (declared) return declared as 'npm' | 'pnpm' | 'yarn' | 'bun';
  }
  return 'npm';
}

function hasPytest(content: string, path: string): boolean {
  if (path.endsWith('requirements.txt'))
    return content.split(/\r?\n/).some((line) => /^\s*pytest(?:\s|[<>=!~;\x5b]|$)/i.test(line));
  try {
    const parsed = parseToml(content) as {
      project?: { dependencies?: unknown; 'optional-dependencies'?: unknown };
      dependencyGroups?: unknown;
      tool?: { pytest?: unknown };
    };
    if (parsed.tool?.pytest && typeof parsed.tool.pytest === 'object') return true;
    const parts: unknown[] = [
      parsed.project?.dependencies,
      parsed.project?.['optional-dependencies'],
      parsed.dependencyGroups,
    ];
    const serialized = JSON.stringify(parts);
    return /(?:^|[^a-z0-9_-])pytest(?:[^a-z0-9_-]|$)/i.test(serialized);
  } catch {
    return false;
  }
}

/**
 * Discovers a finite set of fixed test recipes from eligible local manifests.
 * This never executes manifest strings; only the npm-family recipes run project scripts.
 */
export function discoverStandardChecks(
  inputs: readonly DiscoveryManifest[],
  revision: string,
  sandboxMode: SandboxMode = 'unavailable'
): CommandProposal[] {
  if (inputs.length > 128) throw new Error('Too many manifests for check discovery');
  let totalBytes = 0;
  const manifests = new Map<string, string>();
  for (const input of inputs) {
    const path = checkedManifestPath(input.path);
    const name = posix.basename(path);
    if (!allowedManifestNames.has(name)) continue;
    const size = Buffer.byteLength(input.content, 'utf8');
    if (size > 1_000_000) throw new Error('Manifest exceeds discovery limit');
    totalBytes += size;
    if (totalBytes > 8_000_000) throw new Error('Manifest set exceeds discovery limit');
    if (input.content.includes('\0')) throw new Error('Manifest contains binary data');
    if (manifests.has(path)) throw new Error('Duplicate manifest path');
    manifests.set(path, input.content);
  }

  const proposals: CommandProposal[] = [];
  const sortedPaths = [...manifests.keys()].sort((left, right) => left.localeCompare(right));
  const hasSibling = (directory: string, name: string) =>
    manifests.has(directory === '.' ? name : `${directory}/${name}`);
  for (const path of sortedPaths) {
    const content = manifests.get(path)!;
    const directory = posix.dirname(path);
    const name = posix.basename(path);
    if (name === 'package.json') {
      try {
        const checks = discoverPackageChecks(content, directory, revision, sandboxMode);
        if (checks.length) {
          const manager = parsePackageManager(content);
          const lockManager = hasSibling(directory, 'pnpm-lock.yaml')
            ? 'pnpm'
            : hasSibling(directory, 'yarn.lock')
              ? 'yarn'
              : hasSibling(directory, 'bun.lock') || hasSibling(directory, 'bun.lockb')
                ? 'bun'
                : 'npm';
          const selected = manager === 'npm' && lockManager !== 'npm' ? lockManager : manager;
          const kind = `${selected}-script` as CheckKind;
          const candidate = checks[0]!;
          proposals.push(
            selected === 'npm'
              ? candidate
              : makeProposal(kind, directory, revision, sandboxMode, candidate.declaredScripts)
          );
        }
      } catch {
        // Invalid package.json is surfaced by project/audit parse errors, not a guess here.
      }
      continue;
    }
    if (name === 'pyproject.toml' || name === 'requirements.txt') {
      if (name === 'pyproject.toml') {
        proposals.push(makeProposal('python-unittest', directory, revision, sandboxMode));
        if (hasPytest(content, path))
          proposals.push(makeProposal('python-pytest', directory, revision, sandboxMode));
      } else if (hasPytest(content, path)) {
        proposals.push(makeProposal('python-pytest', directory, revision, sandboxMode));
      }
      continue;
    }
    if (name === 'go.mod')
      proposals.push(makeProposal('go-test', directory, revision, sandboxMode));
    if (name === 'Cargo.toml' && hasSibling(directory, 'Cargo.lock'))
      proposals.push(makeProposal('cargo-test', directory, revision, sandboxMode));
    if (name === 'pom.xml' && /<project(?:\s|>)/i.test(content))
      proposals.push(makeProposal('maven-test', directory, revision, sandboxMode));
    if (
      (name === 'build.gradle' || name === 'build.gradle.kts') &&
      /\bplugins\b|\btest\b/.test(content)
    )
      proposals.push(makeProposal('gradle-test', directory, revision, sandboxMode));
  }
  const unique = new Map<string, CommandProposal>();
  for (const proposal of proposals) {
    const key = `${proposal.workingDirectory}\0${proposal.checkKind}`;
    if (!unique.has(key)) unique.set(key, proposal);
  }
  return [...unique.values()].sort((left, right) =>
    left.workingDirectory === right.workingDirectory
      ? (left.checkKind ?? 'npm-script').localeCompare(right.checkKind ?? 'npm-script')
      : left.workingDirectory.localeCompare(right.workingDirectory)
  );
}

/** Project scripts are untrusted and an ordinary process has no isolation. */
export function classifyProposal(proposal: CommandProposal): 'explicit-approval-required' {
  commandProposalSchema.parse(proposal);
  return 'explicit-approval-required';
}

const recordedRunOutcomeSchema = z
  .object({
    state: z.enum(['exited', 'denied', 'interrupted', 'timed_out', 'cancelled', 'crashed']),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(128).nullable(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    isolation: z.enum(sandboxModes),
    approved: z.boolean(),
    capturedComplete: z.boolean(),
    executionMatchesProposal: z.boolean().optional(),
    terminationUnconfirmed: z.boolean().optional(),
  })
  .strict();
export type RecordedRunOutcome = z.infer<typeof recordedRunOutcomeSchema>;

/** Apply only to trusted, persisted evidence; absent match or termination proof fails closed. */
export function canVerifyRun(outcome: RecordedRunOutcome): boolean {
  const validation = recordedRunOutcomeSchema.safeParse(outcome);
  if (!validation.success) return false;
  outcome = validation.data;
  return (
    outcome.state === 'exited' &&
    outcome.isolation !== 'unavailable' &&
    outcome.isolation !== 'macos-sandbox-exec' &&
    outcome.exitCode === 0 &&
    outcome.signal === null &&
    outcome.approved &&
    outcome.capturedComplete &&
    outcome.executionMatchesProposal === true &&
    outcome.terminationUnconfirmed === false &&
    !outcome.stdoutTruncated &&
    !outcome.stderrTruncated
  );
}
