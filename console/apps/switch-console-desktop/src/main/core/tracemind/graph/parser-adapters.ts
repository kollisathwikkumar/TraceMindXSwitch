import { basename, extname } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import { z } from 'zod';
import { scanSourceTokens, type LexicalLanguage, type SourceToken } from './lexical-source';
import { graphPathSchema, type SourceLocation } from './model';

/** Shared per-file cap used by audit capture and the parser adapter. */
export const MAX_PARSER_SOURCE_BYTES = 16 * 1024 * 1024;
const maxSyntaxTokens = 200_000;

export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'class' | 'test' | 'table' | 'config' | 'selector' | 'heading';
  source: SourceLocation;
}
export interface ParsedReference {
  target: string;
  relation: 'IMPORTS' | 'LINKS_TO' | 'DEPENDS_ON' | 'TESTS' | 'CALLS' | 'RENDERS';
  source: SourceLocation;
  certainty: 'direct' | 'heuristic' | 'ambiguous';
}
export interface ParseResult {
  language: string;
  symbols: ParsedSymbol[];
  references: ParsedReference[];
}
export interface ParserFailure {
  path: string;
  language: string;
  message: string;
}

const packageManifestSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

function source(path: string, line: number): SourceLocation {
  return { path, startLine: line, endLine: line };
}
function sourceNode(path: string, file: ts.SourceFile, node: ts.Node): SourceLocation {
  const start = node.getStart(file);
  const end = Math.max(start, node.getEnd());
  const startPosition = file.getLineAndCharacterOfPosition(start);
  const endPosition = file.getLineAndCharacterOfPosition(end);
  return {
    path,
    startLine: startPosition.line + 1,
    endLine: endPosition.line + 1,
    startColumn: startPosition.character + 1,
    endColumn: endPosition.character + 1,
  };
}
function firstSyntaxDiagnostic(file: ts.SourceFile): ts.Diagnostic | undefined {
  // The compiler API exposes this parser diagnostic array at runtime, though the
  // public SourceFile declaration intentionally omits the internal property.
  type SourceFileWithParserDiagnostics = ts.SourceFile & {
    readonly parseDiagnostics: readonly ts.Diagnostic[];
  };
  return (file as SourceFileWithParserDiagnostics).parseDiagnostics[0];
}
function exceedsSyntaxTokenLimit(content: string, scriptKind: ts.ScriptKind): boolean {
  const languageVariant =
    scriptKind === ts.ScriptKind.TSX || scriptKind === ts.ScriptKind.JSX
      ? ts.LanguageVariant.JSX
      : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, languageVariant, content);
  let count = 0;
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    if (++count > maxSyntaxTokens) return true;
  }
  return false;
}
function unique<T extends { name?: string; target?: string; source: SourceLocation }>(
  items: T[]
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const kind = 'kind' in item ? String(item.kind) : '';
    const relation = 'relation' in item ? String(item.relation) : '';
    const key = [
      kind,
      relation,
      item.name ?? item.target ?? '',
      item.source.path,
      item.source.startLine,
      item.source.startColumn ?? '',
      item.source.endLine,
      item.source.endColumn ?? '',
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractionLimitFailure(
  path: string,
  language: string,
  symbols: readonly ParsedSymbol[],
  references: readonly ParsedReference[]
): ParserFailure | null {
  if (
    symbols.some((symbol) => Buffer.byteLength(symbol.name, 'utf8') > 1024) ||
    references.some((reference) => Buffer.byteLength(reference.target, 'utf8') > 256)
  ) {
    return {
      path,
      language,
      message: 'Source contains an extracted name or reference beyond the adapter limit.',
    };
  }
  return null;
}

const languageByExtension: Readonly<Record<string, { display: string; lexical: LexicalLanguage }>> =
  {
    '.c': { display: 'C', lexical: 'c' },
    '.cc': { display: 'C++', lexical: 'cpp' },
    '.cpp': { display: 'C++', lexical: 'cpp' },
    '.cxx': { display: 'C++', lexical: 'cpp' },
    '.h': { display: 'C/C++ header', lexical: 'cpp' },
    '.hh': { display: 'C++', lexical: 'cpp' },
    '.hpp': { display: 'C++', lexical: 'cpp' },
    '.hxx': { display: 'C++', lexical: 'cpp' },
    '.cs': { display: 'C#', lexical: 'csharp' },
    '.go': { display: 'Go', lexical: 'go' },
    '.java': { display: 'Java', lexical: 'java' },
    '.py': { display: 'Python', lexical: 'python' },
    '.rs': { display: 'Rust', lexical: 'rust' },
    // The C-family lexer keeps comments and quoted strings opaque. Solidity's
    // declarations differ, so parseLexicalSource handles those explicitly.
    '.sol': { display: 'Solidity', lexical: 'cpp' },
  };

const nonCallIdentifiers = new Set([
  'if',
  'else',
  'for',
  'while',
  'switch',
  'catch',
  'finally',
  'return',
  'throw',
  'new',
  'delete',
  'sizeof',
  'typeof',
  'instanceof',
  'await',
  'yield',
  'async',
  'func',
  'fn',
  'def',
  'class',
  'struct',
  'interface',
  'enum',
  'record',
  'trait',
  'union',
  'import',
  'using',
  'from',
  'as',
  'test',
  'it',
  'describe',
]);
const pythonNonCallIdentifiers = new Set(['assert', 'with']);
const shellControlKeywords = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'source',
]);

function locationForTokens(
  path: string,
  tokens: readonly SourceToken[],
  start: number,
  end: number
): SourceLocation {
  const first = tokens[start];
  const last = tokens[end] ?? first;
  return {
    path,
    startLine: first?.line ?? 1,
    endLine: last?.line ?? first?.line ?? 1,
    startColumn: first?.column ?? 1,
    endColumn: last ? last.column + (last.end - last.start) : (first?.column ?? 1),
  };
}

const delimiterPairs = new WeakMap<readonly SourceToken[], ReadonlyMap<number, number>>();

function matchingToken(
  tokens: readonly SourceToken[],
  start: number,
  open: string,
  close: string
): number {
  let pairs = delimiterPairs.get(tokens);
  if (!pairs) {
    const stacks = new Map<string, number[]>([
      ['(', []],
      ['{', []],
      ['[', []],
    ]);
    const closingToOpening = new Map([
      [')', '('],
      ['}', '{'],
      [']', '['],
    ]);
    const indexedPairs = new Map<number, number>();
    for (let index = 0; index < tokens.length; index++) {
      const value = tokens[index]?.value;
      const stack = stacks.get(value ?? '');
      if (stack) {
        stack.push(index);
        continue;
      }
      const opening = closingToOpening.get(value ?? '');
      if (!opening) continue;
      const paired = stacks.get(opening)?.pop();
      if (paired === undefined) continue;
      indexedPairs.set(paired, index);
      indexedPairs.set(index, paired);
    }
    pairs = indexedPairs;
    delimiterPairs.set(tokens, pairs);
  }
  const paired = pairs.get(start);
  return tokens[start]?.value === open && tokens[paired ?? -1]?.value === close ? paired! : -1;
}

function pythonFromImportKeywords(tokens: readonly SourceToken[]): ReadonlySet<number> {
  const result = new Set<number>();
  let statementLine = 0;
  let statementHasFrom = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.line !== statementLine) {
      statementLine = token.line;
      statementHasFrom = false;
    }
    if (token.value === ';') statementHasFrom = false;
    else if (token.value === 'from') statementHasFrom = true;
    else if (token.value === 'import' && statementHasFrom) {
      result.add(index);
      statementHasFrom = false;
    }
  }
  return result;
}

function tokenText(tokens: readonly SourceToken[], start: number, end: number): string {
  return tokens
    .slice(start, end)
    .map((token) => token.value)
    .join('');
}

interface PythonSourceLayout {
  blockEndLine(startLine: number): number;
  lastTokenAtOrBefore(line: number): number;
}

/** Pre-indexes Python lines once so large files with many declarations stay linear. */
function indexPythonSourceLayout(
  content: string,
  tokens: readonly SourceToken[]
): PythonSourceLayout {
  const lines = content.split(/\r?\n/);
  const nonBlank: { line: number; indent: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const value = lines[index] ?? '';
    const trimmed = value.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let indent = 0;
    for (const character of value) {
      if (character === ' ') indent++;
      else if (character === '\t') indent += 8 - (indent % 8);
      else break;
    }
    nonBlank.push({ line: index + 1, indent });
  }

  const nextDedent = new Map<number, number>();
  const stack: { line: number; indent: number }[] = [];
  for (let index = nonBlank.length - 1; index >= 0; index--) {
    const current = nonBlank[index];
    if (!current) continue;
    while (stack.at(-1)?.indent !== undefined && stack.at(-1)!.indent > current.indent) stack.pop();
    const next = stack.at(-1);
    if (next) nextDedent.set(current.line, next.line);
    stack.push(current);
  }

  const lastTokenByLine = new Array<number>(lines.length + 1).fill(-1);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token) lastTokenByLine[token.line] = index;
  }
  const lastTokenAtOrBefore = new Array<number>(lines.length + 1).fill(-1);
  for (let line = 1; line <= lines.length; line++) {
    const lastOnLine = lastTokenByLine[line] ?? -1;
    lastTokenAtOrBefore[line] =
      lastOnLine >= 0 ? lastOnLine : (lastTokenAtOrBefore[line - 1] ?? -1);
  }

  return {
    blockEndLine(startLine) {
      return (nextDedent.get(startLine) ?? lines.length + 1) - 1;
    },
    lastTokenAtOrBefore(line) {
      return lastTokenAtOrBefore[Math.min(lines.length, Math.max(0, line))] ?? -1;
    },
  };
}

function findBodyEnd(tokens: readonly SourceToken[], afterSignature: number): number {
  for (let index = afterSignature; index < Math.min(tokens.length, afterSignature + 160); index++) {
    const value = tokens[index]?.value;
    // Prototypes and abstract/interface methods are declarations even when a
    // body is absent; their bounded signature remains useful static evidence.
    if (value === ';') return index;
    if (value === '{') return matchingToken(tokens, index, '{', '}');
    if (value === '=>') {
      for (let expressionEnd = index + 1; expressionEnd < tokens.length; expressionEnd++) {
        const next = tokens[expressionEnd]?.value;
        if (next === ';' || next === '}')
          return Math.max(index, expressionEnd - (next === '}' ? 1 : 0));
      }
      return tokens.length - 1;
    }
  }
  return -1;
}

function splitRustUseMembers(tokens: readonly SourceToken[]): SourceToken[][] {
  const members: SourceToken[][] = [];
  let start = 0;
  let nested = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.kind !== 'punctuation') continue;
    if (token.value === '{') nested++;
    else if (token.value === '}') nested--;
    else if (token.value === ',' && nested === 0) {
      if (index > start) members.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  if (start < tokens.length) members.push(tokens.slice(start));
  return members;
}

function rustUseTreeTargets(
  tokens: readonly SourceToken[],
  inheritedPrefix: readonly SourceToken[] = [],
  depth = 0
): { targets: string[]; error: string | null } {
  if (depth > 32) return { targets: [], error: 'Rust use-tree nesting exceeds the adapter limit.' };
  const groupStart = tokens.findIndex(
    (token) => token.kind === 'punctuation' && token.value === '{'
  );
  if (groupStart < 0) {
    const alias = tokens.findIndex((token) => token.kind === 'identifier' && token.value === 'as');
    const pathTokens = alias < 0 ? tokens : tokens.slice(0, alias);
    if (pathTokens.length === 1 && pathTokens[0]?.value === 'self' && inheritedPrefix.length > 0) {
      const parentPath = tokenText(inheritedPrefix, 0, inheritedPrefix.length).replace(/::$/, '');
      return parentPath ? { targets: [parentPath], error: null } : { targets: [], error: null };
    }
    const target = tokenText(
      [...inheritedPrefix, ...pathTokens],
      0,
      inheritedPrefix.length + pathTokens.length
    );
    return target ? { targets: [target], error: null } : { targets: [], error: null };
  }

  const groupEnd = matchingToken(tokens, groupStart, '{', '}');
  if (groupEnd < 0) return { targets: [], error: 'Unterminated Rust use tree.' };
  if (tokens.slice(groupEnd + 1).length > 0)
    return { targets: [], error: 'Unsupported Rust use-tree suffix.' };
  const prefix = [...inheritedPrefix, ...tokens.slice(0, groupStart)];
  const targets: string[] = [];
  for (const member of splitRustUseMembers(tokens.slice(groupStart + 1, groupEnd))) {
    const nested = rustUseTreeTargets(member, prefix, depth + 1);
    if (nested.error) return nested;
    targets.push(...nested.targets);
  }
  return { targets, error: null };
}

function parseLexicalSource(
  path: string,
  content: string,
  language: string,
  lexicalLanguage: LexicalLanguage
): ParseResult | ParserFailure {
  const scanned = scanSourceTokens(content, lexicalLanguage);
  if (scanned.error) return { path, language, message: scanned.error };
  const tokens = scanned.tokens;
  const macroNames = new Set(scanned.macroNames ?? []);
  const symbols: ParsedSymbol[] = [];
  const references: ParsedReference[] = [];
  const declarationNames = new Set<number>();
  const classNames = new Set<string>();
  const classKeywords = new Set([
    'class',
    'struct',
    'interface',
    'enum',
    'record',
    'trait',
    'union',
  ]);
  const python = lexicalLanguage === 'python';
  const solidity = language === 'Solidity';
  if (solidity) {
    classKeywords.add('contract');
    classKeywords.add('library');
  }
  const fromImportKeywords = python ? pythonFromImportKeywords(tokens) : new Set<number>();
  const pythonLayout = python ? indexPythonSourceLayout(content, tokens) : null;
  const testFile = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i.test(path) || /_test\.go$/i.test(path);

  const addSymbol = (
    name: string,
    kind: ParsedSymbol['kind'],
    start: number,
    end: number
  ): void => {
    if (!name || Buffer.byteLength(name, 'utf8') > 1024) return;
    symbols.push({ name, kind, source: locationForTokens(path, tokens, start, end) });
  };
  const addImport = (target: string, at: number): void => {
    if (!target || Buffer.byteLength(target, 'utf8') > 256) return;
    references.push({
      target,
      relation: 'IMPORTS',
      source: locationForTokens(path, tokens, at, at),
      certainty: 'direct',
    });
  };

  if (python) {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token) continue;
      if (token.value === 'class' && tokens[index + 1]?.kind === 'identifier') {
        const name = tokens[index + 1]!;
        classNames.add(name.value);
        declarationNames.add(index + 1);
        const endLine = pythonLayout!.blockEndLine(token.line);
        addSymbol(name.value, 'class', index, pythonLayout!.lastTokenAtOrBefore(endLine));
      }
      if (token.value === 'def' && tokens[index + 1]?.kind === 'identifier') {
        const name = tokens[index + 1]!;
        declarationNames.add(index + 1);
        const endLine = pythonLayout!.blockEndLine(token.line);
        const end = pythonLayout!.lastTokenAtOrBefore(endLine);
        const isTest = testFile && /^(?:test_|Test|test$)/.test(name.value);
        addSymbol(name.value, isTest ? 'test' : 'function', index, end);
      }
      if (token.value === 'from') {
        let importKeyword = -1;
        for (let itemIndex = index + 1; itemIndex < tokens.length; itemIndex++) {
          const item = tokens[itemIndex];
          if (!item || item.line !== token.line || item.value === ';' || item.value === 'from')
            break;
          if (item.value === 'import') {
            importKeyword = itemIndex;
            break;
          }
        }
        if (importKeyword > index + 1) {
          const module = tokenText(tokens, index + 1, importKeyword);
          if (/^\.+$/.test(module)) {
            // `from . import helper` can refer to either an attribute or a
            // sibling module. Preserve the candidate and let the bounded file
            // inventory resolve it only when one concrete module is present.
            for (let cursor = importKeyword + 1; cursor < tokens.length;) {
              const item = tokens[cursor];
              if (!item || item.line !== token.line || item.value === ';') break;
              if (item.value === '(' || item.value === ')' || item.value === ',') {
                cursor++;
                continue;
              }
              if (item.kind !== 'identifier') break;
              addImport(`${module}${item.value}`, index);
              cursor++;
              if (tokens[cursor]?.value === 'as') cursor += 2;
              if (tokens[cursor]?.value === ',') cursor++;
            }
          } else addImport(module, index);
        }
      } else if (
        token.value === 'import' &&
        tokens[index + 1]?.kind === 'identifier' &&
        !fromImportKeywords.has(index)
      ) {
        let cursor = index + 1;
        while (cursor < tokens.length && tokens[cursor]?.line === token.line) {
          if (tokens[cursor]?.kind !== 'identifier') break;
          const moduleParts = [tokens[cursor]!.value];
          cursor++;
          while (
            tokens[cursor]?.line === token.line &&
            tokens[cursor]?.value === '.' &&
            tokens[cursor + 1]?.line === token.line &&
            tokens[cursor + 1]?.kind === 'identifier'
          ) {
            moduleParts.push(tokens[cursor + 1]!.value);
            cursor += 2;
          }
          addImport(moduleParts.join('.'), index);
          if (tokens[cursor]?.value === 'as' && tokens[cursor + 1]?.kind === 'identifier')
            cursor += 2;
          if (tokens[cursor]?.value !== ',') break;
          cursor++;
        }
      }
    }
  } else {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token) continue;
      if (classKeywords.has(token.value)) {
        const modifier = tokens[index + 1]?.value;
        const nameIndex =
          ['enum', 'record'].includes(token.value) && ['class', 'struct'].includes(modifier ?? '')
            ? index + 2
            : index + 1;
        if (tokens[nameIndex]?.kind === 'identifier') {
          const name = tokens[nameIndex]!;
          classNames.add(name.value);
          const bodyEnd = findBodyEnd(tokens, nameIndex + 1);
          if (bodyEnd >= 0) addSymbol(name.value, 'class', index, bodyEnd);
          declarationNames.add(nameIndex);
        }
      }

      if (
        lexicalLanguage === 'go' &&
        token.value === 'type' &&
        tokens[index + 1]?.kind === 'identifier' &&
        ['struct', 'interface'].includes(tokens[index + 2]?.value ?? '')
      ) {
        const name = tokens[index + 1]!;
        classNames.add(name.value);
        const bodyEnd = findBodyEnd(tokens, index + 3);
        if (bodyEnd >= 0) addSymbol(name.value, 'class', index, bodyEnd);
        declarationNames.add(index + 1);
      }

      // Go's `func` and Rust's `fn` have unambiguous declaration keywords.
      if (
        (token.value === 'func' ||
          token.value === 'fn' ||
          (solidity && token.value === 'function')) &&
        tokens[index + 1]
      ) {
        let nameIndex = index + 1;
        if (tokens[nameIndex]?.value === '(') {
          const receiverEnd = matchingToken(tokens, nameIndex, '(', ')');
          if (receiverEnd >= 0) nameIndex = receiverEnd + 1;
        }
        if (tokens[nameIndex]?.kind === 'identifier') {
          let openIndex = -1;
          for (
            let candidateIndex = nameIndex + 1;
            candidateIndex < tokens.length && candidateIndex - nameIndex < 32;
            candidateIndex++
          ) {
            if (tokens[candidateIndex]?.value === '(') {
              openIndex = candidateIndex;
              break;
            }
          }
          if (openIndex > nameIndex && openIndex - nameIndex < 32) {
            const closeIndex = matchingToken(tokens, openIndex, '(', ')');
            const endIndex = closeIndex >= 0 ? findBodyEnd(tokens, closeIndex + 1) : -1;
            if (endIndex >= 0) {
              const name = tokens[nameIndex]!;
              declarationNames.add(nameIndex);
              const rustTest =
                lexicalLanguage === 'rust' &&
                index >= 4 &&
                tokens[index - 4]?.value === '#' &&
                tokens[index - 3]?.value === '[' &&
                tokens[index - 2]?.value === 'test' &&
                tokens[index - 1]?.value === ']';
              const goTest =
                lexicalLanguage === 'go' &&
                testFile &&
                /^(?:Test|Benchmark|Example)/.test(name.value);
              const kind = rustTest || goTest ? 'test' : 'function';
              addSymbol(name.value, kind, index, endIndex);
            }
          }
        }
      }

      if (
        (token.value === 'import' || token.value === 'using') &&
        !(solidity && token.value === 'using') &&
        !(
          lexicalLanguage === 'csharp' &&
          token.value === 'using' &&
          tokens[index + 1]?.value === '('
        )
      ) {
        let end = index + 1;
        if (lexicalLanguage === 'go') {
          if (tokens[index + 1]?.value === '(') {
            const close = matchingToken(tokens, index + 1, '(', ')');
            end = close >= 0 ? close : index + 1;
          } else {
            while (end < tokens.length && tokens[end]?.line === token.line && end - index < 100)
              end++;
          }
        } else {
          while (end < tokens.length && tokens[end]?.value !== ';' && end - index < 100) end++;
        }
        const importTokens = tokens.slice(index + 1, end);
        const stringTokens = importTokens.filter((item) => item.kind === 'string');
        if (lexicalLanguage === 'go' && stringTokens.length > 1) {
          for (const stringToken of stringTokens) addImport(stringToken.value, index);
        } else if (stringTokens[0]) addImport(stringTokens[0].value, index);
        else {
          const importOffset =
            (lexicalLanguage === 'java' || lexicalLanguage === 'csharp') &&
            tokens[index + 1]?.value === 'static'
              ? 2
              : 1;
          let equalIndex = -1;
          for (let itemIndex = index + importOffset; itemIndex < end; itemIndex++) {
            if (tokens[itemIndex]?.value === '=') {
              equalIndex = itemIndex;
              break;
            }
          }
          const targetStart = equalIndex >= 0 ? equalIndex + 1 : index + importOffset;
          const target = tokenText(tokens, targetStart, end).replace(/;$/, '');
          if (target && /^[\w.*:]+$/.test(target)) addImport(target, index);
        }
      }

      if (lexicalLanguage === 'rust' && token.value === 'use') {
        let end = index + 1;
        while (end < tokens.length && tokens[end]?.value !== ';' && end - index < 120) end++;
        const expanded = rustUseTreeTargets(tokens.slice(index + 1, end));
        if (expanded.error) return { path, language, message: expanded.error };
        for (const target of expanded.targets) addImport(target, index);
      }

      // C/C++ preprocessor imports use a literal string or angle-bracket path.
      if (
        (lexicalLanguage === 'c' || lexicalLanguage === 'cpp') &&
        token.value === '#' &&
        tokens[index + 1]?.value === 'include'
      ) {
        const target = tokens[index + 2];
        if (target?.kind === 'string') addImport(target.value, index);
        else if (target?.value === '<') {
          let close = -1;
          for (let itemIndex = index + 3; itemIndex < tokens.length; itemIndex++) {
            const item = tokens[itemIndex];
            if (!item || item.line !== token.line) break;
            if (item.value === '>') {
              close = itemIndex;
              break;
            }
          }
          if (close > index + 2) addImport(tokenText(tokens, index + 3, close), index);
        }
      }
    }

    // Conservative method/function declarations for Java, C#, C, and C++.
    for (let index = 1; index + 1 < tokens.length; index++) {
      const name = tokens[index];
      if (
        name?.kind !== 'identifier' ||
        tokens[index + 1]?.value !== '(' ||
        macroNames.has(name.value)
      )
        continue;
      if (declarationNames.has(index) || nonCallIdentifiers.has(name.value)) continue;
      const previous = tokens[index - 1]?.value;
      if (previous === '.' || previous === '=' || previous === 'return' || previous === 'new')
        continue;
      const close = matchingToken(tokens, index + 1, '(', ')');
      if (close < 0) continue;
      const end = findBodyEnd(tokens, close + 1);
      if (end < 0) continue;
      if (
        (lexicalLanguage === 'java' || lexicalLanguage === 'csharp') &&
        classNames.has(name.value)
      ) {
        let hasBody = false;
        for (let cursor = close + 1; cursor <= end && cursor < close + 64; cursor++) {
          if (tokens[cursor]?.value === ';') break;
          if (tokens[cursor]?.value === '{') {
            hasBody = true;
            break;
          }
        }
        if (hasBody) {
          declarationNames.add(index);
          continue;
        }
      }
      // A call inside a control expression is followed by `)`, `,` or another
      // expression token, not directly by a method body. Require a declaration
      // prefix instead of treating brace-adjacent calls as definitions.
      const declarationPrefix =
        (tokens[index - 1]?.kind === 'identifier' && !nonCallIdentifiers.has(previous ?? '')) ||
        ['*', '&', '>', ']', '~', '::'].includes(previous ?? '');
      if (!declarationPrefix) continue;
      declarationNames.add(index);
      const annotationWindow = tokens
        .slice(Math.max(0, index - 12), index)
        .map((item) => item.value);
      const isTest = annotationWindow.some((value) =>
        ['Test', 'Fact', 'Theory', 'TestMethod', 'ParameterizedTest'].includes(value)
      );
      addSymbol(name.value, isTest ? 'test' : 'function', index, end);
    }
  }

  const uniqueSymbols = unique(symbols);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.kind !== 'identifier' || tokens[index + 1]?.value !== '(') continue;
    if (
      declarationNames.has(index) ||
      nonCallIdentifiers.has(token.value) ||
      (python && pythonNonCallIdentifiers.has(token.value))
    )
      continue;
    references.push({
      target: token.value,
      relation: 'CALLS',
      source: locationForTokens(path, tokens, index, index),
      certainty: macroNames.has(token.value) ? 'ambiguous' : 'heuristic',
    });
  }

  const result: ParseResult = {
    language,
    symbols: uniqueSymbols,
    references: unique(references),
  };
  return extractionLimitFailure(path, language, result.symbols, result.references) ?? result;
}

/**
 * Small, graph-bearing adapters for declarative files. These extract only
 * explicit source spellings, not inferred runtime edges or syntax validity.
 * Unsupported constructs remain parser limitations rather than empty success.
 */
function parseDeclarativeSource(
  path: string,
  content: string,
  extension: string
): ParseResult | ParserFailure | null {
  const language =
    extension === '.sql'
      ? 'SQL'
      : extension === '.sh' || extension === '.bash'
        ? 'Shell'
        : extension === '.yml' || extension === '.yaml'
          ? 'YAML'
          : extension === '.html' || extension === '.htm'
            ? 'HTML'
            : extension === '.css'
              ? 'CSS'
              : null;
  if (!language) return null;
  const symbols: ParsedSymbol[] = [];
  const references: ParsedReference[] = [];
  const maxDeclarativeItems = 20_000;
  const tooManyItems = (): ParserFailure => ({
    path,
    language,
    message: 'Graph-bearing declarations exceed the declarative adapter limit.',
  });
  const lines = content.split(/\r?\n/);
  let yamlBlockIndent = -1;
  let shellHereDocument: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? '';
    const line = index + 1;
    if (language === 'Shell') {
      if (shellHereDocument) {
        if (raw.trim() === shellHereDocument) shellHereDocument = null;
        continue;
      }
      if (/^\s*#/.test(raw)) continue;
      const declaration = raw.match(/^\s*(?:function\s+)?([A-Za-z_][\w]*)\s*\(\s*\)\s*\{/);
      if (declaration)
        symbols.push({ name: declaration[1]!, kind: 'function', source: source(path, line) });
      const include = raw.match(/^\s*(?:source|\.)\s+(['"]?)([^'"\s;#]+)\1(?:\s|;|#|$)/);
      if (include)
        references.push({
          target: include[2]!,
          relation: 'IMPORTS',
          source: source(path, line),
          certainty: 'heuristic',
        });
      const command = raw.match(/^\s*([A-Za-z_][\w.-]*)\b(?!\s*=)/);
      if (command && !shellControlKeywords.has(command[1]!) && !declaration) {
        references.push({
          target: command[1]!,
          relation: 'CALLS',
          source: source(path, line),
          certainty: 'heuristic',
        });
      }
      const hereDocument = raw.match(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/);
      if (hereDocument) shellHereDocument = hereDocument[2]!;
    } else if (language === 'YAML') {
      if (/^\s*#/.test(raw)) continue;
      const indent = raw.match(/^\s*/)?.[0].length ?? 0;
      if (yamlBlockIndent >= 0) {
        if (!raw.trim() || indent > yamlBlockIndent) continue;
        yamlBlockIndent = -1;
      }
      const key = raw.match(/^\s*(?:-\s+)?([A-Za-z_][\w.-]*)\s*:/);
      if (key) symbols.push({ name: key[1]!, kind: 'config', source: source(path, line) });
      if (/^\s*(?:-\s+)?[A-Za-z_][\w.-]*\s*:\s*[|>]\d?[-+]?\s*(?:#.*)?$/.test(raw))
        yamlBlockIndent = indent;
      // Workflow `uses:` identifies a declared action or local reusable
      // workflow, not a proven execution or resolved local source file.
      const use = raw.match(/^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)['"]?(?:\s*(?:#.*)?)?$/);
      if (use)
        references.push({
          target: use[1]!,
          relation: 'DEPENDS_ON',
          source: source(path, line),
          certainty: 'heuristic',
        });
    }
    if (symbols.length + references.length > maxDeclarativeItems) return tooManyItems();
  }
  if (language === 'SQL') {
    // Preserve line positions while hiding comments and literal values. A
    // table reference in a quoted string is not schema evidence.
    const masked = content.replace(
      /(\$[A-Za-z_0-9]*\$)[\s\S]*?\1|--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"/g,
      (part) => part.replace(/[^\r\n]/g, ' ')
    );
    const offsets = [0];
    for (let index = 0; index < masked.length; index++)
      if (masked[index] === '\n') offsets.push(index + 1);
    const lineAt = (offset: number): number => {
      let low = 0,
        high = offsets.length;
      while (low + 1 < high) {
        const middle = (low + high) >> 1;
        if (offsets[middle]! <= offset) low = middle;
        else high = middle;
      }
      return low + 1;
    };
    for (const match of masked.matchAll(
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)/gi
    )) {
      symbols.push({ name: match[1]!, kind: 'table', source: source(path, lineAt(match.index)) });
      if (symbols.length + references.length > maxDeclarativeItems) return tooManyItems();
    }
    for (const match of masked.matchAll(
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([A-Za-z_][\w.]*)/gi
    )) {
      symbols.push({
        name: match[1]!,
        kind: 'function',
        source: source(path, lineAt(match.index)),
      });
      if (symbols.length + references.length > maxDeclarativeItems) return tooManyItems();
    }
    for (const match of masked.matchAll(/\bREFERENCES\s+([A-Za-z_][\w.]*)/gi)) {
      references.push({
        target: match[1]!,
        relation: 'DEPENDS_ON',
        source: source(path, lineAt(match.index)),
        certainty: 'direct',
      });
      if (symbols.length + references.length > maxDeclarativeItems) return tooManyItems();
    }
  }
  if (language === 'CSS') {
    try {
      const sheet = postcss.parse(content, { from: undefined });
      sheet.walkRules((rule) => {
        symbols.push({
          name: rule.selector,
          kind: 'selector',
          source: source(path, rule.source?.start?.line ?? 1),
        });
      });
      sheet.walkAtRules('import', (rule) => {
        const dependency = rule.params.match(/^\s*(?:url\(\s*)?['"]([^'"]+)['"]/);
        if (dependency)
          references.push({
            target: dependency[1]!,
            relation: 'IMPORTS',
            source: source(path, rule.source?.start?.line ?? 1),
            certainty: 'direct',
          });
      });
      if (symbols.length + references.length > maxDeclarativeItems) return tooManyItems();
    } catch {
      return { path, language, message: 'Invalid CSS syntax.' };
    }
  }
  if (language === 'HTML') {
    const withoutComments = content.replace(/<!--[\s\S]*?-->/g, (part) =>
      part.replace(/[^\r\n]/g, ' ')
    );
    const headingsSource = withoutComments.replace(
      /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      (part) => part.replace(/[^\r\n]/g, ' ')
    );
    const offsets = [0];
    for (let index = 0; index < withoutComments.length; index++)
      if (withoutComments[index] === '\n') offsets.push(index + 1);
    for (const match of headingsSource.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
      const heading = match[2]!.replace(/<[^>]+>/g, '').trim();
      if (!heading) continue;
      let low = 0,
        high = offsets.length;
      while (low + 1 < high) {
        const middle = (low + high) >> 1;
        if (offsets[middle]! <= match.index) low = middle;
        else high = middle;
      }
      symbols.push({ name: heading, kind: 'heading', source: source(path, low + 1) });
      if (symbols.length + references.length > maxDeclarativeItems) return tooManyItems();
    }
    for (const match of withoutComments.matchAll(
      /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*(['"])([^'"<>]+)\1[^>]*>/gi
    )) {
      let low = 0,
        high = offsets.length;
      while (low + 1 < high) {
        const middle = (low + high) >> 1;
        if (offsets[middle]! <= match.index) low = middle;
        else high = middle;
      }
      references.push({
        target: match[2]!,
        relation: 'IMPORTS',
        source: source(path, low + 1),
        certainty: 'heuristic',
      });
      if (symbols.length + references.length > maxDeclarativeItems) return tooManyItems();
    }
  }
  const result = { language, symbols: unique(symbols), references: unique(references) };
  if (!result.symbols.length && !result.references.length)
    return {
      path,
      language,
      message: 'No graph-bearing declarations or references recognized by this adapter.',
    };
  return extractionLimitFailure(path, language, result.symbols, result.references) ?? result;
}

/** Syntax-aware TypeScript/JavaScript plus bounded lexical language and manifest adapters. */
export function parseSource(pathValue: string, content: string): ParseResult | ParserFailure {
  const path = graphPathSchema.parse(pathValue);
  const extension = extname(path).toLowerCase();
  const syntaxExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  // JavaScript/TypeScript permits literal NUL code points inside quoted and
  // template strings. Let the syntax parser distinguish those from invalid
  // source bytes instead of classifying the entire file as binary.
  if (content.includes('\0') && !syntaxExtensions.includes(extension))
    return { path, language: 'binary', message: 'Binary content is unsupported.' };
  if (Buffer.byteLength(content, 'utf8') > MAX_PARSER_SOURCE_BYTES)
    return { path, language: 'large-file', message: 'Source exceeds the 16 MiB parser limit.' };
  if (syntaxExtensions.includes(extension)) {
    const language = extension.includes('t') ? 'TypeScript' : 'JavaScript';
    const scriptKind = extension.endsWith('tsx')
      ? ts.ScriptKind.TSX
      : extension.endsWith('jsx')
        ? ts.ScriptKind.JSX
        : ['.js', '.mjs', '.cjs'].includes(extension)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    if (exceedsSyntaxTokenLimit(content, scriptKind))
      return { path, language, message: 'Source token limit exceeded.' };
    const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);
    const diagnostic = firstSyntaxDiagnostic(file);
    if (diagnostic) {
      return {
        path,
        language,
        message: `Parse error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      };
    }
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const addReference = (
      target: string,
      relation: ParsedReference['relation'],
      node: ts.Node,
      certainty: ParsedReference['certainty']
    ): void => {
      references.push({ target, relation, source: sourceNode(path, file, node), certainty });
    };
    const referenceName = (expression: ts.Expression): string | null =>
      ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : null;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        symbols.push({
          name: node.name.text,
          kind: 'function',
          source: sourceNode(path, file, node),
        });
      } else if (ts.isClassDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: 'class', source: sourceNode(path, file, node) });
      } else if (ts.isMethodDeclaration(node)) {
        symbols.push({
          name: node.name.getText(file),
          kind: 'function',
          source: sourceNode(path, file, node),
        });
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        symbols.push({
          name: node.name.text,
          kind: 'function',
          source: sourceNode(path, file, node),
        });
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        addReference(node.argument.literal.text, 'IMPORTS', node, 'direct');
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        addReference(node.moduleSpecifier.text, 'IMPORTS', node, 'direct');
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = referenceName(expression);
        const firstArgument = node.arguments[0];
        if (
          name &&
          ['it', 'test', 'describe'].includes(name) &&
          firstArgument &&
          ts.isStringLiteralLike(firstArgument)
        ) {
          symbols.push({
            name: firstArgument.text,
            kind: 'test',
            source: sourceNode(path, file, node),
          });
        } else if (
          (name === 'require' || expression.kind === ts.SyntaxKind.ImportKeyword) &&
          firstArgument &&
          ts.isStringLiteralLike(firstArgument)
        ) {
          addReference(firstArgument.text, 'IMPORTS', node, 'direct');
        } else if (name && !['it', 'test', 'describe'].includes(name)) {
          addReference(name, 'CALLS', node, 'heuristic');
        }
      }
      if (ts.isNewExpression(node)) {
        const name = referenceName(node.expression);
        if (name) addReference(name, 'CALLS', node, 'heuristic');
      }
      if (ts.isTaggedTemplateExpression(node)) {
        const name = referenceName(node.tag);
        if (name) addReference(name, 'CALLS', node, 'heuristic');
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName;
        const name = ts.isIdentifier(tagName)
          ? tagName.text
          : ts.isPropertyAccessExpression(tagName)
            ? tagName.name.text
            : null;
        // Lowercase intrinsic tags are markup, not local component references.
        if (name && /^[A-Z]/.test(name)) addReference(name, 'RENDERS', node, 'heuristic');
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    const extractedSymbols = unique(symbols);
    const extractedReferences = unique(references);
    return (
      extractionLimitFailure(path, language, extractedSymbols, extractedReferences) ?? {
        language,
        symbols: extractedSymbols,
        references: extractedReferences,
      }
    );
  }
  const lexical = languageByExtension[extension];
  if (lexical) return parseLexicalSource(path, content, lexical.display, lexical.lexical);
  const declarative = parseDeclarativeSource(path, content, extension);
  if (declarative) return declarative;
  if (basename(path) === 'package.json') {
    try {
      const manifest = packageManifestSchema.parse(JSON.parse(content));
      const dependencies = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ];
      const references = unique(
        dependencies.map((target) => ({
          target,
          relation: 'DEPENDS_ON' as const,
          source: source(path, 1),
          certainty: 'direct' as const,
        }))
      );
      return (
        extractionLimitFailure(path, 'JSON', [], references) ?? {
          language: 'JSON',
          symbols: [],
          references,
        }
      );
    } catch {
      return { path, language: 'JSON', message: 'Invalid JSON manifest.' };
    }
  }
  if (extension === '.json') {
    try {
      JSON.parse(content);
      const file = ts.parseJsonText(path, content);
      const symbols: ParsedSymbol[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node)) {
          const name = ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(file);
          symbols.push({ name, kind: 'config', source: sourceNode(path, file, node.name) });
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (symbols.length > 20_000)
        return {
          path,
          language: 'JSON',
          message: 'Graph-bearing declarations exceed the declarative adapter limit.',
        };
      if (!symbols.length)
        return {
          path,
          language: 'JSON',
          message: 'No graph-bearing configuration keys recognized.',
        };
      return (
        extractionLimitFailure(path, 'JSON', symbols, []) ?? {
          language: 'JSON',
          symbols: unique(symbols),
          references: [],
        }
      );
    } catch {
      return { path, language: 'JSON', message: 'Invalid JSON document.' };
    }
  }
  if (extension === '.md' || extension === '.markdown') {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let fence: string | null = null;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1]![0]!;
        else if (marker[1]![0] === fence) fence = null;
        continue;
      }
      if (fence) continue;
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading)
        symbols.push({ name: heading[1]!, kind: 'heading', source: source(path, index + 1) });
      for (const match of line.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
        references.push({
          target: match[1]!,
          relation: 'LINKS_TO',
          source: source(path, index + 1),
          certainty: 'heuristic',
        });
      }
      if (symbols.length + references.length > 20_000)
        return {
          path,
          language: 'Markdown',
          message: 'Graph-bearing declarations exceed the declarative adapter limit.',
        };
    }
    if (!symbols.length && !references.length)
      return { path, language: 'Markdown', message: 'No headings or links recognized.' };
    return (
      extractionLimitFailure(path, 'Markdown', symbols, references) ?? {
        language: 'Markdown',
        symbols: unique(symbols),
        references: unique(references),
      }
    );
  }
  return { path, language: extension || 'plain-text', message: 'No parser adapter is available.' };
}
