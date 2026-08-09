import { normalize, Rejected } from './normalize.js';
import { tableRefs, whereClause, lower } from './statement.js';
import { PolicyViolation, type Policy } from './policy.js';
import type { Adapter, Row, TableShape } from './adapter.js';
import { sameValue as same } from './compare.js';
import { keyOf, keyPredicate, qname } from './keys.js';
import { Refusal } from './refusal.js';

import type { RejectCode } from './normalize.js';
import type { PolicyCode } from './policy.js';

/**
 * Why a plan was refused.
 *
 * One union, and one error type, on purpose. Three layers can refuse a statement
 * — the parser, the policy and the engine — and making a caller catch three
 * different classes to find that out is a way of guaranteeing they catch two.
 */
export type RefusalCode =
  | RejectCode
  | PolicyCode
  | 'NOT_A_WRITE'
  | 'NOT_A_READ'
  | 'NO_PRIMARY_KEY'
  | 'NO_WHERE'
  | 'NESTING_REFUSED'
  | 'AUTO_COLUMNS_UNKNOWN'
  | 'NO_ROWS'
  | 'TOO_MANY_ROWS'
  | 'KEY_NOT_UNIQUE'
  | 'NO_CHANGE'
  | 'ROW_COUNT_MISMATCH'
  | 'ROLLBACK_FAILED'
  | 'NOT_TRANSACTIONAL'
  | 'CASCADE_SIDE_EFFECTS'
  | 'ADAPTER_UNUSABLE';

/** A plan we will not produce. Producing none is always safe; producing a wrong one is not. */
export class PlanRefused extends Refusal {
  declare readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(code, message);
  }
}

export interface PlanRow {
  /** Primary key values identifying this row. */
  readonly key: Row;
  /** Columns that really differ, with auto-maintained ones removed. */
  readonly changed: readonly string[];
  /** For UPDATE, the changed columns only. For DELETE, every column. */
  readonly before: Row;
  /** For UPDATE, the changed columns only. Empty for DELETE. */
  readonly after: Row;
}

export interface Plan {
  readonly sql: string;
  readonly dialect: string;
  readonly table: string;
  readonly op: 'UPDATE' | 'DELETE';
  readonly rows: readonly PlanRow[];
  readonly columnsTouched: readonly string[];
  /** What the database said it matched while we were pretending. */
  readonly rowsMatched: number;
  /**
   * What the database said it really changed, where that is a different number.
   *
   * Kept so the apply can hold the real execution to the same counts as the
   * trial. Comparing against `rows.length` instead would be wrong: a plan may
   * legitimately contain rows whose only difference was a column the database
   * maintains itself, and those are not displayed as changes.
   */
  readonly rowsChanged: number;
  /** False when the dialect cannot distinguish "changed" from "matched" (Postgres). */
  readonly rowsChangedIsMeaningful: boolean;
  /** The business consequence of touching this table. Never empty: see D13. */
  readonly impact: string;
  readonly warnings: readonly string[];
}

export interface ReadResult {
  /** The statement as it was actually run: comments stripped, one statement. */
  readonly sql: string;
  readonly rows: readonly Row[];
  readonly columns: readonly string[];
  /** True when the answer was cut short, so the caller cannot mistake it for all of it. */
  readonly truncated: boolean;
}

export interface EngineOptions {
  readonly adapter: Adapter;
  /**
   * A separate connection for {@link Engine.read}, ideally one the database
   * itself will not let write. Defaults to {@link adapter}.
   *
   * The dry run cannot use it: planning means really executing the statement
   * before rolling it back, so that connection must be able to write. Reading
   * has no such excuse, and reading is the larger surface — it is what an
   * injected instruction reaches first, and exfiltration needs no write at all.
   *
   * This exists because of where the other guards sit. The allowlist and the
   * denied-identifier check run inside this process, holding a credential that
   * can write; they are only as good as this library is correct. A connection
   * the engine refuses to let write is enforced a layer below us, and survives
   * our own bugs. On SQLite that is a read-only handle SQLite enforces itself;
   * elsewhere it is a database role with no write privileges.
   */
  readonly readAdapter?: Adapter;
  readonly policy: Policy;
  readonly limits?: {
    readonly maxUpdateRows?: number;
    readonly maxDeleteRows?: number;
    /** Rows a single read may return before it is reported as truncated. */
    readonly maxReadRows?: number;
    readonly statementMs?: number;
    readonly lockMs?: number;
  };
  /**
   * Columns each table maintains by itself, when the dialect cannot report them.
   *
   * Declared beats detected. On Postgres an `updated_at` maintained by a trigger
   * is invisible in the column definitions, and assuming "none" is not a
   * conservative default — it makes every plan unconfirmable, with an error that
   * reads like a concurrency problem.
   */
  readonly autoColumns?: Readonly<Record<string, readonly string[]>>;
  /**
   * Skip the startup environment check. Only for callers that ran
   * {@link Adapter.selfCheck} themselves; the default is to require it.
   *
   * The guards it performs — is this a real transaction, does "rows affected"
   * mean what we think, is the session ours alone — are not advisory. An earlier
   * version left calling it to the caller, and a caller who forgets gets an
   * engine that makes all its promises and keeps none of them.
   */
  readonly assumeChecked?: boolean;
  /** Test seam: replaces the rollback so the fail-closed path can be exercised. */
  readonly _rollbackHook?: () => Promise<void>;
}

const DEFAULTS = { maxUpdateRows: 200, maxDeleteRows: 50, maxReadRows: 200, statementMs: 5_000, lockMs: 3_000 };

export class Engine {
  readonly adapter: Adapter;
  /** Where reads go. The same object as {@link adapter} unless one was supplied. */
  readonly readAdapter: Adapter;
  /** True when reads and dry runs are the same connection, and so the same privileges. */
  readonly readIsSeparate: boolean;
  private readonly policy: Policy;
  private readonly limits: Required<NonNullable<EngineOptions['limits']>>;
  private readonly declaredAuto: Readonly<Record<string, readonly string[]>>;
  private readonly rollbackHook: (() => Promise<void>) | undefined;
  private checked: boolean;
  /** The read connection is verified separately, because it may be a different connection. */
  private readChecked: boolean;
  /** Set when the connection's state is no longer known. Nothing may run after that. */
  private poisoned: string | undefined;

  constructor(opts: EngineOptions) {
    this.adapter = opts.adapter;
    this.readAdapter = opts.readAdapter ?? opts.adapter;
    this.readIsSeparate = this.readAdapter !== this.adapter;
    this.policy = opts.policy;
    this.limits = { ...DEFAULTS, ...(opts.limits ?? {}) };
    this.declaredAuto = opts.autoColumns ?? {};
    this.rollbackHook = opts._rollbackHook;
    this.checked = opts.assumeChecked ?? false;
    this.readChecked = opts.assumeChecked ?? false;
  }

  /**
   * Produce a plan by actually running the statement, reading the real result,
   * and rolling it back.
   *
   * The alternative — predicting what a statement would do — cannot be made
   * correct. `SET price = price * 1.1` is an expression; triggers fire; defaults
   * apply. Anything short of executing it is a guess, and showing a human a guess
   * labelled as fact is worse than showing them nothing.
   */
  async plan(rawSql: string): Promise<Plan> {
    if (this.poisoned !== undefined) {
      throw new PlanRefused(
        'ADAPTER_UNUSABLE',
        `This connection is no longer in a known state and will not be used again: ${this.poisoned}`,
      );
    }
    if (!this.checked) {
      await this.adapter.selfCheck();
      this.checked = true;
    }

    // The parser and the policy have their own error types; the caller should
    // only have to know one.
    let stmt;
    try {
      stmt = normalize(rawSql, { dialect: this.adapter.dialect });
      this.policy.check(stmt);
    } catch (e) {
      if (e instanceof Rejected || e instanceof PolicyViolation) {
        throw new PlanRefused(e.code, e.message);
      }
      throw e;
    }

    if (stmt.kind !== 'write') {
      throw new PlanRefused('NOT_A_WRITE', 'Only UPDATE and DELETE are planned; reads execute directly.');
    }

    const table = tableRefs(stmt.tokens)[0];
    if (table === undefined) throw new PlanRefused('NOT_A_WRITE', 'No target table.');
    const where = whereClause(stmt.tokens);
    if (where === undefined) {
      throw new PlanRefused('NO_WHERE', 'A write without WHERE would target every row and is refused.');
    }
    const op: 'UPDATE' | 'DELETE' = /^\s*delete\b/i.test(stmt.sql) ? 'DELETE' : 'UPDATE';

    const shape = await this.adapter.introspect(table);
    if (shape.primaryKey.length === 0) {
      throw new PlanRefused(
        'NO_PRIMARY_KEY',
        `Table \`${table}\` has no primary key, so rows cannot be shown to you one by one.`,
      );
    }

    // A dry run on a table that cannot roll back is not a dry run. The storage
    // engine is a per-table property, so the startup probe says nothing about
    // this one; without this check the write lands permanently and is reported
    // as harmless.
    if (!shape.transactional) {
      throw new PlanRefused(
        'NOT_TRANSACTIONAL',
        `Table \`${table}\` is not on a transactional storage engine, so a trial run could not be undone. ` +
          'It would be a permanent change to production.',
      );
    }

    // Rows in other tables that would move as a side effect can never appear on
    // the card, and for DELETE the loss is irreversible. Refuse rather than show
    // a confirmation that understates what it authorises.
    const cascades = shape.inboundCascades.filter((c) => {
      const rule = op === 'DELETE' ? c.onDelete : c.onUpdate;
      return rule === 'CASCADE' || rule === 'SET NULL' || rule === 'SET DEFAULT';
    });
    if (cascades.length > 0) {
      const list = cascades.map((c) => `${c.table} (${c.constraint}: ON ${op} ${op === 'DELETE' ? c.onDelete : c.onUpdate})`);
      throw new PlanRefused(
        'CASCADE_SIDE_EFFECTS',
        `A ${op} on \`${table}\` also changes rows in ${list.join(', ')} through foreign keys. ` +
          'Those rows cannot be shown to you, so this cannot be approved here.',
      );
    }

    const auto = this.resolveAutoColumns(table, shape);

    // D6 — never nest. Measured: on MySQL a rolled-back statement keeps its row
    // locks until the caller's transaction ends. Postgres releases them, but the
    // engine would still have to own the transaction boundary to guarantee the
    // rollback, and taking over someone else's is worse than declining.
    if (this.adapter.inTransaction()) {
      throw new PlanRefused(
        'NESTING_REFUSED',
        'A dry run will not run inside a transaction you already opened: it has to own the transaction ' +
          'it rolls back. Give the engine its own connection.',
      );
    }

    await this.adapter.applyLimits({ statementMs: this.limits.statementMs, lockMs: this.limits.lockMs });

    const q = this.adapter.quoteIdent.bind(this.adapter);
    const pk = shape.primaryKey;
    const cap = op === 'DELETE' ? this.limits.maxDeleteRows : this.limits.maxUpdateRows;

    let before: Row[] = [];
    let after: Row[] = [];
    let matched = 0;
    let changedReported = 0;
    let changedMeaningful = false;

    await this.adapter.begin('repeatable-read');
    // `attempted` is set the moment the statement is handed to the server, not
    // when it comes back. A write that reached the database and then failed on
    // the way home — a reset connection, a client-side timeout — is exactly the
    // moment the rollback most needs proving, and an earlier version skipped
    // verification on every error path.
    let attempted = false;
    let primary: unknown;
    try {
      // D1 — count first, so a heavy statement is not executed just to discover
      // it was too big. D4 — count and snapshot come from the same transaction,
      // so another session's commit cannot appear inside our before/after diff.
      const cnt = await this.adapter.query<Row>(`SELECT COUNT(*) AS c FROM ${qname(q, table)} WHERE ${where}`);
      const total = Number(Object.values(cnt[0] ?? { c: 0 })[0] ?? 0);
      if (total === 0) throw new PlanRefused('NO_ROWS', `No rows in \`${table}\` match that condition.`);
      if (total > cap) {
        throw new PlanRefused(
          'TOO_MANY_ROWS',
          `${total} rows match, above the ${cap}-row ceiling for ${op}. ` +
            'Every row is shown individually for approval, so narrow the condition.',
        );
      }

      before = await this.adapter.query<Row>(`SELECT * FROM ${qname(q, table)} WHERE ${where}`);

      // D5 — a name called "id" is not a guarantee of uniqueness. If the key does
      // not identify rows one-to-one, the human sees fewer rows than will change.
      const keys = new Set(before.map((r) => keyOf(pk, r)));
      if (keys.size !== before.length || before.length !== total) {
        throw new PlanRefused(
          'KEY_NOT_UNIQUE',
          `The primary key of \`${table}\` does not identify these rows uniquely ` +
            `(${total} matched, ${keys.size} distinct keys), so a row-by-row diff would be wrong.`,
        );
      }

      attempted = true;
      const res = await this.adapter.execute(stmt.sql);
      matched = res.rowsMatched;
      changedReported = res.rowsChanged;
      changedMeaningful = res.changedIsMeaningful;

      if (op === 'UPDATE') {
        const { sql: pred, params } = keyPredicate(pk, before, q, this.adapter.dialect);
        after = await this.adapter.query<Row>(`SELECT * FROM ${qname(q, table)} WHERE ${pred}`, params);
      }
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      try {
        await this.undo(before, after, table, pk, q, attempted, op);
      } catch (u) {
        // A failure to undo outranks nothing: if the statement was refused before
        // it ever ran, saying "the trial could not be rolled back" would send an
        // operator looking for damage that does not exist. Report both, and lead
        // with the one that actually happened first.
        if (primary === undefined) throw u;
        if (!attempted) throw primary;
        throw u;
      }
    }

    return this.build(stmt.sql, table, op, pk, before, after, auto, matched, changedReported, changedMeaningful);
  }

  /**
   * Run a SELECT, bounded, through the same policy as a write.
   *
   * Reads matter more than they look like they do. A model that can read a
   * credential has leaked it, and the usual defence — masking the result set by
   * column name — is defeated by `SELECT secret AS x` and never applied to
   * anything but `SELECT *` in the first place. So the check is on the
   * *reference*: to read a column you have to name it, and naming it is what gets
   * caught (R2).
   *
   * Only SELECT and WITH are accepted. `SHOW TABLES` and friends have no table
   * reference for the allowlist to bite on, so allowing them would hand back the
   * shape of the whole schema from a tool whose entire premise is default-deny.
   */
  async read(rawSql: string, opts: { limit?: number } = {}): Promise<ReadResult> {
    if (this.poisoned !== undefined) {
      throw new PlanRefused('ADAPTER_UNUSABLE', `This connection will not be used again: ${this.poisoned}`);
    }
    if (!this.readChecked) {
      // A separate read connection is verified as a read connection. Asking it
      // for the write path's guarantees would refuse the very configuration this
      // setting exists to encourage: a role with no privilege to write.
      await this.readAdapter.selfCheck(this.readIsSeparate ? 'read' : 'full');
      this.readChecked = true;
    }

    let stmt;
    try {
      stmt = normalize(rawSql, { dialect: this.readAdapter.dialect });
      this.policy.check(stmt);
    } catch (e) {
      if (e instanceof Rejected || e instanceof PolicyViolation) throw new PlanRefused(e.code, e.message);
      throw e;
    }
    if (stmt.kind !== 'read') {
      throw new PlanRefused('NOT_A_READ', 'Only SELECT is run directly; a write has to be planned and approved.');
    }
    const lead = lower(stmt.sql.trimStart().split(/\s/, 1)[0] ?? '');
    if (lead !== 'select' && lead !== 'with') {
      throw new PlanRefused(
        'NOT_A_READ',
        `Only SELECT and WITH are allowed here. \`${lead.toUpperCase()}\` names no table for the allowlist to ` +
          'check, so it would report on tables that were never opened up.',
      );
    }

    const limit = Math.max(1, Math.floor(opts.limit ?? this.limits.maxReadRows));
    await this.readAdapter.applyLimits({ statementMs: this.limits.statementMs, lockMs: this.limits.lockMs });

    // R4 — ask for one more row than we will show. Fetching exactly the limit
    // makes "was there more?" unanswerable, and the caller is then told it saw
    // everything. Wrapping rather than appending keeps a LIMIT the statement
    // already had, instead of producing two of them.
    const rows = await this.readAdapter.query<Row>(
      `SELECT * FROM (${stmt.sql}) AS llm_safe_sql_read LIMIT ${limit + 1}`,
    );
    const truncated = rows.length > limit;
    const shown = truncated ? rows.slice(0, limit) : rows;
    return {
      sql: stmt.sql,
      rows: shown,
      columns: Object.keys(shown[0] ?? {}),
      truncated,
    };
  }

  /**
   * D7 — roll back, then prove it. "No exception" is not proof.
   *
   * The proof has to be narrow. An earlier version re-read the rows and reported
   * failure if *anything* differed from the snapshot, which meant any concurrent
   * edit by another session produced "the trial run may have persisted" — an
   * accusation of data corruption caused by ordinary traffic. A false alarm of
   * that kind is not a safe default: it sends someone to restore a backup over a
   * database that was never damaged.
   *
   * So the check asks only one question: does the row still carry *the value this
   * trial wrote*? A third value means somebody else was working, which is their
   * business and not evidence about our rollback.
   */
  private async undo(
    before: Row[],
    after: Row[],
    table: string,
    pk: readonly string[],
    q: (s: string) => string,
    attempted: boolean,
    op: 'UPDATE' | 'DELETE',
  ): Promise<void> {
    let failure: unknown;
    try {
      if (this.rollbackHook) await this.rollbackHook();
      else await this.adapter.rollback();
    } catch (e) {
      failure = e;
    }

    if (failure !== undefined || this.adapter.inTransaction()) {
      // The connection's state is no longer known: it may still hold an open
      // transaction and exclusive locks on production rows. Handing it back to a
      // pool would pass that on to the next caller, so it is retired instead.
      await this.adapter.rollback().catch(() => {});
      this.poisoned = failure === undefined ? 'a transaction stayed open after rollback' : String(failure);
      await this.adapter.close().catch(() => {});
      throw new PlanRefused(
        'ROLLBACK_FAILED',
        attempted
          ? `The trial run could not be confirmed as rolled back, so no plan is offered, and this connection ` +
            `will not be reused. Check the target rows before assuming they are unchanged. Cause: ${String(failure)}`
          : `The transaction could not be closed cleanly. Nothing was written — the statement was refused before ` +
            `it ran — but this connection will not be reused. Cause: ${String(failure)}`,
      );
    }

    if (!attempted || before.length === 0) return;

    const { sql: pred, params } = keyPredicate(pk, before, q, this.adapter.dialect);
    const now = await this.adapter.query<Row>(`SELECT * FROM ${qname(q, table)} WHERE ${pred}`, params);

    if (op === 'DELETE') {
      if (now.length < before.length) {
        this.poisoned = 'a trial DELETE was not undone';
        await this.adapter.close().catch(() => {});
        throw new PlanRefused(
          'ROLLBACK_FAILED',
          `${before.length - now.length} of the ${before.length} rows the trial deleted are still missing after the ` +
            'rollback. Treat them as deleted and restore from a backup.',
        );
      }
      return;
    }

    const byKey = new Map(now.map((r) => [keyOf(pk, r), r]));
    const afterByKey = new Map(after.map((r) => [keyOf(pk, r), r]));
    for (const b of before) {
      const key = keyOf(pk, b);
      const n = byKey.get(key);
      const a = afterByKey.get(key);
      if (n === undefined || a === undefined) continue; // someone else's doing, not ours
      for (const c of Object.keys(b)) {
        const wroteSomething = !same(b[c], a[c]);
        if (!wroteSomething) continue;
        if (same(n[c], a[c])) {
          this.poisoned = 'a trial write was not undone';
          await this.adapter.close().catch(() => {});
          throw new PlanRefused(
            'ROLLBACK_FAILED',
            `Column \`${c}\` still holds the value the trial run wrote, so the rollback did not take effect. ` +
              'No plan is offered and this connection will not be reused.',
          );
        }
      }
    }
  }

  private build(
    sql: string,
    table: string,
    op: 'UPDATE' | 'DELETE',
    pk: readonly string[],
    before: Row[],
    after: Row[],
    auto: ReadonlySet<string>,
    matched: number,
    changedReported: number,
    changedMeaningful: boolean,
  ): Plan {
    const afterByKey = new Map(after.map((r) => [keyOf(pk, r), r]));
    const rows: PlanRow[] = [];
    const touched = new Set<string>();
    let rowsWithAnyDiff = 0;

    for (const b of before) {
      const key: Row = {};
      for (const c of pk) key[c] = b[c];

      if (op === 'DELETE') {
        // D11 — every column, including the ones that are null right now. Dropping
        // them from the display also drops them from the pre-apply comparison, and
        // a value written in between would then be deleted unseen.
        rows.push({ key, changed: Object.keys(b), before: { ...b }, after: {} });
        for (const c of Object.keys(b)) touched.add(c);
        rowsWithAnyDiff++;
        continue;
      }

      const a = afterByKey.get(keyOf(pk, b));
      if (a === undefined) {
        throw new PlanRefused('ROW_COUNT_MISMATCH', 'A row disappeared during the trial run.');
      }
      let anyDiff = false;
      const changed: string[] = [];
      for (const c of Object.keys(b)) {
        if (same(b[c], a[c])) continue;
        anyDiff = true;
        if (auto.has(lower(c))) continue; // D8
        changed.push(c);
        touched.add(c);
      }
      if (anyDiff) rowsWithAnyDiff++;
      const bd: Row = {};
      const ad: Row = {};
      for (const c of changed) {
        bd[c] = b[c];
        ad[c] = a[c];
      }
      rows.push({ key, changed, before: bd, after: ad });
    }

    if (touched.size === 0) {
      throw new PlanRefused(
        'NO_CHANGE',
        'Running this changed nothing: the rows already hold those values. Production is untouched.',
      );
    }

    // D9 — reconcile what the database says it did against what we can show. A
    // mismatch means rows moved that never appeared on the card.
    const expected = changedMeaningful && op === 'UPDATE' ? changedReported : matched;
    const shown = changedMeaningful && op === 'UPDATE' ? rowsWithAnyDiff : before.length;
    if (expected !== shown) {
      throw new PlanRefused(
        'ROW_COUNT_MISMATCH',
        `The database reports ${expected} rows affected but only ${shown} can be shown to you. ` +
          'Rows you would not see may change, so this is refused. Narrow the condition or target rows by key.',
      );
    }

    const impact = this.policy.impactFor(table) ?? '';
    const warnings: string[] = [];
    if (op === 'DELETE') {
      warnings.push('Deleted rows cannot be brought back by this tool. Restoring them means going to a backup.');
    }
    if (auto.size > 0) {
      warnings.push(`The database maintains ${[...auto].join(', ')} by itself; those are not shown as changes.`);
    }
    // Whatever this engine cannot guarantee is said here, on the card, every
    // time — not once in a README the approver has never read.
    warnings.push(...this.adapter.limitations);

    return {
      sql,
      dialect: this.adapter.dialect,
      table,
      op,
      rows,
      columnsTouched: [...touched],
      rowsMatched: matched,
      rowsChanged: changedReported,
      rowsChangedIsMeaningful: changedMeaningful,
      impact,
      warnings,
    };
  }

  /** D8 — declared beats detected, and "unknown" is never silently read as "none". */
  private resolveAutoColumns(table: string, shape: TableShape): ReadonlySet<string> {
    const declared = this.declaredAuto[table] ?? this.declaredAuto[lower(table)];
    if (declared !== undefined) return new Set(declared.map(lower));
    if (shape.autoColumnsKnown) {
      return new Set(shape.columns.filter((c) => c.autoUpdated).map((c) => lower(c.name)));
    }
    throw new PlanRefused(
      'AUTO_COLUMNS_UNKNOWN',
      `Table \`${table}\` has triggers, so this dialect cannot say which columns the database maintains itself. ` +
        'Declare them in autoColumns. Guessing "none" would make every plan fail to confirm, ' +
        'with an error that looks like someone else edited the row.',
    );
  }

}
