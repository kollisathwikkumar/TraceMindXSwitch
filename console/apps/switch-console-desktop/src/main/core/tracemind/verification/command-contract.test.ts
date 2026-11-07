import { describe, expect, it } from 'vitest';
import {
  discoverPackageChecks,
  discoverStandardChecks,
  classifyProposal,
  canVerifyRun,
} from './command-contract';

describe('verification command contracts', () => {
  it('discovers package test candidates as structured proposals without executing script text', () => {
    const checks = discoverPackageChecks(
      '{"scripts":{"test":"echo unsafe && rm -rf important","lint":"eslint ."}}',
      'packages/app',
      'revision-1'
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      executable: 'npm',
      args: ['run', 'test'],
      workingDirectory: 'packages/app',
      revision: 'revision-1',
      environmentAllowlist: [],
      sandboxMode: 'unavailable',
      limits: {
        timeoutMs: 60_000,
        outputBytes: 1_000_000,
        processCount: 32,
        memoryBytes: 1_073_741_824,
      },
    });
    expect(classifyProposal(checks[0]!)).toBe('explicit-approval-required');
  });
  it('never verifies denied, incomplete, truncated, crashed, timed-out or cancelled runs', () => {
    const passed = {
      state: 'exited' as const,
      exitCode: 0,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      isolation: 'linux-bubblewrap' as const,
      approved: true,
      capturedComplete: true,
      executionMatchesProposal: true,
      terminationUnconfirmed: false,
    };
    expect(canVerifyRun(passed)).toBe(true);
    expect(canVerifyRun({ ...passed, isolation: 'unavailable' })).toBe(false);
    expect(canVerifyRun({ ...passed, isolation: 'macos-sandbox-exec' })).toBe(false);
    // Persisted flags cannot override the host's inability to prove descendant
    // termination or enforce all requested resource controls on macOS.
    expect(
      canVerifyRun({
        ...passed,
        isolation: 'macos-sandbox-exec',
        terminationUnconfirmed: false,
      })
    ).toBe(false);
    for (const state of ['denied', 'interrupted', 'timed_out', 'cancelled', 'crashed'] as const) {
      expect(canVerifyRun({ ...passed, state })).toBe(false);
    }
    expect(canVerifyRun({ ...passed, exitCode: 1 })).toBe(false);
    expect(canVerifyRun({ ...passed, stdoutTruncated: true })).toBe(false);
    expect(canVerifyRun({ ...passed, capturedComplete: false })).toBe(false);
    expect(canVerifyRun({ ...passed, approved: false })).toBe(false);
  });
  it('requires explicit proof of command match and process-tree termination', () => {
    const incompleteRecord = {
      state: 'exited' as const,
      exitCode: 0,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      isolation: 'linux-bubblewrap' as const,
      approved: true,
      capturedComplete: true,
    };
    // Legacy records without both fields are not proof.
    expect(canVerifyRun(incompleteRecord)).toBe(false);
    const proven = {
      ...incompleteRecord,
      executionMatchesProposal: true,
      terminationUnconfirmed: false,
    };
    expect(canVerifyRun(proven)).toBe(true);
    expect(canVerifyRun({ ...proven, executionMatchesProposal: false })).toBe(false);
    expect(canVerifyRun({ ...proven, terminationUnconfirmed: true })).toBe(false);
  });
  it('rejects traversal, malformed or oversized manifests and non-test scripts', () => {
    expect(() =>
      discoverPackageChecks('{"scripts":{"test":"echo ok"}}', '../escape', 'rev')
    ).toThrow();
    expect(() => discoverPackageChecks('not json', '.', 'rev')).toThrow();
    expect(() => discoverPackageChecks('x'.repeat(1_000_001), '.', 'rev')).toThrow('limit');
    expect(discoverPackageChecks('{"scripts":{"build":"echo ok"}}', '.', 'rev')).toEqual([]);
  });
  it('rejects forged or structurally invalid outcome records', () => {
    const forged = JSON.parse(
      '{"state":"exited","exitCode":0,"signal":null,"stdoutTruncated":false,"stderrTruncated":false,"isolation":"unavailable","approved":"yes","capturedComplete":true}'
    );
    expect(canVerifyRun(forged)).toBe(false);
  });
  it('captures lifecycle hooks in the proposal instead of hiding executed scripts', () => {
    const [proposal] = discoverPackageChecks(
      '{"scripts":{"pretest":"echo before","test":"echo run","posttest":"echo after"}}',
      '.',
      'rev'
    );
    expect(proposal?.declaredScripts).toEqual({
      pretest: 'echo before',
      test: 'echo run',
      posttest: 'echo after',
    });
  });

  it('selects a single lockfile-consistent package manager without executing its script text', () => {
    const checks = discoverStandardChecks(
      [
        {
          path: 'apps/web/package.json',
          content:
            '{"packageManager":"pnpm@10.2.0","scripts":{"pretest":"echo before","test":"node malicious.js","posttest":"echo after"}}',
        },
        { path: 'apps/web/pnpm-lock.yaml', content: 'lockfileVersion: 9.0' },
        { path: 'apps/web/package-lock.json', content: '{"lockfileVersion":3}' },
      ],
      'audit:revision-1'
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      executable: 'pnpm',
      args: ['run', 'test'],
      checkKind: 'pnpm-script',
      workingDirectory: 'apps/web',
      declaredScripts: {
        pretest: 'echo before',
        test: 'node malicious.js',
        posttest: 'echo after',
      },
    });
  });

  it('discovers only fixed Python, Go, Rust, Maven, and Gradle test recipes', () => {
    const checks = discoverStandardChecks(
      [
        {
          path: 'py/pyproject.toml',
          content:
            '[project]\nname = "example"\n[project.optional-dependencies]\ntest = ["pytest>=8"]\n',
        },
        { path: 'go/go.mod', content: 'module example.test/project\ngo 1.24\n' },
        { path: 'rust/Cargo.toml', content: '[package]\nname = "example"\n' },
        { path: 'rust/Cargo.lock', content: 'version = 4\n' },
        { path: 'java/pom.xml', content: '<project><artifactId>example</artifactId></project>' },
        { path: 'gradle/build.gradle.kts', content: 'plugins { id("java") }' },
      ],
      'audit:revision-2'
    );
    expect(
      checks.map((item) => [item.workingDirectory, item.checkKind, item.executable, item.args])
    ).toEqual([
      ['go', 'go-test', 'go', ['test', './...']],
      ['gradle', 'gradle-test', 'gradle', ['--offline', 'test']],
      ['java', 'maven-test', 'mvn', ['--offline', '--batch-mode', 'test']],
      ['py', 'python-pytest', 'python3', ['-m', 'pytest']],
      ['py', 'python-unittest', 'python3', ['-m', 'unittest', 'discover']],
      ['rust', 'cargo-test', 'cargo', ['test', '--locked', '--offline']],
    ]);
    expect(checks.every((item) => item.declaredScripts.test === '')).toBe(true);
  });

  it('discovers unittest from a Python project and rejects malformed, oversized, duplicated, or unsafe manifest sets', () => {
    expect(
      discoverStandardChecks(
        [{ path: 'py/pyproject.toml', content: '[project]\nname="no-pytest"\n' }],
        'audit:revision-3'
      ).map((item) => item.checkKind)
    ).toEqual(['python-unittest']);
    expect(() =>
      discoverStandardChecks([{ path: '../escape/go.mod', content: 'module x' }], 'rev')
    ).toThrow('path');
    expect(() =>
      discoverStandardChecks(
        [
          { path: 'package.json', content: '{"scripts":{"test":"x"}}' },
          { path: 'package.json', content: '{"scripts":{"test":"y"}}' },
        ],
        'rev'
      )
    ).toThrow('Duplicate');
    expect(() =>
      discoverStandardChecks([{ path: 'go.mod', content: 'x'.repeat(1_000_001) }], 'rev')
    ).toThrow('limit');
    expect(() =>
      discoverStandardChecks([{ path: 'py/pyproject.toml', content: '\0' }], 'rev')
    ).toThrow('binary');
  });

  it('rejects recipe overrides that try to turn fixed discovery into arbitrary commands', () => {
    const candidate = discoverStandardChecks(
      [{ path: 'go.mod', content: 'module example.test/project\ngo 1.24\n' }],
      'audit:revision-4'
    )[0]!;
    expect(() =>
      classifyProposal({ ...candidate, args: ['test', './...', ';', 'curl evil'] })
    ).toThrow('Command does not match recipe');
    expect(() =>
      classifyProposal({ ...candidate, executable: 'sh' as never, args: ['-c', 'echo unsafe'] })
    ).toThrow();
  });
});
