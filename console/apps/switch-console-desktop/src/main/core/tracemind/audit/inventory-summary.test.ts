import { describe, expect, it } from 'vitest';
import type { FileInventory } from './file-inventory';
import { summarizeInventory } from './inventory-summary';

const inventory: FileInventory = {
  root: '/fixture',
  files: ['src/app.ts', 'src/view.tsx', 'README.md', 'package.json', 'lib/main.py'],
  skipped: 3,
  errors: [],
  complete: true,
  entriesExamined: 9,
};

describe('inventory summary', () => {
  it('counts inferred languages and manifests without claiming parsing', () => {
    const summary = summarizeInventory(inventory);
    expect(summary.languages).toEqual([
      { language: 'Python', files: 1 },
      { language: 'TypeScript', files: 2 },
    ]);
    expect(summary.manifests).toEqual(['package.json']);
    expect(summary.filesDiscovered).toBe(5);
    expect(summary.filesParsed).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.inventoryComplete).toBe(true);
  });

  it('retains incomplete status and errors', () => {
    const summary = summarizeInventory({
      ...inventory,
      complete: false,
      errors: [{ path: 'blocked', message: 'Directory could not be read' }],
    });
    expect(summary.inventoryComplete).toBe(false);
    expect(summary.errors).toEqual([{ path: 'blocked', message: 'Directory could not be read' }]);
  });

  it('identifies nested manifests by exact filename', () => {
    const summary = summarizeInventory({
      ...inventory,
      files: ['x/package.json', 'package.json.bak', 'pyproject.toml', 'x/package.json'],
    });
    expect(summary.manifests).toEqual(['pyproject.toml', 'x/package.json']);
  });

  it('recognizes common source-language extensions and ecosystem manifests by filename', () => {
    const summary = summarizeInventory({
      ...inventory,
      files: [
        'src/main.kt',
        'src/main.rb',
        'src/main.swift',
        'src/main.rs',
        'src/main.mts',
        'src/view.vue',
        'Cargo.lock',
        'Gemfile.lock',
        'package-lock.json',
        'pnpm-lock.yaml',
        'poetry.lock',
        'pom.xml',
        'apps/desktop/Desktop.csproj',
        'requirements-test.txt',
        'settings.gradle.kts',
        'unknown.lock',
      ],
    });
    expect(summary.languages).toEqual([
      { language: 'Kotlin', files: 1 },
      { language: 'Kotlin DSL', files: 1 },
      { language: 'Ruby', files: 1 },
      { language: 'Rust', files: 1 },
      { language: 'Swift', files: 1 },
      { language: 'TypeScript', files: 1 },
      { language: 'Vue', files: 1 },
      { language: 'YAML', files: 1 },
    ]);
    expect(summary.manifests).toEqual([
      'Cargo.lock',
      'Gemfile.lock',
      'apps/desktop/Desktop.csproj',
      'package-lock.json',
      'pnpm-lock.yaml',
      'poetry.lock',
      'pom.xml',
      'requirements-test.txt',
      'settings.gradle.kts',
    ]);
    expect(summary.limitations).toContain(
      'Language counts are inferred from filenames; counts do not imply parser or build support.'
    );
  });

  it('recognizes additional compiled, functional, web, and platform manifest families', () => {
    const summary = summarizeInventory({
      ...inventory,
      files: [
        'src/app.fs',
        'src/main.clj',
        'src/index.html',
        'src/types.proto',
        'src/query.graphql',
        'src/model.prisma',
        'contracts/Token.sol',
        '.github/workflows/ci.yml',
        'bun.lock',
        'deno.jsonc',
        'Package.resolved',
        'pubspec.lock',
        'MySolution.slnx',
      ],
    });
    expect(summary.languages).toEqual(
      expect.arrayContaining([
        { language: 'F#', files: 1 },
        { language: 'Clojure', files: 1 },
        { language: 'HTML', files: 1 },
        { language: 'Protocol Buffers', files: 1 },
        { language: 'GraphQL', files: 1 },
        { language: 'Prisma', files: 1 },
        { language: 'Solidity', files: 1 },
        { language: 'YAML', files: 1 },
      ])
    );
    expect(summary.manifests).toEqual(
      expect.arrayContaining([
        'bun.lock',
        'deno.jsonc',
        'Package.resolved',
        'pubspec.lock',
        'MySolution.slnx',
      ])
    );
  });

  it('bounds the summary limitations while retaining dependency-specific detail separately', () => {
    const dependencyInventory = {
      status: 'partial' as const,
      lockfiles: [],
      ecosystems: [],
      packages: [],
      edges: [],
      limitations: Array.from({ length: 100 }, (_, index) => `dependency limitation ${index}`),
    };
    const summary = summarizeInventory(inventory, dependencyInventory);
    expect(summary.limitations).toHaveLength(80);
    expect(summary.limitations.at(-1)).toBe(
      'Additional inventory limitations are omitted from this summary; dependency details remain listed separately.'
    );
    expect(summary.dependencyInventory?.limitations).toHaveLength(100);
  });
});
