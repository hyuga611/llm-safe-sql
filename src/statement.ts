import type { Token } from './lexer.js';

export const lower = (s: string): string => s.toLowerCase();

/** Keywords that end a FROM/JOIN clause, so an alias or column is not read as a table. */
const CLAUSE_END = new Set([
  'where', 'group', 'having', 'order', 'limit', 'offset', 'fetch', 'union', 'except',
  'intersect', 'on', 'using', 'set', 'returning', 'window', 'for', 'into',
]);

/**
 * Keywords that end a WHERE clause. `ORDER`/`LIMIT` are refused on a write before
 * this is ever called; `RETURNING` is not, and is legal on Postgres.
 */
const WHERE_END = new Set(['returning', 'order', 'limit', 'offset', 'fetch', 'for']);

/** Keywords after which the next qualified name is a table. */
const TABLE_LEAD = new Set(['from', 'join', 'update']);

/** Significant tokens only — whitespace and comments carry no meaning here. */
function significant(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
}

/**
 * Table references, in order of appearance, case-folded and de-duplicated.
 *
 * This walks the token stream rather than parsing: names that follow FROM, JOIN or
 * UPDATE are tables, and a clause keyword ends the list so that an alias is not
 * mistaken for one. A sub-select's own FROM is reached by the same walk.
 */
export function tableRefs(tokens: readonly Token[]): string[] {
  const toks = significant(tokens);
  const out: string[] = [];
  const seen = new Set<string>();
  let expect = false;
  let inFrom = false;
  let depth = 0;
  let fromDepth = 0;

  // Keep the author's spelling: it is what a human will recognise in an error
  // message. Comparisons are done case-folded at the call sites.
  const add = (name: string): void => {
    const k = lower(name);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(name);
    }
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;

    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      else if (t.value === ',' && inFrom && depth === fromDepth) expect = true;
      continue;
    }

    // Order matters: when a table name is expected, the next identifier IS the
    // table even if it happens to spell a clause keyword. `UPDATE order SET ...`
    // targets a table called "order"; reading it as the start of ORDER BY loses
    // the target entirely.
    if (!expect && t.kind === 'ident' && TABLE_LEAD.has(lower(t.value))) {
      expect = true;
      inFrom = true;
      fromDepth = depth;
      continue;
    }

    if (!expect && t.kind === 'ident' && CLAUSE_END.has(lower(t.value))) {
      inFrom = false;
      continue;
    }

    if (expect && (t.kind === 'ident' || t.kind === 'quotedIdent')) {
      // Keep the whole qualified name. Reducing `other.orders` to `orders` lets a
      // statement be measured against one table while it writes to another, and
      // lets it pass an allowlist that never mentioned it.
      const parts = [t.value];
      while (
        i + 2 < toks.length &&
        toks[i + 1]?.kind === 'punct' &&
        toks[i + 1]?.value === '.' &&
        (toks[i + 2]?.kind === 'ident' || toks[i + 2]?.kind === 'quotedIdent')
      ) {
        parts.push(toks[i + 2]?.value ?? '');
        i += 2;
      }
      add(parts.join('.'));
      expect = false;
      continue;
    }
  }

  return out;
}

/**
 * Column names on the left of each assignment in an UPDATE ... SET clause.
 *
 * This feeds `denyWriteColumns`, so a column it fails to report is a column that
 * guard does not protect. Two spellings used to escape it, and both were silent —
 * the statement ran, the denied column was written, and nothing refused:
 *
 *   `SET orders.price = 1`      — it took the first identifier after `SET`, so it
 *                                 reported the *table* as the column name. Legal
 *                                 SQL on MySQL and Postgres alike.
 *   `SET (qty, price) = (1, 2)` — Postgres' multi-column form. The comma inside
 *                                 the parentheses was ignored because it was not
 *                                 at depth 0, so only the first column was seen.
 *                                 Putting the denied column anywhere but first
 *                                 was enough.
 *
 * So the shape is parsed properly rather than approximated: a qualified name
 * reduces to its last component, and the parenthesised column list is read as a
 * list. When the left side cannot be understood at all, the name is reported as
 * `undefined` — see {@link setColumnsAreCertain} — because a guard that cannot
 * read a statement must not report that the statement is clean.
 */
export function setColumns(tokens: readonly Token[]): string[] {
  return setTargets(tokens).filter((c): c is string => c !== undefined);
}

/**
 * False when the SET clause contained an assignment whose target could not be
 * identified. The policy treats that as a refusal rather than as an absence.
 */
export function setColumnsAreCertain(tokens: readonly Token[]): boolean {
  return !setTargets(tokens).includes(undefined);
}

function setTargets(tokens: readonly Token[]): (string | undefined)[] {
  const toks = significant(tokens);
  const out: (string | undefined)[] = [];
  let depth = 0;
  let i = 0;

  // Find the top-level SET.
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      continue;
    }
    if (depth === 0 && t.kind === 'ident' && lower(t.value) === 'set') {
      i++;
      break;
    }
  }
  if (i >= toks.length) return out;

  const isName = (t: Token | undefined): boolean => t?.kind === 'ident' || t?.kind === 'quotedIdent';

  /** `db.tbl.col` is a name for `col`. Consumes the whole dotted run. */
  const qualified = (): string | undefined => {
    if (!isName(toks[i])) return undefined;
    let last = toks[i]?.value;
    i++;
    while (toks[i]?.kind === 'punct' && toks[i]?.value === '.') {
      i++;
      if (!isName(toks[i])) return undefined; // `t.` with nothing after it
      last = toks[i]?.value;
      i++;
    }
    return last;
  };

  /** Skip the assigned expression, stopping at the comma that starts the next one. */
  const skipValue = (): void => {
    let d = 0;
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (t === undefined) continue;
      if (t.kind === 'punct') {
        if (t.value === '(') d++;
        else if (t.value === ')') d--;
        else if (t.value === ',' && d === 0) {
          i++;
          return;
        }
        continue;
      }
      // FROM belongs to Postgres' UPDATE ... FROM, which normalize refuses
      // separately; either way the SET clause has ended.
      if (d === 0 && t.kind === 'ident' && SET_END.has(lower(t.value))) {
        i = toks.length;
        return;
      }
    }
  };

  while (i < toks.length) {
    const t = toks[i];
    if (t === undefined) break;
    if (t.kind === 'ident' && SET_END.has(lower(t.value))) break;

    if (t.kind === 'punct' && t.value === '(') {
      // Postgres' `SET (a, b, c) = (...)`: every name in the list is a target.
      i++;
      for (;;) {
        const name = qualified();
        out.push(name);
        const next = toks[i];
        if (next?.kind === 'punct' && next.value === ',') {
          i++;
          continue;
        }
        if (next?.kind === 'punct' && next.value === ')') i++;
        break;
      }
      skipValue();
      continue;
    }

    if (isName(t)) {
      out.push(qualified());
      skipValue();
      continue;
    }

    // Something unexpected on the left of an assignment. Record that a target
    // exists and could not be read, rather than moving on quietly.
    out.push(undefined);
    skipValue();
  }

  return out;
}

/** Words that end the SET clause of an UPDATE. */
const SET_END: ReadonlySet<string> = new Set(['where', 'from', 'returning', 'order', 'limit']);

/**
 * The text of the top-level WHERE clause, or undefined when there is none.
 *
 * The engine needs this to ask "how many rows does this actually match?" without
 * running the write, and to re-ask the same question immediately before applying.
 * Finding it by scanning tokens rather than by regex matters: a `WHERE` inside a
 * string literal or a sub-select is not the clause we mean, and taking the wrong
 * one produces a row count for a different question than the one being approved.
 */
export function whereClause(tokens: readonly Token[]): string | undefined {
  const toks = significant(tokens);
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      continue;
    }
    if (depth === 0 && t.kind === 'ident' && lower(t.value) === 'where') {
      // Stop at a clause that follows the condition rather than belonging to it.
      // `DELETE FROM t WHERE id = 1 RETURNING id` is a perfectly good statement,
      // but the engine reuses this text to ask `SELECT COUNT(*) FROM t WHERE …`,
      // and a RETURNING carried into that produces a syntax error about a word
      // the operator wrote in a place where it was legal.
      const rest: Token[] = [];
      let d = 0;
      for (const x of tokens.slice(tokens.indexOf(t) + 1)) {
        if (x.kind === 'punct') {
          if (x.value === '(') d++;
          else if (x.value === ')') d--;
        }
        if (d === 0 && x.kind === 'ident' && WHERE_END.has(lower(x.value))) break;
        rest.push(x);
      }
      const text = rest.map((x) => x.raw).join('').trim();
      return text === '' ? undefined : text;
    }
  }
  return undefined;
}
