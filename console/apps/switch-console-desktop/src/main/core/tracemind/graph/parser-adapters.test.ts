import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { MAX_PARSER_SOURCE_BYTES, parseSource } from './parser-adapters';

describe('TraceMind parser adapters', () => {
  it('accepts supported files through 16 MiB and applies the shared byte limit at its boundary', () => {
    const atLimit = parseSource('src/at-limit.ts', ' '.repeat(MAX_PARSER_SOURCE_BYTES));
    expect(atLimit).toMatchObject({ language: 'TypeScript', symbols: [], references: [] });
    expect(
      parseSource('src/over-limit.ts', `${' '.repeat(MAX_PARSER_SOURCE_BYTES)} `)
    ).toMatchObject({
      language: 'large-file',
      message: 'Source exceeds the 16 MiB parser limit.',
    });
    const largeSupported = parseSource(
      'src/large-supported.ts',
      `${' '.repeat(11 * 1024 * 1024)}export function retainedAboveTenMiB() {}`
    );
    expect(largeSupported).toMatchObject({
      language: 'TypeScript',
      symbols: [expect.objectContaining({ name: 'retainedAboveTenMiB' })],
    });
  });

  it('extracts constructor, tagged-template, and JSX component references explicitly', () => {
    const result = parseSource(
      'src/components.tsx',
      'class Widget {}\nfunction query() {}\nnew Widget();\nquery`select 1`;\nconst view = <Widget><ui.Button /></Widget>;'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'Widget', relation: 'CALLS', certainty: 'heuristic' }),
        expect.objectContaining({ target: 'query', relation: 'CALLS', certainty: 'heuristic' }),
        expect.objectContaining({ target: 'Widget', relation: 'RENDERS', certainty: 'heuristic' }),
        expect.objectContaining({ target: 'Button', relation: 'RENDERS', certainty: 'heuristic' }),
      ])
    );
    expect(result.references.some((reference) => reference.target === 'ui')).toBe(false);
  });

  it('rejects token-dense TypeScript before allocating an unbounded syntax tree', () => {
    expect(parseSource('src/token-dense.ts', ';'.repeat(200_001))).toMatchObject({
      path: 'src/token-dense.ts',
      language: 'TypeScript',
      message: 'Source token limit exceeded.',
    });
  });

  it('preserves Python relative-from and absolute dotted module imports', () => {
    const result = parseSource(
      'src/pkg/use.py',
      'import pkg.mod\nfrom . import helper\nfrom .utils import item\nfrom ..core import base'
    );
    if ('message' in result) throw new Error(result.message);
    expect(
      result.references
        .filter((reference) => reference.relation === 'IMPORTS')
        .map((reference) => reference.target)
    ).toEqual(['pkg.mod', '.helper', '.utils', '..core']);
  });

  it('extracts TypeScript symbols, imports, calls and tests with source locations', () => {
    const result = parseSource(
      'src/a.test.ts',
      "import { x } from './x';\nexport function run() { x(); }\nit('works', () => run());"
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.language).toBe('TypeScript');
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'run',
          kind: 'function',
          source: expect.objectContaining({ path: 'src/a.test.ts', startLine: 2, endLine: 2 }),
        }),
        expect.objectContaining({
          name: 'works',
          kind: 'test',
          source: expect.objectContaining({ path: 'src/a.test.ts', startLine: 3, endLine: 3 }),
        }),
      ])
    );
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: './x', relation: 'IMPORTS' }),
        expect.objectContaining({ target: 'x', relation: 'CALLS' }),
      ])
    );
  });
  it('reports unsupported and invalid sources instead of inventing relationships', () => {
    expect(parseSource('README.md', 'text')).toMatchObject({
      path: 'README.md',
      message: 'No headings or links recognized.',
    });
    expect(parseSource('package.json', '{')).toMatchObject({
      path: 'package.json',
      message: 'Invalid JSON manifest.',
    });
    expect(
      parseSource('package.json', JSON.stringify({ dependencies: 'not-a-dependency-map' }))
    ).toMatchObject({
      path: 'package.json',
      message: 'Invalid JSON manifest.',
    });
  });

  it('extracts Solidity declarations and imports without treating comments or strings as code', () => {
    const result = parseSource(
      'contracts/Module.sol',
      [
        '// contract Fake { function ghost() {} }',
        'import "./Guard.sol";',
        'contract Module {',
        '  string private fake = "function ghost() {}";',
        '  function execute() external { helper(); }',
        '}',
      ].join('\n')
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.language).toBe('Solidity');
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Module', kind: 'class' }),
        expect.objectContaining({ name: 'execute', kind: 'function' }),
      ])
    );
    expect(result.symbols.some((symbol) => symbol.name === 'ghost')).toBe(false);
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: './Guard.sol', relation: 'IMPORTS' }),
        expect.objectContaining({ target: 'helper', relation: 'CALLS', certainty: 'heuristic' }),
      ])
    );
  });

  it('extracts SQL function and foreign-key references outside comments and string literals', () => {
    const result = parseSource(
      'migrations/001.sql',
      [
        '-- REFERENCES fake(id)',
        "SELECT 'REFERENCES ghost(id)';",
        "DO $$ BEGIN RAISE NOTICE 'REFERENCES hidden(id)'; END $$;",
        'CREATE TABLE child (parent_id int REFERENCES parent(id));',
        'CREATE VIEW child_view AS SELECT id FROM child;',
        'CREATE OR REPLACE FUNCTION normalize() RETURNS int AS $$ SELECT 1 $$ LANGUAGE SQL;',
      ].join('\n')
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.language).toBe('SQL');
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'normalize', kind: 'function' })
    );
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'child', kind: 'table' }),
        expect.objectContaining({ name: 'child_view', kind: 'table' }),
      ])
    );
    expect(result.references).toContainEqual(
      expect.objectContaining({
        target: 'parent',
        relation: 'DEPENDS_ON',
        source: expect.objectContaining({ startLine: 4 }),
      })
    );
    expect(
      result.references.some((reference) => ['fake', 'ghost', 'hidden'].includes(reference.target))
    ).toBe(false);
  });

  it('extracts shell functions and explicit source references, YAML uses, CSS and HTML imports', () => {
    const shell = parseSource(
      'scripts/run.sh',
      '# source fake.sh\nrun() { echo ok; }\nsource ./lib.sh'
    );
    if ('message' in shell) throw new Error(shell.message);
    expect(shell.symbols).toContainEqual(
      expect.objectContaining({ name: 'run', kind: 'function' })
    );
    expect(shell.references).toContainEqual(
      expect.objectContaining({ target: './lib.sh', relation: 'IMPORTS', certainty: 'heuristic' })
    );
    const yaml = parseSource(
      '.github/workflows/test.yml',
      'jobs:\n  build:\n    run: |\n      fake: value\n    steps:\n      - uses: actions/checkout@v4 # checkout'
    );
    if ('message' in yaml) throw new Error(yaml.message);
    expect(yaml.references).toContainEqual(
      expect.objectContaining({ target: 'actions/checkout@v4', relation: 'DEPENDS_ON' })
    );
    expect(yaml.symbols.map((symbol) => symbol.name)).toEqual([
      'jobs',
      'build',
      'run',
      'steps',
      'uses',
    ]);
    const css = parseSource(
      'style.css',
      '/*\n@import "./fake.css";\n*/\n@import "./base.css";\n.app { color: red; }'
    );
    if ('message' in css) throw new Error(css.message);
    expect(css.references.map((reference) => reference.target)).toEqual(['./base.css']);
    expect(css.symbols).toContainEqual(expect.objectContaining({ name: '.app', kind: 'selector' }));
    const html = parseSource(
      'index.html',
      '<!-- <script src="fake.js"></script> -->\n<script src="main.js">const example = "<h1>fake</h1>";</script><h1>Hello <em>world</em></h1>'
    );
    if ('message' in html) throw new Error(html.message);
    expect(html.references.map((reference) => reference.target)).toEqual(['main.js']);
    expect(html.symbols).toContainEqual(
      expect.objectContaining({ name: 'Hello world', kind: 'heading' })
    );
    expect(html.symbols.some((symbol) => symbol.name === 'fake')).toBe(false);
    expect(parseSource('broken.css', '.missing {')).toMatchObject({
      language: 'CSS',
      message: 'Invalid CSS syntax.',
    });
  });

  it('parses TypeScript NUL characters inside string literals while rejecting binary Python', () => {
    const result = parseSource('src/nul-template.ts', 'export function key() { return `a\0b`; }');
    if ('message' in result) throw new Error(result.message);
    expect(result.language).toBe('TypeScript');
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'key' }));
    expect(parseSource('src/nul.py', 'value = "a\0b"')).toMatchObject({
      language: 'binary',
      message: 'Binary content is unsupported.',
    });
    expect(parseSource('assets/clip.mp4', 'ftypmp42\0video-data')).toMatchObject({
      language: 'binary',
      message: 'Binary content is unsupported.',
    });
  });

  it('reports extracted references that exceed persisted graph field limits', () => {
    expect(parseSource('src/long.ts', `import './${'x'.repeat(257)}';`)).toMatchObject({
      path: 'src/long.ts',
      language: 'TypeScript',
      message: 'Source contains an extracted name or reference beyond the adapter limit.',
    });
  });
  it('parses Java, C#, Go, Rust, C and C++ declarations with bounded source ranges', () => {
    const fixtures: Array<[string, string, string]> = [
      [
        'src/Example.java',
        'Java',
        'import java.util.List;\nclass Example { public void run() { helper(); } }',
      ],
      ['src/Example.cs', 'C#', 'using System;\nclass Example { public void Run() { Helper(); } }'],
      [
        'src/example.go',
        'Go',
        'package example\nimport (\n"fmt"\n"io"\n)\nfunc Add(a int, b int) int { return a + b }\nfunc Print() { fmt.Println("not-an-import") }',
      ],
      ['src/example.rs', 'Rust', 'use std::fmt;\nfn add(a: i32, b: i32) -> i32 { a + b }'],
      ['src/example.c', 'C', '#include <stdio.h>\nint add(int a, int b) { return a + b; }'],
      [
        'src/example.cpp',
        'C++',
        '#include <vector>\nclass Example { public: int run() { return helper(); } };',
      ],
      ['src/contract.java', 'Java', 'import java.util.List;\ninterface Contract { void run(); }'],
      ['include/contract.h', 'C/C++ header', '#include <stdio.h>\nint run(void);'],
    ];
    for (const [path, language, sourceText] of fixtures) {
      const result = parseSource(path, sourceText);
      if ('message' in result) throw new Error(`${path}: ${result.message}`);
      expect(result.language).toBe(language);
      expect(result.symbols.length).toBeGreaterThan(0);
      expect(
        result.symbols.every((symbol) => symbol.source.startLine <= symbol.source.endLine)
      ).toBe(true);
      expect(result.references.some((reference) => reference.relation === 'IMPORTS')).toBe(true);
      if (language === 'Go') {
        expect(
          result.references
            .filter((reference) => reference.relation === 'IMPORTS')
            .map((reference) => reference.target)
        ).toEqual(['fmt', 'io']);
      }
    }
  });
  it('ignores declarations and calls embedded in comments and strings, and marks name-only calls heuristic', () => {
    const result = parseSource(
      'src/example.go',
      'package example\n// func ghost() { evil() }\nfunc Run() { text := "fake()"; helper() }'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(['Run']);
    expect(result.references.map((reference) => reference.target)).toEqual(['helper']);
    expect(result.references[0]?.certainty).toBe('heuristic');
  });
  it('handles C++ raw strings and Rust lifetimes without inventing calls', () => {
    const cpp = parseSource(
      'src/raw.cpp',
      'int actual() { auto text = R"tag(fake() /* still text */)tag"; return 1; }'
    );
    if ('message' in cpp) throw new Error(cpp.message);
    expect(cpp.symbols.map((symbol) => symbol.name)).toEqual(['actual']);
    expect(cpp.references).toEqual([]);
    const rust = parseSource('src/borrow.rs', "fn borrow<'a>(value: &'a str) -> &'a str { value }");
    if ('message' in rust) throw new Error(rust.message);
    expect(rust.symbols).toContainEqual(
      expect.objectContaining({ name: 'borrow', kind: 'function' })
    );
    expect(rust.references).toEqual([]);
  });

  it('recognizes encoding-prefixed C++ raw strings and keeps their contents opaque', () => {
    const result = parseSource(
      'src/encoded-raw.cpp',
      'int run() { auto text = u8R"tag(fake() " still text )tag"; helper(); return 1; }'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(['run']);
    expect(result.references.map((reference) => reference.target)).toEqual(['helper']);
  });

  it('keeps all supported interpolation and C++ raw-string prefix variants visible', () => {
    for (const prefix of ['f', 'F', 'fr', 'fR', 'Fr', 'FR', 'rf', 'rF', 'Rf', 'RF']) {
      expect(
        parseSource('src/fstring.py', `def run():\n    return ${prefix}"{helper()}"`)
      ).toMatchObject({
        language: 'Python',
        message: expect.stringContaining('f-string expressions are not indexed'),
      });
    }

    for (const prefix of ['$"', '$@"', '@$"']) {
      expect(
        parseSource('src/interpolated.cs', `class C { string text = ${prefix}{Helper()}"; }`)
      ).toMatchObject({
        language: 'C#',
        message: expect.stringContaining('interpolated-string expressions are not indexed'),
      });
    }

    for (const prefix of ['R', 'u8R', 'uR', 'UR', 'LR']) {
      const result = parseSource(
        'src/raw.cpp',
        `int run() { auto text = ${prefix}"tag(fake())tag"; helper(); return 1; }`
      );
      if ('message' in result) throw new Error(result.message);
      expect(result.symbols.map((symbol) => symbol.name)).toEqual(['run']);
      expect(result.references.map((reference) => reference.target)).toEqual(['helper']);
    }
  });

  it('expands nested Rust use trees without treating aliases as imported modules', () => {
    const result = parseSource(
      'src/lib.rs',
      'use std::fmt::{Debug, Display as DisplayTrait};\nuse std::{io, cmp::{Ordering as Order}};\nuse crate::module::{self as current, item};'
    );
    if ('message' in result) throw new Error(result.message);
    expect(
      result.references.map((reference) => ({
        target: reference.target,
        relation: reference.relation,
        certainty: reference.certainty,
        source: {
          path: reference.source.path,
          startLine: reference.source.startLine,
          endLine: reference.source.endLine,
        },
      }))
    ).toEqual([
      {
        target: 'std::fmt::Debug',
        relation: 'IMPORTS',
        certainty: 'direct',
        source: { path: 'src/lib.rs', startLine: 1, endLine: 1 },
      },
      {
        target: 'std::fmt::Display',
        relation: 'IMPORTS',
        certainty: 'direct',
        source: { path: 'src/lib.rs', startLine: 1, endLine: 1 },
      },
      {
        target: 'std::io',
        relation: 'IMPORTS',
        certainty: 'direct',
        source: { path: 'src/lib.rs', startLine: 2, endLine: 2 },
      },
      {
        target: 'std::cmp::Ordering',
        relation: 'IMPORTS',
        certainty: 'direct',
        source: { path: 'src/lib.rs', startLine: 2, endLine: 2 },
      },
      {
        target: 'crate::module',
        relation: 'IMPORTS',
        certainty: 'direct',
        source: { path: 'src/lib.rs', startLine: 3, endLine: 3 },
      },
      {
        target: 'crate::module::item',
        relation: 'IMPORTS',
        certainty: 'direct',
        source: { path: 'src/lib.rs', startLine: 3, endLine: 3 },
      },
    ]);
    expect(parseSource('src/broken.rs', 'use crate::{module} trailing;')).toMatchObject({
      path: 'src/broken.rs',
      language: 'Rust',
      message: 'Unsupported Rust use-tree suffix.',
    });
  });

  it('skips C/C++ macro bodies and marks macro invocation relationships ambiguous', () => {
    const result = parseSource(
      'src/macros.c',
      '#define DECLARE(name) \\\nint fake(void) { ghost(); }\n#define APPLY(x) x\nint real(void) { APPLY(ghost()); return 0; }'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(['real']);
    expect(result.references).toEqual([
      expect.objectContaining({
        target: 'APPLY',
        relation: 'CALLS',
        certainty: 'ambiguous',
        source: expect.objectContaining({ path: 'src/macros.c', startLine: 4, endLine: 4 }),
      }),
      expect.objectContaining({
        target: 'ghost',
        relation: 'CALLS',
        certainty: 'heuristic',
        source: expect.objectContaining({ path: 'src/macros.c', startLine: 4, endLine: 4 }),
      }),
    ]);
  });

  it('marks C++ macro calls ambiguous while preserving their source line', () => {
    const result = parseSource(
      'src/macros.cpp',
      '#define WRAP(x) x\nint run() { WRAP(helper()); }'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols.map((symbol) => symbol.name)).toContain('run');
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'WRAP',
          relation: 'CALLS',
          certainty: 'ambiguous',
          source: expect.objectContaining({ path: 'src/macros.cpp', startLine: 2, endLine: 2 }),
        }),
      ])
    );
  });

  it('ignores Python triple-quoted text and nested Rust block comments', () => {
    const python = parseSource(
      'src/example.py',
      "''' def ghost():\n    hidden() '''\ndef actual():\n    pass\n"
    );
    if ('message' in python) throw new Error(python.message);
    expect(python.symbols.map((symbol) => symbol.name)).toEqual(['actual']);

    const rust = parseSource(
      'src/example.rs',
      '/* outer /* fn ghost() { hidden(); } */ still comment */\nfn actual() {}'
    );
    if ('message' in rust) throw new Error(rust.message);
    expect(rust.symbols.map((symbol) => symbol.name)).toEqual(['actual']);
    expect(rust.references).toEqual([]);
  });
  it('classifies annotated and convention-named test functions separately', () => {
    const go = parseSource(
      'src/example_test.go',
      'package example\nfunc TestAdd(t *testing.T) { Add(1, 2) }'
    );
    if ('message' in go) throw new Error(go.message);
    expect(go.symbols).toContainEqual(expect.objectContaining({ name: 'TestAdd', kind: 'test' }));
    const java = parseSource(
      'src/ExampleTest.java',
      'class ExampleTest { @Test public void testAdd() { add(); } }'
    );
    if ('message' in java) throw new Error(java.message);
    expect(java.symbols).toContainEqual(expect.objectContaining({ name: 'testAdd', kind: 'test' }));
  });

  it('captures Python module imports rather than aliases or imported symbol names', () => {
    const result = parseSource(
      'src/example.py',
      'from ..package.tools import helper\nimport first.module as alias, second\n'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.references.map((reference) => reference.target)).toEqual([
      '..package.tools',
      'first.module',
      'second',
    ]);
    expect(result.references.every((reference) => reference.certainty === 'direct')).toBe(true);
  });

  it('recognizes only the Rust test attribute as a test declaration', () => {
    const result = parseSource(
      'src/lib.rs',
      '#[cfg(test)]\nfn helper() {}\n#[test]\nfn actual_test() {}'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'helper', kind: 'function' })
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'actual_test', kind: 'test' })
    );
  });

  it('uses syntax-aware TypeScript extraction and reports syntax diagnostics', () => {
    const parsed = parseSource(
      'src/syntax.ts',
      '// function ghost() { hidden(); }\nexport function actual() { helper(); }\nconst lambda = () => actual();\nconst text = "phantom()";'
    );
    if ('message' in parsed) throw new Error(parsed.message);
    expect(parsed.symbols.map((symbol) => symbol.name)).toEqual(['actual', 'lambda']);
    expect(parsed.references.map((reference) => reference.target)).toEqual(['helper', 'actual']);
    expect(parseSource('src/broken.ts', 'export function broken( {')).toMatchObject({
      path: 'src/broken.ts',
      language: 'TypeScript',
      message: expect.stringContaining('Parse error'),
    });
  });

  it('preserves exact TypeScript call columns for same-line references and nested callers', () => {
    const result = parseSource(
      'src/inline.mts',
      'function outer(){ function inner(){ helper(); helper(); } helper(); }'
    );
    if ('message' in result) throw new Error(result.message);
    const references = result.references.filter((item) => item.relation === 'CALLS');
    expect(references).toHaveLength(3);
    expect(references.map((item) => item.source.startColumn)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(new Set(references.map((item) => item.source.startColumn)).size).toBe(3);
    expect(references[0]?.source.startColumn).toBeLessThan(references[1]?.source.startColumn ?? 0);
    expect(parseSource('src/module.cts', 'export function ctsEntry() {}')).toMatchObject({
      language: 'TypeScript',
      symbols: [expect.objectContaining({ name: 'ctsEntry' })],
    });
  });

  it('keeps lexical same-line calls when a later declaration has the same name', () => {
    const result = parseSource(
      'src/SameLine.java',
      'class SameLine { SameLine() {} void run() { helper(); } void helper() {} }'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(['SameLine', 'run', 'helper']);
    expect(result.references).toEqual([
      expect.objectContaining({
        target: 'helper',
        relation: 'CALLS',
        source: expect.objectContaining({ startLine: 1 }),
      }),
    ]);
  });

  it('indexes Python imports after an earlier from-import on the same line', () => {
    const result = parseSource(
      'src/mixed-import.py',
      'from first import item; import second.module'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.references.map((reference) => reference.target)).toEqual([
      'first',
      'second.module',
    ]);
  });

  it('indexes TypeScript import types as module dependencies', () => {
    const result = parseSource('src/import-type.ts', "type Config = import('./config').Config;");
    if ('message' in result) throw new Error(result.message);
    expect(result.references).toEqual([
      expect.objectContaining({ target: './config', relation: 'IMPORTS', certainty: 'direct' }),
    ]);
  });

  it('returns deterministic parser output for the same source bytes', () => {
    const source = "import './dep';\nexport function run() { helper(); helper(); }";
    expect(parseSource('src/repeat.ts', source)).toEqual(parseSource('src/repeat.ts', source));
  });

  it('does not mistake Python floor division for a comment or hide later calls', () => {
    const result = parseSource(
      'src/floor.py',
      'def run():\n# column-zero comment inside a suite\n    quotient = 8 // 2; helper()\n'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'run' }));
    expect(result.references.map((item) => item.target)).toEqual(['helper']);
  });

  it('does not turn Python statement keywords into function-call edges', () => {
    const result = parseSource(
      'src/keywords.py',
      'def run():\n    assert (check())\n    with (context()):\n        pass\n'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.references.map((reference) => reference.target)).toEqual(['check', 'context']);
  });

  it('marks interpolated expressions as a visible parser limitation instead of omitting calls', () => {
    expect(parseSource('src/fstring.py', 'def run():\n    return f"{helper()}"')).toMatchObject({
      language: 'Python',
      message: expect.stringContaining('f-string expressions are not indexed'),
    });
    expect(parseSource('src/format.cs', 'class C { string text = $"{Helper()}"; }')).toMatchObject({
      language: 'C#',
      message: expect.stringContaining('interpolated-string expressions are not indexed'),
    });
  });

  it('keeps code after backslashes in Go raw and C# verbatim strings visible', () => {
    const go = parseSource('src/raw.go', 'func Run() { value := `prefix\\`; helper() }');
    if ('message' in go) throw new Error(go.message);
    expect(go.symbols).toContainEqual(expect.objectContaining({ name: 'Run' }));
    expect(go.references.map((item) => item.target)).toEqual(['helper']);

    const csharp = parseSource(
      'src/verbatim.cs',
      'class C { void Run() { var text = @"prefix\\"; Helper(); } }'
    );
    if ('message' in csharp) throw new Error(csharp.message);
    expect(csharp.symbols).toContainEqual(expect.objectContaining({ name: 'Run' }));
    expect(csharp.references.map((item) => item.target)).toContain('Helper');
  });

  it('indexes thousands of Python imports and declarations through the linear line index', () => {
    const count = 2_000;
    const source = [
      ...Array.from({ length: count }, (_, index) => `from module_${index} import item_${index}`),
      ...Array.from({ length: count }, (_, index) => `def function_${index}():\n    pass`),
    ].join('\n');
    const result = parseSource('src/generated.py', source);
    if ('message' in result) throw new Error(result.message);
    expect(result.references).toHaveLength(count);
    expect(result.symbols).toHaveLength(count);
  });

  it('indexes many same-line Python imports without repeated whole-prefix scans', () => {
    const count = 8_000;
    const source = Array.from({ length: count }, (_, index) => `import module_${index}`).join('; ');
    const startedAt = performance.now();
    const result = parseSource('src/same-line-imports.py', source);
    const elapsedMs = performance.now() - startedAt;
    if ('message' in result) throw new Error(result.message);
    expect(result.references).toHaveLength(count);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('handles deeply nested calls without rescanning each remaining token range', () => {
    const depth = 4_000;
    const nested = `${'helper('.repeat(depth)}0${')'.repeat(depth)}`;
    const startedAt = performance.now();
    const result = parseSource(
      'src/nested-calls.java',
      `class Nested { Object run() { return ${nested}; } Object helper(Object value) { return value; } }`
    );
    const elapsedMs = performance.now() - startedAt;
    if ('message' in result) throw new Error(result.message);
    expect(result.references).toHaveLength(depth);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

describe('TraceMind graph document and script adapters', () => {
  it('extracts Markdown headings and links but not fenced examples', () => {
    const result = parseSource(
      'README.md',
      '# Overview\n[Guide](./guide.md)\n```md\n# Fake\n[bad](./bad.md)\n```'
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols).toEqual([
      expect.objectContaining({ name: 'Overview', kind: 'heading' }),
    ]);
    expect(result.references).toEqual([
      expect.objectContaining({
        target: './guide.md',
        relation: 'LINKS_TO',
        certainty: 'heuristic',
      }),
    ]);
  });
  it('extracts JSON configuration keys with exact source lines', () => {
    const result = parseSource('config.json', '{\n  "feature": {"enabled": true}\n}');
    if ('message' in result) throw new Error(result.message);
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'feature',
          kind: 'config',
          source: expect.objectContaining({ startLine: 2 }),
        }),
        expect.objectContaining({
          name: 'enabled',
          kind: 'config',
          source: expect.objectContaining({ startLine: 2 }),
        }),
      ])
    );
    expect(parseSource('config.json', '{oops')).toMatchObject({
      language: 'JSON',
      message: 'Invalid JSON document.',
    });
  });
  it('records shell command spellings without indexing heredoc body as shell', () => {
    const result = parseSource(
      'run.sh',
      "#!/bin/sh\nset -eu\npython3 - <<'PY'\nprint('not_shell')\nPY\ncp a b\n"
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.references.map((entry) => entry.target)).toEqual(['set', 'python3', 'cp']);
    expect(result.references.every((entry) => entry.certainty === 'heuristic')).toBe(true);
  });
});
