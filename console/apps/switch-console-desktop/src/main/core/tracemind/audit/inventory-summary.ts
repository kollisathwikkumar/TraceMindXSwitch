import { posix } from 'node:path';
import type { ProjectDependencyInventory } from './dependency-inventory';
import type { FileInventory, SkippedEntry } from './file-inventory';

export interface InventorySummary {
  filesDiscovered: number;
  filesParsed: number;
  graphCoverage?: { status: 'complete' | 'partial'; omittedFiles: number };
  skipped: number;
  skippedEntries?: SkippedEntry[];
  skipDetailsTruncated?: boolean;
  inventoryComplete: boolean;
  errors: { path: string; message: string }[];
  languages: { language: string; files: number }[];
  manifests: string[];
  dependencyInventory?: ProjectDependencyInventory;
  limitations: string[];
}

const SUMMARY_LIMITATION_BUDGET = 80;

const extensions: Readonly<Record<string, string>> = {
  '.c': 'C',
  '.h': 'C/C++ header',
  '.m': 'Objective-C',
  '.mm': 'Objective-C++',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.cs': 'C#',
  '.vb': 'Visual Basic',
  '.fs': 'F#',
  '.fsi': 'F#',
  '.fsx': 'F#',
  '.go': 'Go',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin DSL',
  '.scala': 'Scala',
  '.sc': 'Scala',
  '.groovy': 'Groovy',
  '.gradle': 'Gradle DSL',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.clj': 'Clojure',
  '.cljs': 'ClojureScript',
  '.cljc': 'Clojure',
  '.ml': 'OCaml',
  '.mli': 'OCaml',
  '.elm': 'Elm',
  '.swift': 'Swift',
  '.dart': 'Dart',
  '.lua': 'Lua',
  '.r': 'R',
  '.jl': 'Julia',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.hrl': 'Erlang',
  '.hs': 'Haskell',
  '.lhs': 'Haskell',
  '.pl': 'Perl',
  '.pm': 'Perl',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.ps1': 'PowerShell',
  '.psm1': 'PowerShell',
  '.psd1': 'PowerShell',
  '.sql': 'SQL',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'Sass',
  '.proto': 'Protocol Buffers',
  '.graphql': 'GraphQL',
  '.gql': 'GraphQL',
  '.prisma': 'Prisma',
  '.sol': 'Solidity',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};
const manifestNames = new Set([
  'build.gradle',
  'build.gradle.kts',
  'Cargo.lock',
  'Cargo.toml',
  'CMakeLists.txt',
  'composer.json',
  'composer.lock',
  'Directory.Packages.props',
  'Directory.Build.props',
  'Directory.Build.targets',
  'bun.lock',
  'bun.lockb',
  'cabal.project',
  'cabal.project.freeze',
  'cpanfile',
  'cpanfile.snapshot',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
  'deps.edn',
  'Gemfile',
  'Gemfile.lock',
  'go.sum',
  'go.mod',
  'go.work',
  'global.json',
  'gradle.lockfile',
  'mix.exs',
  'mix.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'Package.swift',
  'Package.resolved',
  'package.json',
  'Pipfile',
  'Pipfile.lock',
  'pom.xml',
  'poetry.lock',
  'Podfile',
  'Podfile.lock',
  'packages.config',
  'packages.lock.json',
  'package.yaml',
  'project.clj',
  'pubspec.lock',
  'pubspec.yaml',
  'pyproject.toml',
  'requirements.txt',
  'requirements-dev.txt',
  'pnpm-lock.yaml',
  'settings.gradle',
  'settings.gradle.kts',
  'renv.lock',
  'stack.yaml',
  'uv.lock',
  'yarn.lock',
  'go.work.sum',
]);

/** Summarizes filename metadata only; it does not parse or read file contents. */
export function summarizeInventory(
  inventory: FileInventory,
  dependencyInventory?: ProjectDependencyInventory
): InventorySummary {
  const counts = new Map<string, number>();
  const manifests = new Set<string>();
  for (const file of inventory.files) {
    const language = extensions[posix.extname(file).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    const base = posix.basename(file);
    if (
      manifestNames.has(base) ||
      /\.(?:csproj|fsproj|vbproj|sln|slnx)$/i.test(base) ||
      /^requirements(?:-[a-z0-9_-]+)?\.txt$/i.test(base)
    ) {
      manifests.add(file);
    }
  }
  const allLimitations = [
    'Language counts are inferred from filenames; counts do not imply parser or build support.',
    'Excluded paths, unsupported extensions and inaccessible directories are not analyzed.',
    'Common credential paths are excluded; other secrets may not be recognized.',
    ...(dependencyInventory?.limitations ?? []),
  ];
  const limitations =
    allLimitations.length > SUMMARY_LIMITATION_BUDGET
      ? [
          ...allLimitations.slice(0, SUMMARY_LIMITATION_BUDGET - 1),
          'Additional inventory limitations are omitted from this summary; dependency details remain listed separately.',
        ]
      : allLimitations;
  return {
    filesDiscovered: inventory.files.length,
    filesParsed: 0,
    skipped: inventory.skipped,
    ...(inventory.skippedEntries
      ? {
          skippedEntries: inventory.skippedEntries,
          skipDetailsTruncated: inventory.skipDetailsTruncated ?? false,
        }
      : {}),
    inventoryComplete: inventory.complete && inventory.errors.length === 0,
    errors: inventory.errors.map((error) => ({ ...error })),
    languages: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, files]) => ({ language, files })),
    manifests: [...manifests].sort(),
    ...(dependencyInventory ? { dependencyInventory } : {}),
    limitations,
  };
}
