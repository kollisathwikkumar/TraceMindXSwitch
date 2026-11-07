import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import * as toml from 'smol-toml';
import { z } from 'zod';

export const MAX_DEPENDENCY_LOCKFILE_BYTES = 8 * 1024 * 1024;
export const MAX_DEPENDENCY_MANIFEST_BYTES = 1024 * 1024;
export const MAX_DEPENDENCY_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_DEPENDENCY_CAPTURE_FILES = 128;
export const MAX_DEPENDENCY_PACKAGES = 10_000;
export const MAX_DEPENDENCY_EDGES = 20_000;

const packageNamePattern =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,214}$/;
const dependencyRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !/^[A-Za-z]:/.test(path) &&
      !/[\x00-\x1f\x7f]/.test(path) &&
      path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
const dependencyPackageNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(packageNamePattern)
  .refine((name) => !name.includes('..'));
const dependencyPackageVersionSchema = z
  .string()
  .max(128)
  .regex(/^[0-9][0-9A-Za-z.+!-]{0,127}$/)
  .nullable();

export const dependencyEcosystems = ['npm', 'pnpm', 'cargo', 'poetry', 'python'] as const;
export type DependencyEcosystem = (typeof dependencyEcosystems)[number];
export type DependencyCoverage = 'complete' | 'partial' | 'unavailable';

export interface ProjectDependencyPackage {
  id: string;
  ecosystem: DependencyEcosystem;
  name: string;
  version: string | null;
  sourcePath: string;
  direct: boolean;
}

export interface ProjectDependencyEdge {
  from: string | null;
  to: string;
  sourcePath: string;
}

export interface ProjectDependencyInventory {
  status: DependencyCoverage;
  lockfiles: string[];
  /** Exact number of lockfile paths omitted from the bounded persisted list. */
  omittedLockfileCount?: number;
  unsupportedFiles?: string[];
  /** Exact number of unsupported-file paths omitted from the bounded persisted list. */
  omittedUnsupportedFileCount?: number;
  /** Number of other diagnostic strings omitted from the bounded limitation list. */
  additionalLimitationsOmitted?: number;
  ecosystems: DependencyEcosystem[];
  packages: ProjectDependencyPackage[];
  edges: ProjectDependencyEdge[];
  limitations: string[];
}

export const projectDependencyInventorySchema = z
  .object({
    status: z.enum(['complete', 'partial', 'unavailable']),
    lockfiles: z.array(dependencyRelativePathSchema).max(1000),
    omittedLockfileCount: z.number().int().nonnegative().max(50_000).optional(),
    unsupportedFiles: z.array(dependencyRelativePathSchema).max(1000).optional(),
    omittedUnsupportedFileCount: z.number().int().nonnegative().max(50_000).optional(),
    additionalLimitationsOmitted: z.number().int().nonnegative().max(1_000_000).optional(),
    ecosystems: z.array(z.enum(dependencyEcosystems)).max(16),
    packages: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            ecosystem: z.enum(dependencyEcosystems),
            name: dependencyPackageNameSchema,
            version: dependencyPackageVersionSchema,
            sourcePath: dependencyRelativePathSchema,
            direct: z.boolean(),
          })
          .strict()
      )
      .max(MAX_DEPENDENCY_PACKAGES),
    edges: z
      .array(
        z
          .object({
            from: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
            to: z.string().regex(/^[a-f0-9]{64}$/),
            sourcePath: dependencyRelativePathSchema,
          })
          .strict()
      )
      .max(MAX_DEPENDENCY_EDGES),
    limitations: z.array(z.string().min(1).max(4096)).max(100),
  })
  .strict()
  .superRefine((inventory, context) => {
    const packageIds = new Set(inventory.packages.map((item) => item.id));
    if (packageIds.size !== inventory.packages.length) {
      context.addIssue({
        code: 'custom',
        message: 'Dependency package identifiers are not unique',
      });
    }
    for (const edge of inventory.edges) {
      if (!packageIds.has(edge.to) || (edge.from !== null && !packageIds.has(edge.from))) {
        context.addIssue({
          code: 'custom',
          message: 'Dependency edge points outside the inventory',
        });
        break;
      }
    }
    if (
      inventory.status === 'complete' &&
      (inventory.limitations.length > 0 ||
        (inventory.unsupportedFiles?.length ?? 0) > 0 ||
        (inventory.omittedLockfileCount ?? 0) > 0 ||
        (inventory.omittedUnsupportedFileCount ?? 0) > 0 ||
        (inventory.additionalLimitationsOmitted ?? 0) > 0)
    ) {
      context.addIssue({ code: 'custom', message: 'Complete dependency coverage has limitations' });
    }
  });

const dependencyFileNames = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'poetry.lock',
  'yarn.lock',
  'Pipfile',
  'Pipfile.lock',
  'uv.lock',
  'requirements.txt',
  'requirements-dev.txt',
  'go.mod',
  'go.sum',
  'go.work',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gradle.lockfile',
  'composer.json',
  'composer.lock',
  'Gemfile',
  'Gemfile.lock',
  'mix.exs',
  'mix.lock',
  'Directory.Packages.props',
  'Directory.Build.props',
  'Directory.Build.targets',
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
  'Package.swift',
  'Package.resolved',
  'packages.lock.json',
  'packages.config',
  'pubspec.yaml',
  'pubspec.lock',
  'Podfile',
  'Podfile.lock',
  'renv.lock',
  'deps.edn',
  'project.clj',
  'stack.yaml',
  'package.yaml',
  'cabal.project',
  'cabal.project.freeze',
  'cpanfile',
  'cpanfile.snapshot',
  'go.work.sum',
  'settings.gradle',
  'settings.gradle.kts',
]);

const lockfileEcosystems = new Map<string, DependencyEcosystem>([
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['Cargo.lock', 'cargo'],
  ['poetry.lock', 'poetry'],
]);
const dependencyParserInputNames = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'poetry.lock',
]);

export function isDependencyEvidenceFile(path: string): boolean {
  const name = posix.basename(path);
  return (
    dependencyFileNames.has(name) ||
    /\.(?:csproj|fsproj|vbproj|sln|slnx)$/i.test(name) ||
    /^requirements(?:-[a-z0-9_-]+)?\.txt$/i.test(name)
  );
}

export function isDependencyParserInputFile(path: string): boolean {
  return dependencyParserInputNames.has(posix.basename(path));
}

export function dependencyEvidenceByteLimit(path: string): number {
  return isLockfile(path) ? MAX_DEPENDENCY_LOCKFILE_BYTES : MAX_DEPENDENCY_MANIFEST_BYTES;
}

function isLockfile(path: string): boolean {
  return lockfileEcosystems.has(posix.basename(path));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function safePackageName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const name = value.trim();
  if (!packageNamePattern.test(name) || name.includes('..')) return null;
  return name;
}

/** Excludes URLs, local paths and arbitrary strings that could contain credentials. */
function safeVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const version = value.trim();
  return /^[0-9][0-9A-Za-z.+!-]{0,127}$/.test(version) ? version : null;
}

function deterministicId(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

interface ParsedLockfile {
  packages: ProjectDependencyPackage[];
  edges: ProjectDependencyEdge[];
  limitations: string[];
}

interface PackageNode {
  id: string;
  location: string;
  name: string;
  version: string | null;
  raw: Record<string, unknown>;
}

function stringMap(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (!record) throw new Error('Dependency map must be an object');
  const keys = Object.keys(record);
  if (keys.length > MAX_DEPENDENCY_PACKAGES) throw new Error('Dependency map limit exceeded');
  return record;
}

function dependencyNames(value: unknown): string[] {
  const names = Object.keys(stringMap(value)).map(safePackageName);
  if (names.some((name) => name === null))
    throw new Error('Dependency map contains an unsupported package name');
  return names.filter((name): name is string => name !== null).sort();
}

function npmNameFromInstallPath(location: string): string | null {
  const marker = 'node_modules/';
  const index = location.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = location.slice(index + marker.length);
  const parts = tail.split('/');
  const name = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0];
  return safePackageName(name);
}

function parentPackageLocation(location: string): string {
  const index = location.lastIndexOf('/node_modules/');
  return index < 0 ? '' : location.slice(0, index);
}

function findNpmPackage(
  packages: ReadonlyMap<string, PackageNode>,
  parent: string,
  dependencyName: string
): PackageNode | null {
  let scope = parent;
  for (let depth = 0; depth < 64; depth++) {
    const candidate = scope
      ? `${scope}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    const resolved = packages.get(candidate);
    if (resolved) return resolved;
    if (!scope) return null;
    const next = parentPackageLocation(scope);
    if (next === scope) return null;
    scope = next;
  }
  return null;
}

function npmDependencyMap(value: unknown): string[] {
  return dependencyNames(value);
}

function isOptionalNpmPeer(raw: Record<string, unknown>, name: string): boolean {
  const peerMetadata = asRecord(raw.peerDependenciesMeta);
  return asRecord(peerMetadata?.[name])?.optional === true;
}

function npmManifestDirectNames(content: string): string[] {
  const root = asRecord(JSON.parse(content));
  if (!root) throw new Error('package.json root must be an object');
  return [
    ...npmDependencyMap(root.dependencies),
    ...npmDependencyMap(root.devDependencies),
    ...npmDependencyMap(root.optionalDependencies),
    ...npmDependencyMap(root.peerDependencies),
  ].filter((name, index, all) => all.indexOf(name) === index);
}

function dependencySpecifications(value: unknown): string[] {
  return Object.entries(stringMap(value))
    .map(([name, specifier]) => {
      if (!safePackageName(name) || typeof specifier !== 'string') {
        throw new Error('Dependency declarations have an unsupported name or specifier');
      }
      return JSON.stringify([name, specifier]);
    })
    .sort();
}

function mergedDependencySpecifications(...values: unknown[]): string[] {
  return [...new Set(values.flatMap(dependencySpecifications))].sort();
}

function npmManifestSpecifications(content: string): string[] {
  const root = asRecord(JSON.parse(content));
  if (!root) throw new Error('package.json root must be an object');
  return mergedDependencySpecifications(
    root.dependencies,
    root.devDependencies,
    root.optionalDependencies,
    root.peerDependencies
  );
}

function pnpmManifestSpecifications(content: string): string[] {
  const root = asRecord(JSON.parse(content));
  if (!root) throw new Error('package.json root must be an object');
  return mergedDependencySpecifications(
    root.dependencies,
    root.devDependencies,
    root.optionalDependencies
  );
}

function pnpmImporterSpecifications(...values: unknown[]): string[] {
  return [
    ...new Set(
      values.flatMap((value) =>
        Object.entries(stringMap(value)).map(([name, declaration]) => {
          const specifier = asRecord(declaration)?.specifier;
          if (!safePackageName(name) || typeof specifier !== 'string') {
            throw new Error('pnpm importer declaration is missing a safe specifier');
          }
          return JSON.stringify([name, specifier]);
        })
      )
    ),
  ].sort();
}

function parseNpmLockfile(
  path: string,
  content: string,
  manifestContent?: string,
  manifestExpected = false
): ParsedLockfile {
  const root = asRecord(JSON.parse(content));
  if (!root) throw new Error('npm lockfile root must be an object');
  const lockfileVersion = root.lockfileVersion;
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    throw new Error('Only npm package-lock/npm-shrinkwrap versions 2 and 3 are supported');
  }
  const packageRecords = asRecord(root.packages);
  if (!packageRecords) throw new Error('npm lockfile has no package location table');
  const locations = Object.keys(packageRecords).sort();
  if (locations.length > MAX_DEPENDENCY_PACKAGES + 1)
    throw new Error('Dependency package limit exceeded');
  const nodes = new Map<string, PackageNode>();
  const limitations: string[] = [];
  for (const location of locations) {
    if (location === '') continue;
    if (!safeRelativePath(location))
      throw new Error('npm lockfile contains an unsafe package location');
    const raw = asRecord(packageRecords[location]);
    if (!raw) throw new Error('npm lockfile package entry must be an object');
    if (raw.link === true) {
      limitations.push(
        'Workspace link entries are identified but their package manifests are not recursively joined.'
      );
      continue;
    }
    const name = safePackageName(raw.name) ?? npmNameFromInstallPath(location);
    if (!name) {
      limitations.push('A package entry has an unsupported or missing package name.');
      continue;
    }
    const version = safeVersion(raw.version);
    if (raw.version !== undefined && version === null) {
      limitations.push(
        'A package version uses a non-semver source and is omitted from persisted evidence.'
      );
    }
    const id = deterministicId(['npm', path, location, name, version ?? '']);
    nodes.set(location, { id, location, name, version, raw });
  }
  const rootEntry = asRecord(packageRecords['']) ?? root;
  const rootDependencies = new Set([
    ...npmDependencyMap(rootEntry.dependencies),
    ...npmDependencyMap(rootEntry.devDependencies),
    ...npmDependencyMap(rootEntry.optionalDependencies),
  ]);
  const rootPeerDependencies = npmDependencyMap(rootEntry.peerDependencies);
  if (manifestExpected && manifestContent === undefined) {
    limitations.push(
      'package.json content was not captured, so direct declarations could not be checked against the npm lockfile.'
    );
  } else if (manifestContent !== undefined) {
    try {
      const manifestSpecifications = npmManifestSpecifications(manifestContent);
      const lockSpecifications = mergedDependencySpecifications(
        rootEntry.dependencies,
        rootEntry.devDependencies,
        rootEntry.optionalDependencies,
        rootEntry.peerDependencies
      );
      if (JSON.stringify(manifestSpecifications) !== JSON.stringify(lockSpecifications)) {
        limitations.push(
          'package.json direct dependency declarations differ from npm lockfile root declarations.'
        );
      }
    } catch {
      limitations.push(
        'package.json direct dependency declarations could not be safely checked against the npm lockfile.'
      );
    }
  }
  const directIds = new Set<string>();
  const edges: ProjectDependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string | null, to: string): void => {
    const key = `${from ?? 'root'}:${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    if (edges.length >= MAX_DEPENDENCY_EDGES) {
      limitations.push('Dependency edge limit reached; remaining edges were omitted.');
      return;
    }
    edges.push({ from, to, sourcePath: path });
  };
  for (const name of rootDependencies) {
    const target = findNpmPackage(nodes, '', name);
    if (!target) {
      limitations.push(`An npm root dependency is not resolved in the lockfile: ${name}.`);
      continue;
    }
    directIds.add(target.id);
    addEdge(null, target.id);
  }
  for (const name of rootPeerDependencies) {
    const target = findNpmPackage(nodes, '', name);
    if (!target) {
      if (isOptionalNpmPeer(rootEntry, name)) continue;
      limitations.push(`An npm root peer dependency is not resolved in the lockfile: ${name}.`);
      continue;
    }
    directIds.add(target.id);
    addEdge(null, target.id);
  }
  for (const packageNode of nodes.values()) {
    const dependencies = [
      ...npmDependencyMap(packageNode.raw.dependencies),
      ...npmDependencyMap(packageNode.raw.optionalDependencies),
    ];
    for (const name of new Set(dependencies)) {
      const target = findNpmPackage(nodes, packageNode.location, name);
      if (!target) {
        limitations.push(
          `An npm package dependency is not resolved in the lockfile: ${packageNode.name} -> ${name}.`
        );
        continue;
      }
      addEdge(packageNode.id, target.id);
    }
    for (const name of npmDependencyMap(packageNode.raw.peerDependencies)) {
      const target = findNpmPackage(nodes, packageNode.location, name);
      if (!target) {
        if (isOptionalNpmPeer(packageNode.raw, name)) continue;
        limitations.push(
          `An npm package peer dependency is not resolved in the lockfile: ${packageNode.name} -> ${name}.`
        );
        continue;
      }
      addEdge(packageNode.id, target.id);
    }
  }
  const packages = [...nodes.values()].map((node) => ({
    id: node.id,
    ecosystem: 'npm' as const,
    name: node.name,
    version: node.version,
    sourcePath: path,
    direct: directIds.has(node.id),
  }));
  return { packages, edges, limitations };
}

function pnpmPackageNameAndVersion(key: string): { name: string; version: string } | null {
  const normalized = key.replace(/^\//, '').replace(/\([^)]*\)$/, '');
  const delimiter = normalized.lastIndexOf('@');
  if (delimiter <= 0 || delimiter === normalized.length - 1) return null;
  const name = safePackageName(normalized.slice(0, delimiter));
  const version = safeVersion(normalized.slice(delimiter + 1));
  return name && version ? { name, version } : null;
}

function pnpmVersion(value: unknown): string | null {
  const rawVersion = typeof value === 'string' ? value : asRecord(value)?.version;
  if (typeof rawVersion !== 'string') return null;
  const match = /^([0-9][0-9A-Za-z.+!-]{0,127})(?:\([^()\r\n]{0,256}\))*$/.exec(rawVersion.trim());
  return safeVersion(match?.[1]);
}

function canonicalPnpmKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function parsePnpmLockfile(
  path: string,
  content: string,
  manifests: ReadonlyMap<string, string | undefined> = new Map()
): ParsedLockfile {
  const root = asRecord(loadYaml(content, { schema: JSON_SCHEMA }));
  if (!root) throw new Error('pnpm lockfile root must be an object');
  const lockVersion = String(root.lockfileVersion ?? '');
  const versionMatch = /^(6|7|8|9)(?:\.0)?$/.exec(lockVersion);
  if (!versionMatch) {
    throw new Error('Only pnpm lockfile versions 6 through 9 are supported');
  }
  const packagesMap = asRecord(root.packages);
  if (!packagesMap) throw new Error('pnpm lockfile has no packages table');
  const snapshots = asRecord(root.snapshots) ?? packagesMap;
  const packageKeys = Object.keys(packagesMap).sort();
  const snapshotKeys = Object.keys(snapshots).sort();
  if (packageKeys.length > MAX_DEPENDENCY_PACKAGES || snapshotKeys.length > MAX_DEPENDENCY_PACKAGES)
    throw new Error('Dependency package limit exceeded');
  const nodesByKey = new Map<string, PackageNode>();
  const byCanonical = new Map<string, PackageNode[]>();
  const limitations: string[] = [];
  const importers = asRecord(root.importers);
  for (const [importerPath, manifestContent] of manifests) {
    if (manifestContent === undefined) {
      limitations.push(
        `package.json content was not captured, so direct declarations could not be checked against pnpm importer "${importerPath}".`
      );
      continue;
    }
    const importer = importers
      ? asRecord(importers[importerPath])
      : importerPath === '.'
        ? root
        : null;
    if (!importer) {
      limitations.push(
        `The pnpm lockfile has no importer for package.json directory "${importerPath}".`
      );
      continue;
    }
    try {
      const manifestSpecifications = pnpmManifestSpecifications(manifestContent);
      const importerSpecifications = pnpmImporterSpecifications(
        importer.dependencies,
        importer.devDependencies,
        importer.optionalDependencies
      );
      if (JSON.stringify(manifestSpecifications) !== JSON.stringify(importerSpecifications)) {
        limitations.push(
          `package.json direct dependency declarations differ from pnpm importer "${importerPath}".`
        );
      }
    } catch {
      limitations.push(
        `package.json direct dependency declarations could not be safely checked against pnpm importer "${importerPath}".`
      );
    }
  }
  for (const key of packageKeys) {
    const parsed = pnpmPackageNameAndVersion(key);
    if (!parsed) {
      limitations.push('A pnpm package key has an unsupported source or version and was omitted.');
      continue;
    }
    const raw = asRecord(packagesMap[key]) ?? {};
    const id = deterministicId(['pnpm', path, key, parsed.name, parsed.version]);
    const node: PackageNode = {
      id,
      location: key,
      name: parsed.name,
      version: parsed.version,
      raw,
    };
    nodesByKey.set(key, node);
    const canonical = canonicalPnpmKey(parsed.name, parsed.version);
    const list = byCanonical.get(canonical) ?? [];
    list.push(node);
    byCanonical.set(canonical, list);
  }
  const snapshotsById = new Map<string, Record<string, unknown>[]>();
  for (const [key, value] of Object.entries(snapshots)) {
    const parsed = pnpmPackageNameAndVersion(key);
    const candidates = parsed
      ? (byCanonical.get(canonicalPnpmKey(parsed.name, parsed.version)) ?? [])
      : [];
    const node = candidates.length === 1 ? candidates[0]! : null;
    if (node) {
      const record = asRecord(value);
      if (record) {
        const records = snapshotsById.get(node.id) ?? [];
        records.push(record);
        snapshotsById.set(node.id, records);
      } else limitations.push('A pnpm snapshot entry is not an object.');
    } else if (parsed && candidates.length > 1) {
      limitations.push(
        'A pnpm peer-specific snapshot cannot be uniquely linked to a package record.'
      );
    } else if (parsed) {
      limitations.push('A pnpm snapshot has no matching package record.');
    } else {
      limitations.push('A pnpm snapshot key has an unsupported source or version.');
    }
  }
  const edges: ProjectDependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string | null, to: string): void => {
    const key = `${from ?? 'root'}:${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    if (edges.length >= MAX_DEPENDENCY_EDGES) {
      limitations.push('Dependency edge limit reached; remaining edges were omitted.');
      return;
    }
    edges.push({ from, to, sourcePath: path });
  };
  const resolve = (name: string, value: unknown): PackageNode | null => {
    const version = pnpmVersion(value);
    if (!version) return null;
    const matches = byCanonical.get(canonicalPnpmKey(name, version)) ?? [];
    return matches.length === 1 ? matches[0]! : null;
  };
  const importerRecords = importers ? Object.values(importers) : [root];
  for (const importer of importerRecords) {
    const record = asRecord(importer);
    if (!record) continue;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [nameValue, versionValue] of Object.entries(stringMap(record[section]))) {
        const name = safePackageName(nameValue);
        if (!name) continue;
        const target = resolve(name, versionValue);
        if (!target) {
          limitations.push(`A pnpm importer dependency is not resolved: ${name}.`);
          continue;
        }
        addEdge(null, target.id);
      }
    }
  }
  for (const node of nodesByKey.values()) {
    const snapshotsForNode = snapshotsById.get(node.id);
    if (snapshotsForNode && snapshotsForNode.length > 1) {
      limitations.push(
        `Multiple peer-specific pnpm snapshots share ${node.name}@${node.version}; their edges are merged.`
      );
    }
    const records = snapshotsForNode ?? [node.raw];
    for (const snapshot of records) {
      for (const section of ['dependencies', 'optionalDependencies']) {
        for (const [nameValue, versionValue] of Object.entries(stringMap(snapshot[section]))) {
          const name = safePackageName(nameValue);
          if (!name) continue;
          const target = resolve(name, versionValue);
          if (!target) {
            limitations.push(
              `A pnpm package dependency is not resolved or is ambiguous: ${node.name} -> ${name}.`
            );
            continue;
          }
          addEdge(node.id, target.id);
        }
      }
    }
  }
  const directIds = new Set(edges.filter((edge) => edge.from === null).map((edge) => edge.to));
  return {
    packages: [...nodesByKey.values()].map((node) => ({
      id: node.id,
      ecosystem: 'pnpm' as const,
      name: node.name,
      version: node.version,
      sourcePath: path,
      direct: directIds.has(node.id),
    })),
    edges,
    limitations,
  };
}

function tomlRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function normalizedPythonName(value: string): string {
  return value.toLowerCase().replace(/[-_.]+/g, '-');
}

function pythonNamesFromPyproject(content: string | undefined): Set<string> {
  if (!content) return new Set();
  const root = tomlRecord(toml.parse(content, { maxDepth: 64, unsafeKeyBehaviour: 'throw' }));
  const names = new Set<string>();
  const project = tomlRecord(root.project);
  const poetry = tomlRecord(tomlRecord(root.tool).poetry);
  const addRecordNames = (value: unknown): void => {
    for (const name of Object.keys(tomlRecord(value))) {
      if (normalizedPythonName(name) === 'python') continue;
      const safe = safePackageName(name);
      if (safe) names.add(normalizedPythonName(safe));
    }
  };
  addRecordNames(poetry.dependencies);
  addRecordNames(poetry['dev-dependencies']);
  addRecordNames(tomlRecord(poetry.dev).dependencies);
  for (const group of Object.values(tomlRecord(poetry.group))) {
    addRecordNames(tomlRecord(group).dependencies);
  }
  if (Array.isArray(project.dependencies)) {
    for (const value of project.dependencies) {
      if (typeof value !== 'string') continue;
      const name = safePackageName(/^([A-Za-z0-9_.-]+)/.exec(value.trim())?.[1]);
      if (name) names.add(normalizedPythonName(name));
    }
  }
  for (const group of Object.values(tomlRecord(project['optional-dependencies']))) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (typeof value !== 'string') continue;
      const name = safePackageName(/^([A-Za-z0-9_.-]+)/.exec(value.trim())?.[1]);
      if (name) names.add(normalizedPythonName(name));
    }
  }
  return names;
}

function parsePoetryLockfile(
  path: string,
  content: string,
  pyproject: string | undefined
): ParsedLockfile {
  const root = tomlRecord(toml.parse(content, { maxDepth: 64, unsafeKeyBehaviour: 'throw' }));
  if (!Array.isArray(root.package)) throw new Error('Poetry lockfile has no package records');
  if (root.package.length > MAX_DEPENDENCY_PACKAGES)
    throw new Error('Dependency package limit exceeded');
  const directNames = pythonNamesFromPyproject(pyproject);
  const nodes: PackageNode[] = [];
  const byName = new Map<string, PackageNode[]>();
  const limitations: string[] = [];
  const lockVersion = tomlRecord(root.metadata)['lock-version'];
  if (!['1.1', '2.0', '2.1'].includes(String(lockVersion ?? ''))) {
    limitations.push(
      'Poetry lockfile version is missing or unsupported; package closure may be incomplete.'
    );
  }
  if (pyproject === undefined) {
    limitations.push('pyproject.toml was not captured; direct Poetry dependencies are unknown.');
  }
  for (const [index, value] of root.package.entries()) {
    const record = asRecord(value);
    if (!record) {
      limitations.push('A Poetry package entry is malformed.');
      continue;
    }
    const name = safePackageName(record.name);
    if (!name) {
      limitations.push('A Poetry package has an unsupported name.');
      continue;
    }
    const version = safeVersion(record.version);
    if (!version) {
      limitations.push('A Poetry package version is unsupported and omitted.');
      continue;
    }
    const id = deterministicId([
      'poetry',
      path,
      String(index),
      normalizedPythonName(name),
      version,
    ]);
    const node: PackageNode = { id, location: String(index), name, version, raw: record };
    nodes.push(node);
    const key = normalizedPythonName(name);
    const matches = byName.get(key) ?? [];
    matches.push(node);
    byName.set(key, matches);
  }
  const edges: ProjectDependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string | null, to: string): void => {
    const key = `${from ?? 'root'}:${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    if (edges.length >= MAX_DEPENDENCY_EDGES) {
      limitations.push('Dependency edge limit reached; remaining edges were omitted.');
      return;
    }
    edges.push({ from, to, sourcePath: path });
  };
  const directIds = new Set<string>();
  for (const name of directNames) {
    const matches = byName.get(name) ?? [];
    if (matches.length === 1) {
      addEdge(null, matches[0]!.id);
      directIds.add(matches[0]!.id);
    } else if (matches.length !== 0) {
      limitations.push(`A direct Poetry dependency has multiple locked versions: ${name}.`);
    } else {
      limitations.push(`A direct Poetry dependency is absent from poetry.lock: ${name}.`);
    }
  }
  for (const node of nodes) {
    const dependencies = Object.keys(tomlRecord(node.raw.dependencies))
      .map((name) => safePackageName(name))
      .filter((name): name is string => name !== null);
    for (const name of dependencies) {
      const matches = byName.get(normalizedPythonName(name)) ?? [];
      if (matches.length === 1) addEdge(node.id, matches[0]!.id);
      else
        limitations.push(
          `A Poetry package dependency is unresolved or ambiguous: ${node.name} -> ${name}.`
        );
    }
  }
  return {
    packages: nodes.map((node) => ({
      id: node.id,
      ecosystem: 'poetry' as const,
      name: node.name,
      version: node.version,
      sourcePath: path,
      direct: directIds.has(node.id),
    })),
    edges,
    limitations,
  };
}

function cargoNamesFromManifest(content: string | undefined): Set<string> {
  if (!content) return new Set();
  const root = tomlRecord(toml.parse(content, { maxDepth: 64, unsafeKeyBehaviour: 'throw' }));
  const names = new Set<string>();
  const addDependencyNames = (value: unknown): void => {
    for (const [alias, declaration] of Object.entries(tomlRecord(value))) {
      const targetName = asRecord(declaration)?.package ?? alias;
      const safe = safePackageName(targetName);
      if (safe) names.add(safe);
    }
  };
  for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
    addDependencyNames(root[section]);
  }
  for (const target of Object.values(tomlRecord(root.target))) {
    const targetRecord = tomlRecord(target);
    for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      addDependencyNames(targetRecord[section]);
    }
  }
  return names;
}

function parseCargoLockfile(path: string, content: string, manifest?: string): ParsedLockfile {
  const root = tomlRecord(toml.parse(content, { maxDepth: 64, unsafeKeyBehaviour: 'throw' }));
  if (!Array.isArray(root.package)) throw new Error('Cargo.lock has no package records');
  if (root.version !== undefined && ![1, 2, 3, 4].includes(Number(root.version))) {
    throw new Error('Only Cargo.lock versions 1 through 4 are supported');
  }
  if (root.package.length > MAX_DEPENDENCY_PACKAGES)
    throw new Error('Dependency package limit exceeded');
  const directNames = cargoNamesFromManifest(manifest);
  const nodes: PackageNode[] = [];
  const byKey = new Map<string, PackageNode[]>();
  const byName = new Map<string, PackageNode[]>();
  const limitations: string[] = [];
  const manifestRoot = manifest
    ? tomlRecord(toml.parse(manifest, { maxDepth: 64, unsafeKeyBehaviour: 'throw' }))
    : {};
  const rootPackage = tomlRecord(manifestRoot.package);
  const rootPackageName = safePackageName(rootPackage.name);
  const rootPackageVersion = safeVersion(rootPackage.version);
  if (Object.hasOwn(manifestRoot, 'workspace')) {
    limitations.push(
      'Cargo workspace member manifests are not joined; direct member dependency linkage may be incomplete.'
    );
  }
  if (manifest === undefined) {
    limitations.push('Cargo.toml was not captured; direct Cargo dependencies are unknown.');
  }
  for (const [index, value] of root.package.entries()) {
    const record = asRecord(value);
    if (!record) {
      limitations.push('A Cargo package entry is malformed.');
      continue;
    }
    const name = safePackageName(record.name);
    if (!name) {
      limitations.push('A Cargo package has an unsupported name.');
      continue;
    }
    const version = safeVersion(record.version);
    if (!version) {
      limitations.push('A Cargo package version is unsupported and omitted.');
      continue;
    }
    if (record.source === undefined && name === rootPackageName && version === rootPackageVersion) {
      continue;
    }
    const id = deterministicId(['cargo', path, String(index), name, version]);
    const node: PackageNode = { id, location: String(index), name, version, raw: record };
    nodes.push(node);
    const key = `${name}@${version}`;
    const keyMatches = byKey.get(key) ?? [];
    keyMatches.push(node);
    byKey.set(key, keyMatches);
    const nameMatches = byName.get(name) ?? [];
    nameMatches.push(node);
    byName.set(name, nameMatches);
  }
  const edges: ProjectDependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string | null, to: string): void => {
    const key = `${from ?? 'root'}:${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    if (edges.length >= MAX_DEPENDENCY_EDGES) {
      limitations.push('Dependency edge limit reached; remaining edges were omitted.');
      return;
    }
    edges.push({ from, to, sourcePath: path });
  };
  const directIds = new Set<string>();
  for (const name of directNames) {
    const matches = byName.get(name) ?? [];
    if (matches.length === 1) {
      addEdge(null, matches[0]!.id);
      directIds.add(matches[0]!.id);
    } else if (matches.length > 1) {
      limitations.push(
        `A direct Cargo dependency has multiple locked versions, so root linkage is ambiguous: ${name}.`
      );
    } else {
      limitations.push(`A direct Cargo dependency is absent from Cargo.lock: ${name}.`);
    }
  }
  for (const node of nodes) {
    const dependencies = Array.isArray(node.raw.dependencies) ? node.raw.dependencies : [];
    for (const dependency of dependencies) {
      if (typeof dependency !== 'string' || dependency.length > 512) {
        limitations.push('A Cargo dependency reference is malformed.');
        continue;
      }
      const match =
        /^([A-Za-z0-9_.-]+) ([0-9][0-9A-Za-z.+!-]{0,127})(?: \([^\r\n)]{0,256}\))?$/.exec(
          dependency
        );
      const name = safePackageName(match?.[1]);
      const version = safeVersion(match?.[2]);
      if (!name || !version) {
        limitations.push(`A Cargo dependency reference is unsupported: ${node.name}.`);
        continue;
      }
      const matches = byKey.get(`${name}@${version}`) ?? [];
      if (matches.length === 1) addEdge(node.id, matches[0]!.id);
      else
        limitations.push(`A Cargo dependency is unresolved or ambiguous: ${node.name} -> ${name}.`);
    }
  }
  return {
    packages: nodes.map((node) => ({
      id: node.id,
      ecosystem: 'cargo' as const,
      name: node.name,
      version: node.version,
      sourcePath: path,
      direct: directIds.has(node.id),
    })),
    edges,
    limitations,
  };
}

/**
 * Parses only committed/local lockfile content already captured by an approved audit. It never
 * invokes a package manager, follows a source URL, or persists registry/source URLs or credentials.
 */
export function collectDependencyInventory(
  files: readonly string[],
  contents: ReadonlyMap<string, string>,
  options: { scanComplete?: boolean } = {}
): ProjectDependencyInventory {
  const scanComplete = options.scanComplete ?? true;
  const allLockfiles = [...new Set(files.filter(isLockfile).filter(safeRelativePath))].sort();
  const lockfiles = allLockfiles.slice(0, 1000);
  const omittedLockfileCount = Math.max(0, allLockfiles.length - lockfiles.length);
  const manifestPaths = [
    ...new Set(
      files
        .filter((path) =>
          ['package.json', 'Cargo.toml', 'pyproject.toml'].includes(posix.basename(path))
        )
        .filter(safeRelativePath)
    ),
  ].sort();
  const hasEnclosingPnpmLock = (manifestPath: string): boolean =>
    files.some((candidate) => {
      if (posix.basename(candidate) !== 'pnpm-lock.yaml') return false;
      const importerPath = posix.relative(posix.dirname(candidate), posix.dirname(manifestPath));
      return (
        importerPath !== '..' && !importerPath.startsWith('../') && !posix.isAbsolute(importerPath)
      );
    });
  const hasAdjacentNpmLock = (manifestPath: string): boolean =>
    files.some(
      (candidate) =>
        ['package-lock.json', 'npm-shrinkwrap.json'].includes(posix.basename(candidate)) &&
        posix.dirname(candidate) === posix.dirname(manifestPath)
    );
  const manifestEcosystems: DependencyEcosystem[] = files.flatMap((path) => {
    const name = posix.basename(path);
    if (name === 'package.json') {
      return hasEnclosingPnpmLock(path) && !hasAdjacentNpmLock(path) ? ['pnpm'] : ['npm'];
    }
    if (name === 'Cargo.toml') return ['cargo'];
    if (name === 'pyproject.toml') {
      const hasPoetryLock = files.some(
        (candidate) =>
          posix.basename(candidate) === 'poetry.lock' &&
          posix.dirname(candidate) === posix.dirname(path)
      );
      return [hasPoetryLock ? 'poetry' : 'python'];
    }
    if (
      name === 'Pipfile' ||
      name === 'Pipfile.lock' ||
      name === 'uv.lock' ||
      /^requirements(?:-[a-z0-9_-]+)?\.txt$/i.test(name)
    )
      return ['python'];
    return [];
  });
  const ecosystems = [
    ...new Set([
      ...lockfiles.map((path) => lockfileEcosystems.get(posix.basename(path))!),
      ...manifestEcosystems,
    ]),
  ].sort();
  const packages: ProjectDependencyPackage[] = [];
  const edges: ProjectDependencyEdge[] = [];
  const limitations = new Set<string>();
  if (!scanComplete) {
    limitations.add(
      'The project file scan was incomplete; unseen dependency manifests or lockfiles may affect closure coverage.'
    );
  }
  if (omittedLockfileCount > 0) {
    limitations.add(
      `Dependency lockfile count limit reached; ${omittedLockfileCount} additional lockfile path(s) are omitted.`
    );
  }
  let recognizedButUnsupported = false;
  for (const path of files.filter((file) => dependencyFileNames.has(posix.basename(file)))) {
    if (isLockfile(path)) continue;
    if (
      [
        'yarn.lock',
        'Pipfile.lock',
        'uv.lock',
        'requirements.txt',
        'requirements-dev.txt',
        'go.sum',
        'gradle.lockfile',
        'composer.lock',
        'Gemfile.lock',
        'mix.lock',
      ].includes(posix.basename(path))
    ) {
      recognizedButUnsupported = true;
      limitations.add(
        `Dependency lockfile format is detected but closure parsing is not supported yet: ${posix.basename(path)}.`
      );
    }
  }
  const unsupportedEvidenceFiles = [
    ...new Set(
      files
        .filter(safeRelativePath)
        .filter((path) => isDependencyEvidenceFile(path) && !isDependencyParserInputFile(path))
    ),
  ].sort();
  const omittedUnsupportedFileCount = Math.max(0, unsupportedEvidenceFiles.length - 1000);
  if (unsupportedEvidenceFiles.length > 0) {
    recognizedButUnsupported = true;
    limitations.add(
      `Dependency metadata is detected but transitive dependency parsing is not supported for ${unsupportedEvidenceFiles.length} file(s); ${omittedUnsupportedFileCount} unsupported file path(s) are omitted from the bounded path list.`
    );
  }
  for (const path of lockfiles) {
    const content = contents.get(path);
    if (content === undefined) {
      limitations.add(
        `Dependency lockfile content was not captured within the bounded audit budget: ${path}.`
      );
      continue;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_DEPENDENCY_LOCKFILE_BYTES) {
      limitations.add(
        `Dependency lockfile exceeds the ${MAX_DEPENDENCY_LOCKFILE_BYTES}-byte parser limit: ${path}.`
      );
      continue;
    }
    try {
      const ecosystem = lockfileEcosystems.get(posix.basename(path));
      let parsed: ParsedLockfile;
      if (ecosystem === 'npm') {
        const manifestPath = manifestPaths.find(
          (candidate) =>
            posix.basename(candidate) === 'package.json' &&
            posix.dirname(candidate) === posix.dirname(path)
        );
        parsed = parseNpmLockfile(
          path,
          content,
          manifestPath === undefined ? undefined : contents.get(manifestPath),
          manifestPath !== undefined
        );
      } else if (ecosystem === 'pnpm') {
        const lockDirectory = posix.dirname(path);
        const manifests = new Map<string, string | undefined>();
        for (const manifestPath of manifestPaths) {
          if (posix.basename(manifestPath) !== 'package.json') continue;
          const manifestDirectory = posix.dirname(manifestPath);
          const hasIndependentLock = files.some(
            (candidate) =>
              candidate !== path &&
              ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json'].includes(
                posix.basename(candidate)
              ) &&
              posix.dirname(candidate) === manifestDirectory
          );
          if (hasIndependentLock) continue;
          const importerPath = posix.relative(lockDirectory, posix.dirname(manifestPath));
          if (
            importerPath === '..' ||
            importerPath.startsWith('../') ||
            posix.isAbsolute(importerPath)
          )
            continue;
          manifests.set(importerPath || '.', contents.get(manifestPath));
        }
        parsed = parsePnpmLockfile(path, content, manifests);
      } else if (ecosystem === 'cargo') {
        const manifest = manifestPaths
          .filter((candidate) => posix.dirname(candidate) === posix.dirname(path))
          .map((candidate) => contents.get(candidate))
          .find((candidate): candidate is string => candidate !== undefined);
        parsed = parseCargoLockfile(path, content, manifest);
      } else {
        const manifest = manifestPaths
          .filter((candidate) => posix.dirname(candidate) === posix.dirname(path))
          .map((candidate) => contents.get(candidate))
          .find((candidate): candidate is string => candidate !== undefined);
        parsed = parsePoetryLockfile(path, content, manifest);
      }
      packages.push(...parsed.packages);
      edges.push(...parsed.edges);
      for (const limitation of parsed.limitations) limitations.add(limitation);
    } catch {
      limitations.add(`Dependency lockfile could not be safely parsed: ${path}.`);
    }
  }
  const sameDirectoryHas = (manifestPath: string, candidateNames: readonly string[]): boolean =>
    files.some(
      (candidate) =>
        candidateNames.includes(posix.basename(candidate)) &&
        posix.dirname(candidate) === posix.dirname(manifestPath)
    );
  const addDirectOnly = (
    ecosystem: DependencyEcosystem,
    manifestPath: string,
    names: readonly string[]
  ): void => {
    for (const name of names) {
      const canonical =
        ecosystem === 'poetry' || ecosystem === 'python' ? normalizedPythonName(name) : name;
      const id = deterministicId([`${ecosystem}-manifest`, manifestPath, canonical]);
      packages.push({
        id,
        ecosystem,
        name: canonical,
        version: null,
        sourcePath: manifestPath,
        direct: true,
      });
      edges.push({ from: null, to: id, sourcePath: manifestPath });
    }
  };
  for (const path of manifestPaths) {
    const name = posix.basename(path);
    const content = contents.get(path);
    if (
      name === 'package.json' &&
      !sameDirectoryHas(path, ['package-lock.json', 'npm-shrinkwrap.json']) &&
      !hasEnclosingPnpmLock(path)
    ) {
      if (content === undefined) {
        limitations.add(`package.json dependency declarations were not captured: ${path}.`);
        continue;
      }
      try {
        addDirectOnly('npm', path, npmManifestDirectNames(content));
        limitations.add(
          'Only direct npm dependency declarations are available; no supported npm lockfile was captured in this package directory.'
        );
      } catch {
        limitations.add(`package.json dependency declarations could not be parsed: ${path}.`);
      }
    } else if (name === 'Cargo.toml' && !sameDirectoryHas(path, ['Cargo.lock'])) {
      if (content === undefined) {
        limitations.add(`Cargo.toml dependency declarations were not captured: ${path}.`);
        continue;
      }
      try {
        addDirectOnly('cargo', path, [...cargoNamesFromManifest(content)]);
        limitations.add(
          'Only direct Cargo dependency declarations are available; Cargo.lock was not captured in this package directory.'
        );
      } catch {
        limitations.add(`Cargo.toml dependency declarations could not be parsed: ${path}.`);
      }
    } else if (name === 'pyproject.toml' && !sameDirectoryHas(path, ['poetry.lock'])) {
      if (content === undefined) {
        limitations.add(`pyproject.toml dependency declarations were not captured: ${path}.`);
        continue;
      }
      try {
        addDirectOnly('python', path, [...pythonNamesFromPyproject(content)]);
        limitations.add(
          'Only direct Python project dependency declarations are available; poetry.lock was not captured in this package directory.'
        );
      } catch {
        limitations.add(`pyproject.toml dependency declarations could not be parsed: ${path}.`);
      }
    }
  }
  if (packages.length > MAX_DEPENDENCY_PACKAGES || edges.length > MAX_DEPENDENCY_EDGES) {
    packages.length = Math.min(packages.length, MAX_DEPENDENCY_PACKAGES);
    const packageIds = new Set(packages.map((pkg) => pkg.id));
    edges.length = Math.min(edges.length, MAX_DEPENDENCY_EDGES);
    for (let index = edges.length - 1; index >= 0; index--) {
      const edge = edges[index]!;
      if (!packageIds.has(edge.to) || (edge.from !== null && !packageIds.has(edge.from)))
        edges.splice(index, 1);
    }
    limitations.add('Combined dependency inventory reached its package or edge limit.');
  }
  const packageIds = new Set(packages.map((pkg) => pkg.id));
  const validEdges = edges.filter(
    (edge) => packageIds.has(edge.to) && (edge.from === null || packageIds.has(edge.from))
  );
  const uniquePackages = [...new Map(packages.map((pkg) => [pkg.id, pkg])).values()];
  const finalIds = new Set(uniquePackages.map((pkg) => pkg.id));
  const finalEdges = validEdges.filter(
    (edge) => finalIds.has(edge.to) && (edge.from === null || finalIds.has(edge.from))
  );
  const hasDependencyMetadata =
    lockfiles.length > 0 || unsupportedEvidenceFiles.length > 0 || manifestPaths.length > 0;
  if (!hasDependencyMetadata) {
    limitations.add(
      'No recognized dependency manifest or lockfile was inventoried; dependency closure is unavailable.'
    );
  }
  const priorityLimitations = [...limitations].sort((left, right) => {
    const priority = (value: string): number =>
      /^(?:Dependency lockfile count limit reached|Dependency metadata is detected but|Combined dependency inventory reached)/.test(
        value
      )
        ? 0
        : /(?:limit reached|format is detected but closure parsing is not supported)/.test(value)
          ? 1
          : 2;
    return priority(left) - priority(right) || left.localeCompare(right);
  });
  const additionalLimitationsOmitted = Math.max(0, priorityLimitations.length - 99);
  const uniqueLimitations =
    additionalLimitationsOmitted > 0
      ? [
          ...priorityLimitations.slice(0, 99),
          `${additionalLimitationsOmitted} additional dependency limitation(s) are omitted from the bounded list.`,
        ]
      : priorityLimitations;
  let status: DependencyCoverage;
  if (!hasDependencyMetadata) status = 'unavailable';
  else if (!scanComplete) status = 'partial';
  else if (lockfiles.length === 0) status = 'partial';
  else if (
    uniqueLimitations.length > 0 ||
    recognizedButUnsupported ||
    lockfiles.some((path) => contents.get(path) === undefined)
  )
    status = 'partial';
  else status = 'complete';
  const inventory: ProjectDependencyInventory = {
    status,
    lockfiles,
    ...(omittedLockfileCount > 0 ? { omittedLockfileCount } : {}),
    ...(unsupportedEvidenceFiles.length
      ? { unsupportedFiles: unsupportedEvidenceFiles.slice(0, 1000) }
      : {}),
    ...(omittedUnsupportedFileCount > 0 ? { omittedUnsupportedFileCount } : {}),
    ...(additionalLimitationsOmitted > 0 ? { additionalLimitationsOmitted } : {}),
    ecosystems,
    packages: uniquePackages.sort((a, b) => a.id.localeCompare(b.id)),
    edges: finalEdges.sort((a, b) =>
      `${a.from ?? ''}:${a.to}`.localeCompare(`${b.from ?? ''}:${b.to}`)
    ),
    limitations: uniqueLimitations,
  };
  return projectDependencyInventorySchema.parse(inventory);
}
