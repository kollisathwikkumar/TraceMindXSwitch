/** A token from a bounded, comment/string-aware source scan. */
export interface SourceToken {
  value: string;
  kind: 'identifier' | 'string' | 'punctuation' | 'number';
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface LexicalScanResult {
  tokens: SourceToken[];
  error: string | null;
  /** C/C++ macro uses are kept as ambiguous references at call sites. */
  macroNames?: string[];
}

export type LexicalLanguage = 'python' | 'c' | 'cpp' | 'go' | 'java' | 'csharp' | 'rust';

const maxTokens = 150_000;
const maxStringBytes = 16_384;

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function stringStart(source: string, index: number, language: LexicalLanguage): number {
  if (language === 'cpp') {
    // This helper is called at every source character. Avoid slicing and
    // regex-scanning the remaining file here: a multi-megabyte C++ file would
    // otherwise allocate/scan the same suffix repeatedly.
    let prefixLength = 0;
    if (source[index] === 'u' && source[index + 1] === '8') prefixLength = 2;
    else if (source[index] === 'u' || source[index] === 'U' || source[index] === 'L')
      prefixLength = 1;
    const rawPrefix = index + prefixLength;
    if (source[rawPrefix] === 'R' && source[rawPrefix + 1] === '"') return prefixLength + 1;
  }
  if (
    language === 'csharp' &&
    ((source[index] === '$' && source[index + 1] === '@' && source[index + 2] === '"') ||
      (source[index] === '@' && source[index + 1] === '$' && source[index + 2] === '"'))
  )
    return 2;
  if (language === 'csharp' && source[index] === '@' && source[index + 1] === '"') return 1;
  if ((language === 'csharp' || language === 'rust') && source[index] === '$') return 1;
  if (language === 'rust' && source[index] === 'r') {
    let cursor = index + 1;
    while (source[cursor] === '#') cursor++;
    if (source[cursor] === '"') return cursor - index;
  }
  if (language === 'rust' && source[index] === "'") {
    const close = source[index + 1] === '\\' ? index + 3 : index + 2;
    return source[close] === "'" ? 0 : -1;
  }
  return source[index] === '"' || source[index] === "'" || source[index] === '`' ? 0 : -1;
}

function readString(
  source: string,
  start: number,
  prefixLength: number,
  language: LexicalLanguage
): { end: number; value: string; unterminated: boolean } {
  const quoteIndex = start + prefixLength;
  const quote = source[quoteIndex];
  const triple =
    (quote === '"' || quote === "'") &&
    source[quoteIndex + 1] === quote &&
    source[quoteIndex + 2] === quote;
  const rawRust = language === 'rust' && source[start] === 'r';
  const rawCpp = language === 'cpp' && source[quoteIndex - 1] === 'R' && quote === '"';
  const rawGo = language === 'go' && quote === '`';
  const csharpVerbatim =
    language === 'csharp' &&
    (source[start] === '@' ||
      source.slice(start, start + 2) === '$@' ||
      source.slice(start, start + 2) === '@$');
  const hashes = rawRust ? source.slice(start + 1, quoteIndex) : '';
  if (rawCpp) {
    const open = source.indexOf('(', quoteIndex + 1);
    if (open < 0 || open - quoteIndex > 17)
      return { end: source.length, value: '', unterminated: true };
    const delimiter = source.slice(quoteIndex + 1, open);
    const close = source.indexOf(`)${delimiter}"`, open + 1);
    if (close < 0) return { end: source.length, value: source.slice(open + 1), unterminated: true };
    return {
      end: close + delimiter.length + 2,
      value: source.slice(open + 1, close),
      unterminated: false,
    };
  }
  const delimiter = triple ? source.slice(quoteIndex, quoteIndex + 3) : (quote ?? '"');
  let cursor = quoteIndex + delimiter.length;
  const valueStart = cursor;
  while (cursor < source.length) {
    if (rawRust) {
      const close = `"${hashes}`;
      if (source.startsWith(close, cursor)) {
        return {
          end: cursor + close.length,
          value: source.slice(valueStart, cursor),
          unterminated: false,
        };
      }
    } else if (source.startsWith(delimiter, cursor)) {
      if (csharpVerbatim && delimiter === '"' && source[cursor + 1] === '"') {
        cursor += 2;
        continue;
      }
      return {
        end: cursor + delimiter.length,
        value: source.slice(valueStart, cursor),
        unterminated: false,
      };
    }
    // Backslashes are literal in Go raw strings and C# verbatim strings. Do not
    // skip their closing delimiter, or the scanner can hide all following code.
    if (!rawRust && !rawGo && !csharpVerbatim && source[cursor] === '\\') {
      cursor = Math.min(source.length, cursor + 2);
      continue;
    }
    cursor++;
  }
  return { end: source.length, value: source.slice(valueStart), unterminated: true };
}

/**
 * Tokenizes only syntax needed by the heuristic source adapters. Comments and
 * strings stay opaque (except string literal values used by import statements),
 * preventing declarations/calls in comments and documentation from becoming
 * graph evidence. This is not a language compiler or semantic analyzer.
 */
export function scanSourceTokens(source: string, language: LexicalLanguage): LexicalScanResult {
  const tokens: SourceToken[] = [];
  const macroNames: string[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (end: number): void => {
    while (index < end) {
      if (source[index] === '\n') {
        line++;
        column = 1;
      } else {
        column++;
      }
      index++;
    }
  };
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) {
      advance(index + 1);
      continue;
    }
    if ((language === 'c' || language === 'cpp') && character === '#') {
      const lineStart = source.lastIndexOf('\n', index - 1) + 1;
      if (/^\s*$/.test(source.slice(lineStart, index))) {
        const directive = source
          .slice(index)
          .match(/^#[ \t]*define\b[ \t]+([A-Za-z_][A-Za-z0-9_]*)/);
        if (directive?.[1]) macroNames.push(directive[1]);
        if (/^#[ \t]*define\b/.test(source.slice(index))) {
          // Macro bodies are preprocessing syntax, not declarations or calls in
          // the containing C/C++ source. Skip complete backslash-continued
          // logical lines while still advancing source locations correctly.
          let cursor = index;
          while (cursor < source.length) {
            const newline = source.indexOf('\n', cursor);
            const lineEnd = newline < 0 ? source.length : newline;
            const continued = /\\[ \t\r]*$/.test(source.slice(cursor, lineEnd));
            cursor = newline < 0 ? source.length : newline + 1;
            if (!continued) break;
          }
          advance(cursor);
          continue;
        }
      }
    }
    if (language === 'python' && character === '#') {
      while (index < source.length && source[index] !== '\n') advance(index + 1);
      continue;
    }
    // Python uses `//` for floor division, not comments. Treating it as a
    // comment silently discarded the rest of a valid code line.
    if (language !== 'python' && source.startsWith('//', index)) {
      while (index < source.length && source[index] !== '\n') advance(index + 1);
      continue;
    }
    if (source.startsWith('/*', index)) {
      const startLine = line;
      let cursor = index + 2;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (language === 'rust' && source.startsWith('/*', cursor)) {
          depth++;
          cursor += 2;
        } else if (source.startsWith('*/', cursor)) {
          depth--;
          cursor += 2;
        } else cursor++;
      }
      if (depth > 0) {
        advance(source.length);
        return { tokens, error: `Unterminated block comment at line ${startLine}.` };
      }
      advance(cursor);
      continue;
    }

    // Interpolation expressions are executable code. Until the lexical adapter
    // can tokenize them structurally, fail the file visibly rather than silently
    // dropping their calls from an apparently complete graph.
    if (language === 'python') {
      const first = source[index];
      const second = source[index + 1];
      const third = source[index + 2];
      const firstF = first === 'f' || first === 'F';
      const firstR = first === 'r' || first === 'R';
      const secondR = second === 'r' || second === 'R';
      const secondF = second === 'f' || second === 'F';
      const secondIsQuote = second === '"' || second === "'";
      const thirdIsQuote = third === '"' || third === "'";
      const isFStringPrefix =
        (firstF && (secondIsQuote || (secondR && thirdIsQuote))) ||
        (firstR && secondF && thirdIsQuote);
      if (isFStringPrefix)
        return { tokens, error: `Python f-string expressions are not indexed at line ${line}.` };
    }
    if (
      language === 'csharp' &&
      ((source[index] === '$' && source[index + 1] === '"') ||
        (source[index] === '$' && source[index + 1] === '@' && source[index + 2] === '"') ||
        (source[index] === '@' && source[index + 1] === '$' && source[index + 2] === '"'))
    ) {
      return {
        tokens,
        error: `C# interpolated-string expressions are not indexed at line ${line}.`,
      };
    }

    const prefixLength = stringStart(source, index, language);
    if (prefixLength >= 0) {
      const start = index;
      const startLine = line;
      const startColumn = column;
      const scanned = readString(source, start, prefixLength, language);
      if (Buffer.byteLength(scanned.value, 'utf8') > maxStringBytes) {
        return { tokens, error: `String literal exceeds scan limit at line ${startLine}.` };
      }
      // String literal tokens intentionally expose only their decoded lexical
      // content; parsing escape sequences would incorrectly claim runtime values.
      tokens.push({
        value: scanned.value,
        kind: 'string',
        start,
        end: scanned.end,
        line: startLine,
        column: startColumn,
      });
      if (tokens.length > maxTokens) return { tokens: [], error: 'Source token limit exceeded.' };
      advance(scanned.end);
      if (scanned.unterminated)
        return { tokens, error: `Unterminated string at line ${startLine}.` };
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      const startLine = line;
      const startColumn = column;
      while (index < source.length && isIdentifierPart(source[index]!)) advance(index + 1);
      tokens.push({
        value: source.slice(start, index),
        kind: 'identifier',
        start,
        end: index,
        line: startLine,
        column: startColumn,
      });
      if (tokens.length > maxTokens) return { tokens: [], error: 'Source token limit exceeded.' };
      continue;
    }

    if (/[0-9]/.test(character)) {
      const start = index;
      const startLine = line;
      const startColumn = column;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index]!)) advance(index + 1);
      tokens.push({
        value: source.slice(start, index),
        kind: 'number',
        start,
        end: index,
        line: startLine,
        column: startColumn,
      });
      if (tokens.length > maxTokens) return { tokens: [], error: 'Source token limit exceeded.' };
      continue;
    }

    const start = index;
    const startLine = line;
    const startColumn = column;
    const multi = ['::', '->', '=>', '==', '!=', '>=', '<=', '&&', '||'].find((item) =>
      source.startsWith(item, index)
    );
    const punctuation = multi ?? character;
    advance(index + punctuation.length);
    tokens.push({
      value: punctuation,
      kind: 'punctuation',
      start,
      end: index,
      line: startLine,
      column: startColumn,
    });
    if (tokens.length > maxTokens) return { tokens: [], error: 'Source token limit exceeded.' };
  }
  if (tokens.length > maxTokens) return { tokens: [], error: 'Source token limit exceeded.' };
  return {
    tokens,
    error: null,
    ...(macroNames.length ? { macroNames: [...new Set(macroNames)] } : {}),
  };
}
