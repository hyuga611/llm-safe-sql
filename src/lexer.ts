/**
 * A small, deliberately boring SQL lexer.
 *
 * It does NOT parse SQL. It only answers three questions correctly:
 *   1. where do string literals and comments begin and end?
 *   2. which words are written as identifiers (so a denylist cannot be dodged)?
 *   3. where are the real statement separators?
 *
 * Everything downstream in this library is built on those three answers, so this
 * file is where the dialect differences live. Getting one of them wrong is not a
 * cosmetic bug: it decides whether a human sees the same SQL the server runs.
 *
 * The reference implementation this was ported from used regular expressions here,
 * and it had two matching failure modes that motivated writing a real lexer:
 *   - `WHERE b='x'-- AND c=0` slipped through its comment check (the `--` was not
 *     preceded by whitespace), so the SQL shown on the confirmation card was not
 *     the SQL the database executed.
 *   - `SET note='Please call the customer'` was rejected, because the word "call"
 *     matched a DDL/permission blocklist *inside a string literal*. False rejects
 *     are not harmless: they pressure the operator into deleting the blocklist.
 */

export type Dialect = 'mysql' | 'postgres' | 'sqlite';

export type TokenKind =
  | 'ident' //        bare word: table, column, keyword
  | 'quotedIdent' //  `x` (MySQL, SQLite), "x" (Postgres, SQLite), [x] (SQLite)
  | 'string' //       '...' , "..." (MySQL), E'...' / $tag$...$tag$ (Postgres)
  | 'number'
  | 'punct'
  | 'comment'
  | 'ws';

export interface Token {
  readonly kind: TokenKind;
  /** Semantic value. For identifiers, the unwrapped name. For strings, the raw body. */
  readonly value: string;
  /** Exact source slice. Concatenating every token's `raw` reproduces the input. */
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

export class SqlLexError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = 'SqlLexError';
    this.position = position;
  }
}

/** $tag$ or $$ — the tag body follows identifier rules. */
const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_-￿][A-Za-z0-9_-￿]*)?\$$/;

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/** Identifier start. Non-ASCII is allowed: both engines accept unquoted Japanese identifiers. */
function isIdentStart(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' || c.charCodeAt(0) > 0x7f;
}

function isIdentPart(c: string, dialect: Dialect): boolean {
  if (isIdentStart(c) || isDigit(c)) return true;
  // MySQL and SQLite allow `$` inside identifiers. In Postgres `$` also may appear
  // inside an identifier, but `$tag$` starts a dollar-quoted string — so we stop
  // before `$` there and let the dollar-quote branch decide. Splitting an
  // identifier is harmless; swallowing the opening of a literal is not.
  return c === '$' && dialect !== 'postgres';
}

/**
 * Tokenise `sql`. Throws {@link SqlLexError} on an unterminated literal or comment:
 * an input we cannot tokenise is an input we must not reason about.
 */
export function lex(sql: string, dialect: Dialect): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number, value?: string): void => {
    const raw = sql.slice(start, end);
    tokens.push({ kind, value: value ?? raw, raw, start, end });
  };

  while (i < n) {
    const c = sql.charAt(i);

    // ---- whitespace ----
    if (isSpace(c)) {
      const start = i;
      while (i < n && isSpace(sql.charAt(i))) i++;
      push('ws', start, i);
      continue;
    }

    // ---- line comment: -- ----
    // MySQL requires the `--` to be followed by whitespace or a control character,
    // so `5--3` is arithmetic there but a comment in Postgres and in SQLite. This
    // one character of difference is why the dialect has to be known before
    // anything else happens.
    if (c === '-' && sql.charAt(i + 1) === '-') {
      const after = sql.charAt(i + 2);
      const isComment =
        dialect !== 'mysql' || after === '' || isSpace(after) || after.charCodeAt(0) < 0x20;
      if (isComment) {
        const start = i;
        while (i < n && sql.charAt(i) !== '\n') i++;
        push('comment', start, i);
        continue;
      }
    }

    // ---- line comment: # (MySQL only; in Postgres `#` is an operator character) ----
    if (c === '#' && dialect === 'mysql') {
      const start = i;
      while (i < n && sql.charAt(i) !== '\n') i++;
      push('comment', start, i);
      continue;
    }

    // ---- block comment (Postgres nests, MySQL does not) ----
    if (c === '/' && sql.charAt(i + 1) === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql.charAt(i) === '*' && sql.charAt(i + 1) === '/') {
          depth--;
          i += 2;
        } else if (dialect === 'postgres' && sql.charAt(i) === '/' && sql.charAt(i + 1) === '*') {
          depth++;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) throw new SqlLexError('unterminated block comment', start);
      push('comment', start, i);
      continue;
    }

    // ---- Postgres dollar-quoted string: $tag$ ... $tag$ ----
    if (c === '$' && dialect === 'postgres') {
      const close = sql.indexOf('$', i + 1);
      if (close !== -1) {
        const tag = sql.slice(i, close + 1); // includes both $
        if (DOLLAR_TAG_RE.test(tag)) {
          const bodyStart = close + 1;
          const endIdx = sql.indexOf(tag, bodyStart);
          if (endIdx === -1) throw new SqlLexError(`unterminated dollar-quoted string ${tag}`, i);
          const start = i;
          i = endIdx + tag.length;
          push('string', start, i, sql.slice(bodyStart, endIdx));
          continue;
        }
      }
      push('punct', i, i + 1);
      i++;
      continue;
    }

    // ---- Postgres E'...' (backslash escapes ARE honoured here) ----
    if ((c === 'E' || c === 'e') && dialect === 'postgres' && sql.charAt(i + 1) === "'") {
      const start = i;
      i++;
      i = scanQuoted(sql, i, "'", true, dialect);
      push('string', start, i, sql.slice(start + 2, i - 1));
      continue;
    }

    // ---- single-quoted string ----
    // Postgres treats backslash literally (standard_conforming_strings=on); MySQL
    // treats it as an escape. Reading this backwards leaks the tail of a literal
    // back into the identifier stream, which is exactly what a denylist must not miss.
    if (c === "'") {
      const start = i;
      i = scanQuoted(sql, i, "'", dialect === 'mysql', dialect);
      push('string', start, i, sql.slice(start + 1, i - 1));
      continue;
    }

    // ---- double quote: identifier in Postgres and SQLite, string in MySQL's default sql_mode ----
    if (c === '"') {
      const start = i;
      i = scanQuoted(sql, i, '"', dialect === 'mysql', dialect);
      const body = sql.slice(start + 1, i - 1);
      if (dialect !== 'mysql') push('quotedIdent', start, i, body.replace(/""/g, '"'));
      else push('string', start, i, body);
      continue;
    }

    // ---- backtick identifier (MySQL, and SQLite for MySQL compatibility) ----
    if (c === '`' && dialect !== 'postgres') {
      const start = i;
      i = scanQuoted(sql, i, '`', false, dialect);
      push('quotedIdent', start, i, sql.slice(start + 1, i - 1).replace(/``/g, '`'));
      continue;
    }

    // ---- SQLite bracket identifier: [x] ----
    // SQLite accepts this for MS-Access compatibility, and it has no escape
    // mechanism: the first `]` ends the name. Omitting it would leave our lexer
    // reading `[users]` as punctuation around a bare word while SQLite reads one
    // identifier — and a denylist that inspects identifiers would then not see it.
    if (c === '[' && dialect === 'sqlite') {
      const start = i;
      const close = sql.indexOf(']', i + 1);
      if (close === -1) throw new SqlLexError('unterminated [ quoted identifier', start);
      i = close + 1;
      push('quotedIdent', start, i, sql.slice(start + 1, close));
      continue;
    }

    // ---- number ----
    if (isDigit(c) || (c === '.' && isDigit(sql.charAt(i + 1)))) {
      const start = i;
      while (i < n && (isDigit(sql.charAt(i)) || sql.charAt(i) === '.')) i++;
      const e = sql.charAt(i);
      if (e === 'e' || e === 'E') {
        let j = i + 1;
        if (sql.charAt(j) === '+' || sql.charAt(j) === '-') j++;
        if (isDigit(sql.charAt(j))) {
          i = j;
          while (i < n && isDigit(sql.charAt(i))) i++;
        }
      }
      push('number', start, i);
      continue;
    }

    // ---- bare identifier ----
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(sql.charAt(i), dialect)) i++;
      push('ident', start, i);
      continue;
    }

    // ---- anything else ----
    push('punct', i, i + 1);
    i++;
  }

  return tokens;
}

/**
 * Scan a quoted run starting at `sql[start]` (the opening quote) and return the
 * index just past the closing quote. A doubled quote always escapes; a backslash
 * escapes only when `backslashEscapes` is true.
 */
function scanQuoted(
  sql: string,
  start: number,
  quote: string,
  backslashEscapes: boolean,
  _dialect: Dialect,
): number {
  const n = sql.length;
  let i = start + 1;
  while (i < n) {
    const c = sql.charAt(i);
    if (backslashEscapes && c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (sql.charAt(i + 1) === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  throw new SqlLexError(`unterminated quoted string (${quote})`, start);
}

/**
 * Remove comments, keeping everything else byte-for-byte. Each comment becomes a
 * single space so neighbouring tokens cannot fuse: an inline block comment between
 * two bare words must leave a separator behind, not weld them into one word.
 *
 * We strip rather than reject so that the SQL a human approves is the SQL the
 * server runs. Rejecting comments sounds safer and is not: it leaves the caller
 * free to hide meaning in a comment that the checker happens not to match.
 */
export function stripComments(sql: string, dialect: Dialect): string {
  const tokens = lex(sql, dialect);
  let out = '';
  for (const t of tokens) out += t.kind === 'comment' ? ' ' : t.raw;
  return out;
}

/**
 * Split into statements on real separators only, after comments are removed.
 * Returns the non-empty statements, so `SELECT 1;` is one statement and
 * `SELECT 1; SELECT 2` is two.
 */
export function splitStatements(sql: string, dialect: Dialect): string[] {
  const stripped = stripComments(sql, dialect);
  const tokens = lex(stripped, dialect);
  const parts: string[] = [];
  let current = '';
  for (const t of tokens) {
    if (t.kind === 'punct' && t.value === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += t.raw;
  }
  parts.push(current);
  return parts.filter((p) => p.trim() !== '');
}

/**
 * Every word written as an identifier, case-folded and de-duplicated.
 *
 * This is what makes a denylist survive contact with an LLM: to read a column you
 * must name it somewhere, so `passwordHash AS x`, `SUBSTRING(passwordHash,1,20)`,
 * `` `AdminUser` `` and a sub-select all surface the same name here. Contents of
 * string literals and comments are deliberately excluded, so a product name
 * containing "AdminUser" does not trip the check.
 */
export function identifiers(sql: string, dialect: Dialect): string[] {
  const seen = new Set<string>();
  for (const t of lex(sql, dialect)) {
    if (t.kind === 'ident' || t.kind === 'quotedIdent') seen.add(t.value.toLowerCase());
  }
  return [...seen];
}
