import { describe, expect, it } from 'vitest';
import {
  collectDependencyInventory,
  MAX_DEPENDENCY_LOCKFILE_BYTES,
  projectDependencyInventorySchema,
} from './dependency-inventory';

describe('offline dependency inventory', () => {
  it('resolves direct and transitive npm package-lock v3 edges, including scopes', () => {
    const result = collectDependencyInventory(
      ['package.json', 'package-lock.json'],
      new Map([
        [
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              '': {
                dependencies: { '@scope/root': '^2.0.0', helper: '^1.0.0' },
                devDependencies: { testkit: '^3' },
                peerDependencies: { peerhost: '^4' },
              },
              'node_modules/@scope/root': { version: '2.4.1', dependencies: { helper: '^1' } },
              'node_modules/helper': { version: '1.5.0', dependencies: { leaf: '^0.9' } },
              'node_modules/leaf': { version: '0.9.2' },
              'node_modules/testkit': { version: '3.1.0' },
              'node_modules/peerhost': { version: '4.0.0' },
            },
          }),
        ],
        [
          'package.json',
          JSON.stringify({
            dependencies: { '@scope/root': '^2.0.0', helper: '^1.0.0' },
            devDependencies: { testkit: '^3' },
            peerDependencies: { peerhost: '^4' },
          }),
        ],
      ])
    );
    expect(result.status).toBe('complete');
    expect(result.ecosystems).toEqual(['npm']);
    expect(result.packages).toHaveLength(5);
    expect(
      result.packages
        .filter((item) => item.direct)
        .map((item) => item.name)
        .sort()
    ).toEqual(['@scope/root', 'helper', 'peerhost', 'testkit']);
    const byId = new Map(result.packages.map((item) => [item.id, item.name]));
    const links = result.edges.map((edge) => [
      edge.from ? byId.get(edge.from) : 'root',
      byId.get(edge.to),
    ]);
    expect(links).toContainEqual(['root', '@scope/root']);
    expect(links).toContainEqual(['root', 'helper']);
    expect(links).toContainEqual(['root', 'peerhost']);
    expect(links).toContainEqual(['helper', 'leaf']);
  });

  it('marks an npm lockfile partial when its direct roots disagree with package.json', () => {
    const result = collectDependencyInventory(
      ['package.json', 'package-lock.json'],
      new Map([
        ['package.json', JSON.stringify({ dependencies: { alpha: '^1.0.0' } })],
        [
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              '': { dependencies: { beta: '^1.0.0' } },
              'node_modules/alpha': { version: '1.1.0' },
              'node_modules/beta': { version: '1.2.0' },
            },
          }),
        ],
      ])
    );

    expect(result.status).toBe('partial');
    expect(result.limitations).toContain(
      'package.json direct dependency declarations differ from npm lockfile root declarations.'
    );
    expect(result.packages.filter((item) => item.direct).map((item) => item.name)).toEqual([
      'beta',
    ]);
  });

  it('marks an npm lock partial when a same-name direct specifier drifts', () => {
    const result = collectDependencyInventory(
      ['package.json', 'package-lock.json'],
      new Map([
        ['package.json', JSON.stringify({ dependencies: { alpha: '^2.0.0' } })],
        [
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              '': { dependencies: { alpha: '^1.0.0' } },
              'node_modules/alpha': { version: '1.2.0' },
            },
          }),
        ],
      ])
    );

    expect(result.status).toBe('partial');
    expect(result.limitations).toContain(
      'package.json direct dependency declarations differ from npm lockfile root declarations.'
    );
  });

  it('does not claim an npm lockfile has been cross-checked when package.json bytes were not captured', () => {
    const result = collectDependencyInventory(
      ['package.json', 'package-lock.json'],
      new Map([['package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } })]])
    );

    expect(result.status).toBe('partial');
    expect(result.limitations).toContain(
      'package.json content was not captured, so direct declarations could not be checked against the npm lockfile.'
    );
  });

  it('resolves nested npm package locations to the nearest installed dependency', () => {
    const result = collectDependencyInventory(
      ['package-lock.json'],
      new Map([
        [
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              '': { dependencies: { parent: '1.0.0', helper: '9.0.0' } },
              'node_modules/parent': { version: '1.0.0', dependencies: { helper: '1.0.0' } },
              'node_modules/parent/node_modules/helper': { version: '1.0.0' },
              'node_modules/helper': { version: '9.0.0' },
            },
          }),
        ],
      ])
    );
    const parent = result.packages.find((item) => item.name === 'parent')!;
    const nearest = result.packages.find(
      (item) => item.name === 'helper' && item.version === '1.0.0'
    )!;
    expect(result.edges).toContainEqual({
      from: parent.id,
      to: nearest.id,
      sourcePath: 'package-lock.json',
    });
    expect(result.status).toBe('complete');
  });

  it('does not silently omit an unresolved npm peer dependency', () => {
    const result = collectDependencyInventory(
      ['package-lock.json'],
      new Map([
        [
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: { '': { peerDependencies: { host: '^1.0.0' } } },
          }),
        ],
      ])
    );
    expect(result.status).toBe('partial');
    expect(result.limitations).toContain(
      'An npm root peer dependency is not resolved in the lockfile: host.'
    );
  });

  it('does not let an optional npm peer hide a missing required root dependency', () => {
    const result = collectDependencyInventory(
      ['package-lock.json'],
      new Map([
        [
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              '': {
                dependencies: { host: '^1.0.0' },
                peerDependencies: { host: '^1.0.0' },
                peerDependenciesMeta: { host: { optional: true } },
              },
            },
          }),
        ],
      ])
    );
    expect(result.status).toBe('partial');
    expect(result.limitations).toContain(
      'An npm root dependency is not resolved in the lockfile: host.'
    );
  });

  it('resolves pnpm v9 importer and transitive snapshot edges without persisting resolution URLs', () => {
    const result = collectDependencyInventory(
      ['pnpm-lock.yaml'],
      new Map([
        [
          'pnpm-lock.yaml',
          `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      alpha:
        specifier: ^1.0.0
        version: 1.2.0
packages:
  alpha@1.2.0:
    resolution:
      integrity: sha512-private-value
  beta@2.0.0:
    resolution:
      tarball: https://user:password@example.invalid/private
snapshots:
  alpha@1.2.0:
    dependencies:
      beta: 2.0.0
  beta@2.0.0: {}
`,
        ],
      ])
    );
    expect(result.status).toBe('complete');
    expect(result.packages.map((item) => item.name).sort()).toEqual(['alpha', 'beta']);
    expect(result.edges).toHaveLength(2);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-value');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('example.invalid');
  });

  it('marks pnpm closure partial when the captured package manifest disagrees with its root importer', () => {
    const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      alpha:
        specifier: ^1.0.0
        version: 1.2.0
packages:
  alpha@1.2.0:
    resolution: {integrity: sha512-a}
snapshots:
  alpha@1.2.0: {}
`;
    const mismatch = collectDependencyInventory(
      ['package.json', 'pnpm-lock.yaml'],
      new Map([
        ['package.json', JSON.stringify({ dependencies: { alpha: '^1', beta: '^2' } })],
        ['pnpm-lock.yaml', lockfile],
      ])
    );
    const uncapturedManifest = collectDependencyInventory(
      ['package.json', 'pnpm-lock.yaml'],
      new Map([['pnpm-lock.yaml', lockfile]])
    );
    const specifierMismatch = collectDependencyInventory(
      ['package.json', 'pnpm-lock.yaml'],
      new Map([
        ['package.json', JSON.stringify({ dependencies: { alpha: '^2.0.0' } })],
        ['pnpm-lock.yaml', lockfile],
      ])
    );

    expect(mismatch.status).toBe('partial');
    expect(mismatch.limitations).toContain(
      'package.json direct dependency declarations differ from pnpm importer ".".'
    );
    expect(uncapturedManifest.status).toBe('partial');
    expect(uncapturedManifest.limitations).toContain(
      'package.json content was not captured, so direct declarations could not be checked against pnpm importer ".".'
    );
    expect(specifierMismatch.status).toBe('partial');
    expect(specifierMismatch.limitations).toContain(
      'package.json direct dependency declarations differ from pnpm importer ".".'
    );
  });

  it('matches nested pnpm workspace manifests to importer paths without inventing npm packages', () => {
    const result = collectDependencyInventory(
      ['package.json', 'apps/web/package.json', 'pnpm-lock.yaml'],
      new Map([
        ['package.json', JSON.stringify({ dependencies: { alpha: '^1.0.0' } })],
        ['apps/web/package.json', JSON.stringify({ dependencies: { beta: '^2.0.0' } })],
        [
          'pnpm-lock.yaml',
          `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      alpha:
        specifier: ^1.0.0
        version: 1.2.0
  apps/web:
    dependencies:
      beta:
        specifier: ^2.0.0
        version: 2.0.0
packages:
  alpha@1.2.0:
    resolution: {integrity: sha512-a}
  beta@2.0.0:
    resolution: {integrity: sha512-b}
snapshots:
  alpha@1.2.0: {}
  beta@2.0.0: {}
`,
        ],
      ])
    );

    expect(result.status).toBe('complete');
    expect(result.ecosystems).toEqual(['pnpm']);
    expect(
      result.packages.map(({ name, ecosystem, direct }) => ({ name, ecosystem, direct }))
    ).toEqual(
      expect.arrayContaining([
        { name: 'alpha', ecosystem: 'pnpm', direct: true },
        { name: 'beta', ecosystem: 'pnpm', direct: true },
      ])
    );
    expect(result.packages.some((item) => item.ecosystem === 'npm')).toBe(false);
  });

  it('keeps a nested standalone pnpm project separate from the enclosing workspace importers', () => {
    const result = collectDependencyInventory(
      [
        'package.json',
        'pnpm-lock.yaml',
        'apps/standalone/package.json',
        'apps/standalone/pnpm-lock.yaml',
      ],
      new Map([
        ['package.json', JSON.stringify({ dependencies: { alpha: '^1.0.0' } })],
        ['apps/standalone/package.json', JSON.stringify({ dependencies: { beta: '^2.0.0' } })],
        [
          'pnpm-lock.yaml',
          `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      alpha:
        specifier: ^1.0.0
        version: 1.2.0
packages:
  alpha@1.2.0:
    resolution: {integrity: sha512-a}
snapshots:
  alpha@1.2.0: {}
`,
        ],
        [
          'apps/standalone/pnpm-lock.yaml',
          `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      beta:
        specifier: ^2.0.0
        version: 2.0.0
packages:
  beta@2.0.0:
    resolution: {integrity: sha512-b}
snapshots:
  beta@2.0.0: {}
`,
        ],
      ])
    );

    expect(result.status).toBe('complete');
    expect(result.ecosystems).toEqual(['pnpm']);
    expect(result.packages.map((item) => [item.name, item.sourcePath])).toEqual(
      expect.arrayContaining([
        ['alpha', 'pnpm-lock.yaml'],
        ['beta', 'apps/standalone/pnpm-lock.yaml'],
      ])
    );
  });

  it('resolves legacy pnpm v6 root dependencies from the top-level importer tables', () => {
    const result = collectDependencyInventory(
      ['pnpm-lock.yaml'],
      new Map([
        [
          'pnpm-lock.yaml',
          [
            "lockfileVersion: '6.0'",
            'dependencies:',
            '  alpha:',
            '    specifier: ^1.0.0',
            '    version: 1.2.0',
            'packages:',
            '  /alpha@1.2.0:',
            '    resolution: {integrity: sha512-a}',
            '    dependencies:',
            '      beta: 2.0.0',
            '  /beta@2.0.0:',
            '    resolution: {integrity: sha512-b}',
            '',
          ].join('\n'),
        ],
      ])
    );
    expect(result.status).toBe('complete');
    expect(result.packages.filter((item) => item.direct).map((item) => item.name)).toEqual([
      'alpha',
    ]);
    expect(result.edges).toHaveLength(2);
  });

  it('marks peer-specific pnpm records partial instead of guessing their package identity', () => {
    const result = collectDependencyInventory(
      ['pnpm-lock.yaml'],
      new Map([
        [
          'pnpm-lock.yaml',
          `lockfileVersion: '9.0'
packages:
  alpha@1.0.0:
    resolution: {integrity: sha512-a}
  alpha@1.0.0(peer@2.0.0):
    resolution: {integrity: sha512-b}
snapshots:
  alpha@1.0.0(peer@2.0.0): {}
`,
        ],
      ])
    );
    expect(result.status).toBe('partial');
    expect(result.packages.filter((item) => item.name === 'alpha')).toHaveLength(2);
    expect(result.edges).toEqual([]);
    expect(result.limitations.some((item) => item.includes('cannot be uniquely linked'))).toBe(
      true
    );
  });

  it('does not extract a guessed version from a URL-shaped pnpm dependency reference', () => {
    const result = collectDependencyInventory(
      ['pnpm-lock.yaml'],
      new Map([
        [
          'pnpm-lock.yaml',
          [
            "lockfileVersion: '9.0'",
            'packages:',
            '  alpha@1.0.0: {}',
            '  beta@1.0.0: {}',
            'snapshots:',
            '  alpha@1.0.0:',
            '    dependencies:',
            "      beta: 'https://example.invalid/packages/beta/1.0.0'",
            '  beta@1.0.0: {}',
            '',
          ].join('\n'),
        ],
      ])
    );
    expect(result.status).toBe('partial');
    expect(result.edges).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('example.invalid');
  });

  it('resolves Cargo.lock transitives and root direct names from Cargo.toml', () => {
    const result = collectDependencyInventory(
      ['Cargo.toml', 'Cargo.lock'],
      new Map([
        [
          'Cargo.toml',
          `[package]\nname = "demo"\nversion = "0.1.0"\n[dependencies]\nalpha = "^1"\n`,
        ],
        [
          'Cargo.lock',
          `version = 3\n\n[[package]]\nname = "demo"\nversion = "0.1.0"\ndependencies = ["alpha 1.2.0"]\n\n[[package]]\nname = "alpha"\nversion = "1.2.0"\ndependencies = ["beta 2.3.0 (registry+https://example.invalid/private)"]\n\n[[package]]\nname = "beta"\nversion = "2.3.0"\n`,
        ],
      ])
    );
    expect(result.status).toBe('complete');
    expect(result.packages.some((item) => item.name === 'demo')).toBe(false);
    expect(result.packages.filter((item) => item.direct).map((item) => item.name)).toEqual([
      'alpha',
    ]);
    expect(result.edges).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('example.invalid');
  });

  it('resolves Cargo dependency aliases to the actual locked package name', () => {
    const result = collectDependencyInventory(
      ['Cargo.toml', 'Cargo.lock'],
      new Map([
        [
          'Cargo.toml',
          `[package]\nname = "demo"\nversion = "0.1.0"\n[dependencies]\nalias = { package = "actual", version = "^1" }\n`,
        ],
        ['Cargo.lock', `version = 3\n\n[[package]]\nname = "actual"\nversion = "1.2.0"\n`],
      ])
    );
    expect(result.status).toBe('complete');
    expect(result.packages).toMatchObject([{ name: 'actual', direct: true }]);
  });

  it('keeps Cargo workspace coverage partial when member manifests are not joined', () => {
    const result = collectDependencyInventory(
      ['Cargo.toml', 'Cargo.lock'],
      new Map([
        ['Cargo.toml', `[workspace]\nmembers = ["crates/*"]\n`],
        ['Cargo.lock', `version = 3\n\n[[package]]\nname = "member"\nversion = "1.0.0"\n`],
      ])
    );
    expect(result.status).toBe('partial');
    expect(result.limitations).toContain(
      'Cargo workspace member manifests are not joined; direct member dependency linkage may be incomplete.'
    );
  });

  it('resolves Poetry lock transitive edges using PEP 621 project dependencies', () => {
    const result = collectDependencyInventory(
      ['pyproject.toml', 'poetry.lock'],
      new Map([
        ['pyproject.toml', `[project]\nname = "demo"\ndependencies = ["Alpha_Pkg>=1"]\n`],
        [
          'poetry.lock',
          `[metadata]\nlock-version = "2.1"\n\n[[package]]\nname = "alpha-pkg"\nversion = "1.2.0"\n[package.dependencies]\nbeta = "^2"\n\n[[package]]\nname = "beta"\nversion = "2.0.1"\n`,
        ],
      ])
    );
    expect(result.status).toBe('complete');
    expect(result.ecosystems).toEqual(['poetry']);
    expect(result.packages.filter((item) => item.direct).map((item) => item.name)).toEqual([
      'alpha-pkg',
    ]);
    expect(result.edges).toHaveLength(2);
  });

  it('labels PEP 621 direct-only metadata as Python rather than guessing Poetry', () => {
    const result = collectDependencyInventory(
      ['pyproject.toml'],
      new Map([['pyproject.toml', '[project]\nname = "demo"\ndependencies = ["Alpha_Pkg>=1"]\n']])
    );

    expect(result.status).toBe('partial');
    expect(result.ecosystems).toEqual(['python']);
    expect(result.packages).toMatchObject([
      { ecosystem: 'python', name: 'alpha-pkg', version: null, direct: true },
    ]);
  });

  it('recognizes Poetry optional and development dependencies without treating Python itself as a package', () => {
    const result = collectDependencyInventory(
      ['pyproject.toml', 'poetry.lock'],
      new Map([
        [
          'pyproject.toml',
          `[tool.poetry.dependencies]\npython = ">=3.11"\nmain-pkg = "^1"\n[tool.poetry.dev-dependencies]\ndev-pkg = "^2"\n[project.optional-dependencies]\ntest = ["test-pkg>=3"]\n`,
        ],
        [
          'poetry.lock',
          `[metadata]\nlock-version = "2.1"\n\n[[package]]\nname = "main-pkg"\nversion = "1.2.0"\n\n[[package]]\nname = "dev-pkg"\nversion = "2.1.0"\n\n[[package]]\nname = "test-pkg"\nversion = "3.0.0"\n`,
        ],
      ])
    );
    expect(result.status).toBe('complete');
    expect(
      result.packages
        .filter((item) => item.direct)
        .map((item) => item.name)
        .sort()
    ).toEqual(['dev-pkg', 'main-pkg', 'test-pkg']);
    expect(result.packages.some((item) => item.name === 'python')).toBe(false);
  });

  it('marks missing, malformed, unsupported, and oversized lockfiles partial or unavailable', () => {
    expect(collectDependencyInventory(['package-lock.json'], new Map()).status).toBe('partial');
    expect(
      collectDependencyInventory(['package-lock.json'], new Map([['package-lock.json', '{']]))
        .status
    ).toBe('partial');
    expect(
      collectDependencyInventory(
        ['package-lock.json'],
        new Map([
          [
            'package-lock.json',
            JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: 'invalid' } } }),
          ],
        ])
      ).status
    ).toBe('partial');
    expect(
      collectDependencyInventory(['yarn.lock'], new Map([['yarn.lock', '# lock']])).status
    ).toBe('partial');
    expect(
      collectDependencyInventory(
        ['Cargo.toml', 'Cargo.lock'],
        new Map([
          ['Cargo.toml', `[package]\nname = "demo"\nversion = "0.1.0"\n`],
          ['Cargo.lock', `version = 5\n\n[[package]]\nname = "alpha"\nversion = "1.0.0"\n`],
        ])
      ).status
    ).toBe('partial');
    expect(collectDependencyInventory(['settings.gradle.kts'], new Map()).unsupportedFiles).toEqual(
      ['settings.gradle.kts']
    );
    const crossEcosystem = collectDependencyInventory(['bun.lock', 'src/App.slnx'], new Map());
    expect(crossEcosystem.status).toBe('partial');
    expect(crossEcosystem.unsupportedFiles).toEqual(['bun.lock', 'src/App.slnx']);
    expect(collectDependencyInventory([], new Map()).status).toBe('unavailable');
    const manifestOnly = collectDependencyInventory(
      ['package.json'],
      new Map([
        [
          'package.json',
          JSON.stringify({ dependencies: { react: '^19.0.0' }, devDependencies: { vitest: '^5' } }),
        ],
      ])
    );
    expect(manifestOnly.status).toBe('partial');
    expect(manifestOnly.packages.map((item) => item.name).sort()).toEqual(['react', 'vitest']);
    expect(manifestOnly.packages.every((item) => item.version === null && item.direct)).toBe(true);
    expect(manifestOnly.edges.every((edge) => edge.from === null)).toBe(true);
    const oversized = 'x'.repeat(MAX_DEPENDENCY_LOCKFILE_BYTES + 1);
    expect(
      collectDependencyInventory(['package-lock.json'], new Map([['package-lock.json', oversized]]))
        .status
    ).toBe('partial');
  });

  it('keeps mixed supported and unsupported ecosystems visibly partial', () => {
    const supportedNpmLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { allowed: '^1.0.0' } },
        'node_modules/allowed': { version: '1.2.3' },
      },
    });
    const unsupported = [
      'yarn.lock',
      'Pipfile.lock',
      'uv.lock',
      'requirements.txt',
      'go.mod',
      'pom.xml',
      'settings.gradle.kts',
      'composer.lock',
      'Gemfile.lock',
      'bun.lock',
      'deno.lock',
      'Package.resolved',
      'packages.lock.json',
      'pubspec.lock',
      'Podfile.lock',
      'renv.lock',
      'mix.lock',
      'deps.edn',
      'cpanfile.snapshot',
      'src/App.csproj',
    ];
    for (const path of unsupported) {
      const inventory = collectDependencyInventory(
        ['package-lock.json', path],
        new Map([['package-lock.json', supportedNpmLock]])
      );
      expect(inventory.status, path).toBe('partial');
      expect(inventory.unsupportedFiles, path).toContain(path);
    }
  });

  it('downgrades supported lockfile closure when the enclosing project scan is incomplete', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { alpha: '^1.0.0' } },
        'node_modules/alpha': { version: '1.2.3' },
      },
    });
    const complete = collectDependencyInventory(
      ['package-lock.json'],
      new Map([['package-lock.json', lockfile]])
    );
    const incomplete = collectDependencyInventory(
      ['package-lock.json'],
      new Map([['package-lock.json', lockfile]]),
      { scanComplete: false }
    );

    expect(complete.status).toBe('complete');
    expect(incomplete.status).toBe('partial');
    expect(incomplete.limitations).toContain(
      'The project file scan was incomplete; unseen dependency manifests or lockfiles may affect closure coverage.'
    );
  });

  it('reports when bounded lockfile and unsupported path lists omit entries', () => {
    const lockfiles = Array.from(
      { length: 1001 },
      (_, index) => `packages/${index}/package-lock.json`
    );
    const unsupported = Array.from(
      { length: 1001 },
      (_, index) => `packages/${index}/requirements-extra-${index}.txt`
    );
    const inventory = collectDependencyInventory([...lockfiles, ...unsupported], new Map());

    expect(inventory.status).toBe('partial');
    expect(inventory.lockfiles).toHaveLength(1000);
    expect(inventory.omittedLockfileCount).toBe(1);
    expect(inventory.unsupportedFiles).toHaveLength(1000);
    expect(inventory.omittedUnsupportedFileCount).toBe(1);
    expect(inventory.limitations).toContain(
      'Dependency lockfile count limit reached; 1 additional lockfile path(s) are omitted.'
    );
    expect(inventory.limitations).toContain(
      'Dependency metadata is detected but transitive dependency parsing is not supported for 1001 file(s); 1 unsupported file path(s) are omitted from the bounded path list.'
    );
    expect(inventory.limitations).toHaveLength(100);
    expect(inventory.additionalLimitationsOmitted).toBeGreaterThan(0);
    expect(inventory.limitations.at(-1)).toContain(
      'additional dependency limitation(s) are omitted'
    );
  });

  it('never persists arbitrary URL-like version values', () => {
    const result = collectDependencyInventory(
      ['package-lock.json'],
      new Map([
        [
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              '': { dependencies: { secretpkg: '*' } },
              'node_modules/secretpkg': { version: 'https://user:token@example.invalid/path' },
            },
          }),
        ],
      ])
    );
    expect(result.status).toBe('partial');
    expect(result.packages[0]?.version).toBeNull();
    expect(JSON.stringify(result)).not.toContain('token');
    expect(JSON.stringify(result)).not.toContain('example.invalid');
  });

  it('validates persisted package names, versions, and provenance paths at the schema boundary', () => {
    const valid = collectDependencyInventory(
      ['package-lock.json'],
      new Map([
        [
          'package-lock.json',
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              '': { dependencies: { alpha: '^1' } },
              'node_modules/alpha': { version: '1.0.0' },
            },
          }),
        ],
      ])
    );
    expect(projectDependencyInventorySchema.safeParse(valid).success).toBe(true);
    const packageEntry = valid.packages[0]!;
    expect(
      projectDependencyInventorySchema.safeParse({
        ...valid,
        packages: [{ ...packageEntry, version: 'https://user:pass@example.invalid' }],
      }).success
    ).toBe(false);
    expect(
      projectDependencyInventorySchema.safeParse({
        ...valid,
        lockfiles: ['/absolute/package-lock.json'],
      }).success
    ).toBe(false);
    expect(
      projectDependencyInventorySchema.safeParse({
        ...valid,
        unsupportedFiles: ['../escape/yarn.lock'],
      }).success
    ).toBe(false);
    expect(
      projectDependencyInventorySchema.safeParse({
        ...valid,
        status: 'complete',
        omittedLockfileCount: 1,
      }).success
    ).toBe(false);
  });
});
