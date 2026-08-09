import type { Dialect } from './lexer.js';
import type { Row } from './adapter.js';
import { encodeValue } from './serialize.js';

/**
 * Addressing rows by primary key.
 *
 * Both the dry run and the apply have to say "these exact rows, the ones on the
 * confirmation card" — not "the rows the WHERE clause happens to select right
 * now", which is a different set the moment anybody else commits. Everything here
 * exists to make that distinction precise, and it is shared rather than
 * duplicated because a drift between how the two paths identify a row would be
 * invisible until it mattered.
 */

/**
 * A stable string identity for a row, used to line before/after up by key.
 *
 * The value goes through {@link encodeValue} first, for two reasons. The obvious
 * one: `JSON.stringify` throws outright on a `bigint`, and SQLite hands back
 * every integer as one — MySQL and Postgres both return their 64-bit ids as
 * strings, so nothing here had met a real `bigint` until a third adapter arrived.
 *
 * The quieter one: the same envelope is what the plan is stored with, so a key
 * built from a live row and a key built from a decoded snapshot are built the
 * same way. Two spellings of "the same row" would not be a crash — they would be
 * an apply that reports the row moved when nobody had touched it.
 */
export function keyOf(pk: readonly string[], row: Row): string {
  // U+0000 cannot appear in the JSON encoding of a value, so it is the one
  // separator a key's own text cannot forge: without it, keys ('a','b') and
  // ('a|b') collide and two different rows are treated as one.
  return pk.map((c) => JSON.stringify(encodeValue(row[c] ?? null))).join('\u0000');
}

/** Placeholder syntax differs, and getting it wrong turns into string concatenation. */
export function placeholder(dialect: Dialect, n: number): string {
  return dialect === 'postgres' ? `$${n}` : '?';
}

/**
 * `(k1 = ? AND k2 = ?) OR (...)` over the given rows, as bound parameters.
 *
 * Composite keys are why this is not an `IN (...)` list: `IN` over a tuple is
 * spelled differently on each engine, and a wrong spelling here would silently
 * address a different row set than the one approved.
 */
export function keyPredicate(
  pk: readonly string[],
  rows: readonly Row[],
  q: (s: string) => string,
  dialect: Dialect,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const ors = rows.map((r) => {
    const ands = pk.map((c) => {
      params.push(r[c]);
      return `${q(c)} = ${placeholder(dialect, params.length)}`;
    });
    return `(${ands.join(' AND ')})`;
  });
  return { sql: ors.join(' OR '), params };
}

/**
 * Quote a possibly schema-qualified name, part by part.
 *
 * Quoting the whole string produces one identifier that literally contains a dot;
 * dropping the qualifier points the measurement at a different table from the one
 * the statement writes to. Both have happened.
 */
export function qname(q: (s: string) => string, name: string): string {
  return name.split('.').map(q).join('.');
}
