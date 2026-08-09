import { lex, stripComments, splitStatements, SqlLexError, type Dialect, type Token } from './lexer.js';
import {
  isMultiTableWrite,
  hasJoin,
  hasTopLevelOrderBy,
  hasTopLevelLimit,
  volatileCalls,
  targetAlias,
} from './analyze.js';
import { Refusal } from './refusal.js';

export type { Dialect };

export type StatementKind = 'read' | 'write' | 'ddl';

export type RejectCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'LEX'
  | 'MULTIPLE_STATEMENTS'
  | 'FORBIDDEN'
  | 'FORBIDDEN_DIALECT'
  | 'UNSUPPORTED_INSERT'
  | 'UNSUPPORTED_STATEMENT'
  | 'MULTI_TABLE'
  | 'ORDER_OR_LIMIT'
  | 'VOLATILE'
  | 'ALIASED_TARGET'
  | 'MIXED';

/** A statement we refuse to reason about. Refusing is always safe; guessing is not. */
export class Rejected extends Refusal {
  declare readonly code: RejectCode;
  constructor(code: RejectCode, message: string) {
    super(code, message);
  }
}

export interface NormalizeOptions {
  readonly dialect: Dialect;
  /** Reject anything longer than this before doing any work. Default 20000. */
  readonly maxLength?: number;
  /**
   * Allow DDL. Off by default, and impossible on MySQL at any setting.
   *
   * MySQL commits implicitly on DDL, which destroys the one guarantee this library
   * makes: that a dry run leaves nothing behind. Postgres is transactional for DDL,
   * so there the ban is a policy choice rather than a physical constraint — but it
   * still has to be asked for.
   */
  readonly allowDdl?: boolean;
}

export interface NormalizeResult {
  /** Comments removed, single statement, no trailing semicolon. Show THIS to the human. */
  readonly sql: string;
  /** True when `sql` differs from the input, i.e. the caller must display the normalized form. */
  readonly changed: boolean;
  readonly kind: StatementKind;
  /** Case-folded identifiers, for policy checks upstream. */
  readonly identifiers: readonly string[];
  readonly tokens: readonly Token[];
}

const DDL = new Set(['drop', 'alter', 'truncate', 'create', 'rename']);

/**
 * Words that must never appear as identifiers. Judged on the token stream with
 * literals excluded — matching these against the raw string is what made the
 * reference implementation reject `SET note='Please call the customer'`.
 */
const FORBIDDEN: ReadonlyMap<string, string> = new Map([
  ['grant', 'permission change'],
  ['revoke', 'permission change'],
  ['lock', 'explicit locking'],
  ['unlock', 'explicit locking'],
  ['handler', 'low-level row access'],
  ['prepare', 'dynamic statement execution'],
  ['execute', 'dynamic statement execution'],
  ['deallocate', 'dynamic statement execution'],
  ['call', 'stored procedure invocation'],
  // Transaction control belongs to this library, not to the statement it is given.
  ['commit', 'transaction control'],
  ['rollback', 'transaction control'],
  ['savepoint', 'transaction control'],
  ['begin', 'transaction control'],
  ['transaction', 'transaction control'],
  // Reaching the file system or stalling the server.
  ['outfile', 'writing to a server file'],
  ['dumpfile', 'writing to a server file'],
  ['infile', 'reading a server file'],
  ['load_file', 'reading a server file'],
  ['sleep', 'stalling the server'],
  ['pg_sleep', 'stalling the server'],
  ['benchmark', 'stalling the server'],
  ['get_lock', 'stalling the server'],
  // Reads that write. A sequence is not transactional on PostgreSQL: `nextval`
  // advances it for everybody and a ROLLBACK does not put it back, so a "read"
  // can permanently consume ids the rest of the application expects to issue.
  // `setval` is worse and needs no explanation. These reach the read path, which
  // is the one an injected instruction gets to first.
  ['nextval', 'advancing a sequence, which a rollback does not undo'],
  ['setval', 'moving a sequence'],
  ['pg_read_file', 'reading a server file'],
  ['pg_read_binary_file', 'reading a server file'],
  ['pg_ls_dir', 'listing a server directory'],
  ['lo_import', 'reading a server file'],
  ['lo_export', 'writing to a server file'],
  ['dblink', 'opening a connection to another server'],
  ['dblink_exec', 'opening a connection to another server'],
  // Catalogs: credentials and other tenants live here.
  ['information_schema', 'system catalog'],
  ['performance_schema', 'system catalog'],
  ['pg_catalog', 'system catalog'],
  ['pg_authid', 'system catalog'],
  ['pg_shadow', 'system catalog'],
  ['pg_user', 'system catalog'],
]);

const READ_LEAD = new Set(['select', 'with', 'show', 'explain', 'describe', 'desc', 'table', 'values']);
const WRITE_LEAD = new Set(['update', 'delete']);
const INSERT_LEAD = new Set(['insert', 'replace', 'merge']);
/** Words that mean "this reads and also writes", when they appear inside a read. */
const WRITE_WORDS = new Set(['insert', 'update', 'delete', 'replace', 'merge']);

/**
 * Turn LLM-supplied SQL text into something safe to reason about, or refuse.
 *
 * The returned `sql` is what the human must be shown. The reference implementation
 * displayed the *input* while executing something else, because it rejected
 * comments with a regex that `WHERE b='x'-- AND c=0` walked straight past. Here the
 * comment is removed and the remaining text is both displayed and executed, so the
 * two cannot drift apart.
 */
export function normalize(input: string, opts: NormalizeOptions): NormalizeResult {
  const { dialect, maxLength = 20_000, allowDdl = false } = opts;

  const raw = input.trim();
  if (raw === '') throw new Rejected('EMPTY', 'The statement is empty.');
  if (raw.length > maxLength) {
    throw new Rejected('TOO_LONG', `The statement is longer than ${maxLength} characters.`);
  }

  let statements: string[];
  try {
    statements = splitStatements(raw, dialect);
  } catch (e) {
    if (e instanceof SqlLexError) {
      throw new Rejected('LEX', `The statement could not be read: ${e.message} (at ${e.position}).`);
    }
    throw e;
  }

  if (statements.length === 0) throw new Rejected('EMPTY', 'The statement is empty.');
  if (statements.length > 1) {
    throw new Rejected(
      'MULTIPLE_STATEMENTS',
      `Only one statement is accepted; found ${statements.length}. ` +
        'Comments are removed before counting, so a comment cannot hide a second statement.',
    );
  }

  const sql = (statements[0] ?? '').trim();
  const tokens = lex(sql, dialect);

  // Only bare words can be keywords. A quoted identifier called `update` is a
  // column name and must not be mistaken for a statement.
  const bare = new Set<string>();
  const all = new Set<string>();
  for (const t of tokens) {
    if (t.kind === 'ident') {
      bare.add(t.value.toLowerCase());
      all.add(t.value.toLowerCase());
    } else if (t.kind === 'quotedIdent') {
      all.add(t.value.toLowerCase());
    }
  }

  for (const [word, why] of FORBIDDEN) {
    if (bare.has(word)) {
      throw new Rejected('FORBIDDEN', `\`${word.toUpperCase()}\` is not accepted here (${why}).`);
    }
  }

  const lead = tokens.find((t) => t.kind === 'ident')?.value.toLowerCase() ?? '';

  if (DDL.has(lead)) {
    if (!allowDdl) {
      throw new Rejected(
        'FORBIDDEN',
        `\`${lead.toUpperCase()}\` changes the schema and is not accepted (set allowDdl to opt in, where the dialect permits it).`,
      );
    }
    if (dialect === 'mysql') {
      throw new Rejected(
        'FORBIDDEN_DIALECT',
        `\`${lead.toUpperCase()}\` cannot be allowed on MySQL: DDL commits implicitly, so the dry run could not be rolled back.`,
      );
    }
    return { sql, changed: sql !== raw, kind: 'ddl', identifiers: [...all], tokens };
  }

  if (INSERT_LEAD.has(lead)) {
    throw new Rejected(
      'UNSUPPORTED_INSERT',
      'INSERT is not supported: we cannot show a before and after for a row that did not exist yet.',
    );
  }

  if (WRITE_LEAD.has(lead)) {
    // P1 — one table. Both engines have a multi-table write syntax that looks
    // single-table, and planning the first name shows one table's rows while the
    // statement changes another's.
    if (isMultiTableWrite(tokens)) {
      throw new Rejected(
        'MULTI_TABLE',
        'This statement writes to more than one table. Rows can only be shown for approval one table at a time.',
      );
    }
    if (hasJoin(tokens)) {
      throw new Rejected('MULTI_TABLE', 'A write with a JOIN is not accepted: the affected rows cannot be listed one by one.');
    }
    // P2 — with ORDER BY or LIMIT, which rows are affected stops being determined
    // by the WHERE alone, so the rows measured are not necessarily the rows changed.
    if (hasTopLevelLimit(tokens) || hasTopLevelOrderBy(tokens)) {
      throw new Rejected(
        'ORDER_OR_LIMIT',
        'ORDER BY and LIMIT are not accepted on a write: they make the affected rows depend on more than the condition, ' +
          'so the rows shown to you would not be guaranteed to be the rows changed.',
      );
    }
    const alias = targetAlias(tokens);
    if (alias !== undefined) {
      throw new Rejected(
        'ALIASED_TARGET',
        `The target table is aliased as \`${alias}\`. Write the table name in the condition instead ` +
          `(\`WHERE ${alias}.x = 1\` becomes \`WHERE x = 1\`): the engine measures the rows with a query it ` +
          'builds from your condition, and an alias declared in your statement does not exist in that one.',
      );
    }

    const volatiles = volatileCalls(tokens);
    if (volatiles.length > 0) {
      throw new Rejected(
        'VOLATILE',
        `\`${volatiles[0]?.toUpperCase()}\` changes value between evaluations, so the rows and values you would be ` +
          'shown are not the ones that would be written. Pass a literal value instead.',
      );
    }
    return { sql, changed: sql !== raw, kind: 'write', identifiers: [...all], tokens };
  }

  if (READ_LEAD.has(lead)) {
    for (const w of WRITE_WORDS) {
      if (bare.has(w)) {
        throw new Rejected(
          'MIXED',
          `This looks like a read but contains \`${w.toUpperCase()}\`. ` +
            'A statement that both reads and writes cannot be shown as a before/after diff.',
        );
      }
    }
    return { sql, changed: sql !== raw, kind: 'read', identifiers: [...all], tokens };
  }

  throw new Rejected(
    'UNSUPPORTED_STATEMENT',
    `Statements starting with \`${lead.toUpperCase() || '?'}\` are not accepted.`,
  );
}

export { stripComments };
