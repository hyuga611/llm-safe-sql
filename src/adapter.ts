import type { Dialect } from './lexer.js';

/**
 * The environment cannot support the guarantees this library makes.
 *
 * It lives here, in the module that has no driver imports, rather than beside
 * any one adapter. It used to be defined in the MySQL adapter and imported by
 * the others — which quietly meant that loading the **Postgres** adapter loaded
 * `mysql2`, so a Postgres-only installation could not connect at all. The error
 * it produced named the wrong package (`The pg driver is not installed`, with
 * `pg` installed), sending the reader to reinstall something that was already
 * there. A shared error type is not worth an import edge between two adapters
 * that must never load together.
 */
export class AdapterUnusable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnusable';
  }
}

/**
 * What llm-safe-sql needs from a database driver.
 *
 * Everything here exists because the engine's central claim — "we really ran your
 * statement, measured the real diff, and really rolled it back" — is only true if
 * four environmental assumptions hold. The implementation this was ported from
 * relied on all four and checked none of them, so on a different host it would
 * have kept making the claim while it had stopped being true.
 *
 * The four:
 *   1. writes happen inside a transaction that the engine controls  (E1, A1)
 *   2. "rows affected" means rows *changed*, not rows *matched*      (E2)
 *   3. statements and locks are bounded in time                      (E3)
 *   4. nested dry runs cannot disturb an outer transaction           (E4)
 *
 * An adapter that cannot guarantee one of these must fail {@link selfCheck}
 * rather than degrade quietly. Refusing to start is a bug report; running with a
 * broken guarantee is a data-loss incident nobody notices.
 */
export interface Adapter {
  readonly dialect: Dialect;

  /**
   * Guarantees this adapter cannot make, phrased for the person approving a plan.
   *
   * Empty for an engine that can honour all four assumptions above. When it is
   * not empty the engine copies these onto every confirmation card, because the
   * alternative is the failure this file was written to prevent: a limit that is
   * documented, silently unenforced, and therefore believed. The reference
   * implementation set a statement timeout with a MySQL optimizer hint that
   * Postgres parsed as a comment — nothing warned anybody, and the limit simply
   * did not exist there for a year.
   *
   * Say what is not enforced and what the reader should do instead. Do not put
   * anything here that could be enforced with more work; fix it instead.
   */
  readonly limitations: readonly string[];

  /**
   * Verify the environment before anything is allowed to run, and throw if the
   * engine's guarantees cannot hold here.
   *
   * At minimum an implementation must establish:
   *
   * - **Rows-changed semantics.** Every reconciliation in this library compares
   *   what the database says it touched against what we could show the human.
   *   MySQL clients can be configured (`CLIENT_FOUND_ROWS`) to report rows
   *   *matched* instead, which silently inverts that comparison: an UPDATE that
   *   changes nothing then looks like it changed everything. Probe it, do not
   *   assume it.
   *
   * - **A real transaction.** Non-transactional storage engines accept a
   *   ROLLBACK and return success while changing nothing back. A dry run there
   *   is not a dry run; it is an unannounced write to production.
   *
   * - **No connection sharing that outlives a statement.** Persistent
   *   connections and transaction-pooling proxies (pgbouncer in `transaction`
   *   mode) can hand a session carrying an open dry-run transaction to the next
   *   user. The reference implementation was safe from this only because its
   *   runtime happened to close connections at process exit — an accident, not a
   *   design.
   */
  selfCheck(mode?: SelfCheckMode): Promise<void>;

  /**
   * Can this connection actually write? Probed, not assumed, and harmlessly.
   *
   * `check` uses it to tell an operator whether a connection they configured as
   * the read path is really constrained, because "I pointed readConnection at a
   * different role" and "that role cannot write" are separate facts and only the
   * second one is a boundary. Implementations must leave nothing behind.
   */
  probeWritable(): Promise<boolean>;

  /**
   * Bound this session in time, for the dry run *and* for the real apply.
   *
   * The reference implementation set its timeout with a MySQL optimizer hint,
   * which other engines parse as a comment and ignore — so on Postgres the limit
   * silently did not exist. Worse, even on MySQL the hint only applies to
   * read-only SELECTs, so it never once constrained the UPDATE it was there to
   * constrain. An unindexed WHERE could therefore take an exclusive lock on a
   * production table for as long as it liked, from a single click.
   *
   * Use real session settings: `max_execution_time` + `innodb_lock_wait_timeout`
   * on MySQL, `statement_timeout` + `lock_timeout` on Postgres.
   */
  applyLimits(limits: { statementMs: number; lockMs: number }): Promise<void>;

  /** Column metadata for a table, used to build the before/after diff. */
  introspect(table: string): Promise<TableShape>;

  /**
   * Open a transaction, optionally at a stronger isolation level.
   *
   * The dry run needs the count and the snapshot to come from one consistent
   * view. MySQL's default REPEATABLE READ gives that; PostgreSQL's default READ
   * COMMITTED does not, so a concurrent commit can land between them and be
   * displayed as an effect of the statement being planned.
   */
  begin(isolation?: 'default' | 'repeatable-read'): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  inTransaction(): boolean;

  /**
   * Open a nested scope and return a handle that undoes exactly it.
   *
   * Names must be unique per call. A fixed name (the reference implementation
   * used one) means a second dry run inside the same transaction silently
   * redefines the first one's savepoint, quietly changing how far a rollback
   * goes.
   *
   * Callers must also know what a savepoint rollback does *not* undo, because the
   * two engines disagree and MySQL disagrees with itself. Measured on MySQL
   * 8.4.11 (InnoDB, REPEATABLE READ) and PostgreSQL 16.14, in
   * `test/integration/semantics.test.ts`:
   *
   * | savepoint set...              | MySQL                | Postgres |
   * | ----------------------------- | -------------------- | -------- |
   * | as the transaction's first act| lock released        | released |
   * | after the caller has written  | **lock survives**    | released |
   *
   * The second row is the shape that occurs in production, and on MySQL it means
   * a nested dry run holds exclusive locks on rows it only pretended to touch,
   * until the caller's transaction ends. With an unindexed WHERE, that can be
   * most of the table.
   *
   * Hence the default: dry runs get their own short-lived connection. Nesting may
   * be permitted on Postgres, where subtransactions release what they took; on
   * MySQL it must not be, and a test pins that difference so we find out if a
   * future version makes the restriction unnecessary.
   *
   * Note also that only testing the first shape yields the comfortable and wrong
   * conclusion that locks are always released.
   */
  savepoint(): Promise<Savepoint>;

  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /**
   * Run a write and report both counts, because they are different questions and
   * the engine needs different ones at different moments.
   *
   * `rowsMatched` answers "how many rows did the WHERE select" and `rowsChanged`
   * answers "how many rows actually ended up different". On MySQL these are
   * `affectedRows` and `changedRows`; a same-value UPDATE gives 2 and 0.
   * Postgres has no such distinction — it rewrites the row either way — so both
   * are the same number there and only a snapshot comparison can tell you whether
   * anything really moved.
   *
   * Collapsing the two is how a check meant to catch "rows you were never shown"
   * ends up passing on a statement that changed nothing at all.
   */
  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rowsMatched: number; rowsChanged: number; changedIsMeaningful: boolean }>;

  quoteIdent(name: string): string;

  /**
   * The clause that makes a SELECT hold its rows until the transaction ends.
   *
   * The apply step reads the target rows and checks they still match the plan
   * before writing. Without a lock there is a gap between that check and the
   * write in which another session can change the row, and the whole point of
   * the check is to close that gap.
   *
   * `' FOR UPDATE'` on MySQL and Postgres. Empty on SQLite, which has no row
   * locks at all — a write transaction there locks the entire database, so the
   * adapter takes that lock at `begin()` instead and the gap never opens. This
   * is a method rather than a constant because returning the wrong answer here
   * is not a syntax error on every engine: appending `FOR UPDATE` on SQLite
   * throws, but *omitting* it on Postgres runs perfectly and silently drops the
   * guarantee.
   */
  rowLockClause(): string;

  close(): Promise<void>;
}

/**
 * Which guarantees a connection is being asked to prove.
 *
 * `'full'` is the write path: a real transaction, a rollback that undoes, and a
 * counting model the reconciliation can rely on. Establishing those requires
 * writing, so they cannot be asked of a read-only role.
 *
 * `'read'` is the read path. It must prove only what reading depends on. This
 * distinction exists because the first version of the read connection ran the
 * full check against it, which failed on exactly the configuration the docs
 * recommend — a Postgres role with no privilege to create a temporary table.
 * A guard written for one role, applied to another, refusing the correct setup.
 */
export type SelfCheckMode = 'full' | 'read';

export interface Savepoint {
  readonly name: string;
  rollback(): Promise<void>;
  release(): Promise<void>;
}

export type Row = Record<string, unknown>;

export interface ColumnShape {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  /**
   * True when the database changes this column by itself on update
   * (`ON UPDATE CURRENT_TIMESTAMP`, or a trigger doing the same job).
   *
   * Getting this wrong does not fail loudly — it makes the system unusable in a
   * way nobody can diagnose. The plan records `updated_at` as it was during the
   * dry run; the real apply writes a later timestamp; the post-apply check sees
   * a mismatch and aborts. Every plan, forever, with an error message about
   * concurrent modification.
   *
   * Detection is best-effort and dialect-specific, so
   * {@link TableShape.autoColumnsKnown} says whether to trust it.
   */
  readonly autoUpdated: boolean;
}

export interface InboundCascade {
  /** The table that would change as a side effect. */
  readonly table: string;
  readonly constraint: string;
  /** CASCADE, SET NULL, SET DEFAULT, RESTRICT, NO ACTION. */
  readonly onDelete: string;
  readonly onUpdate: string;
}

export interface TableShape {
  readonly table: string;
  readonly columns: readonly ColumnShape[];
  /** Primary key columns, in order. Empty when the table has none. */
  readonly primaryKey: readonly string[];
  /**
   * False when this table's storage engine cannot roll back.
   *
   * A non-transactional table accepts a ROLLBACK, reports success, and keeps the
   * change. The dry run is then a permanent write to production, announced to the
   * operator as 'production is untouched'. Checking a probe table proves nothing
   * about the target: the engine is a per-table property.
   */
  readonly transactional: boolean;
  /**
   * Foreign keys pointing AT this table that move rows elsewhere when it changes.
   *
   * With ON DELETE CASCADE, deleting one approved row silently deletes rows in
   * another table that never appeared on the confirmation card — irreversibly.
   */
  readonly inboundCascades: readonly InboundCascade[];
  /** Triggers on this table. A trigger can write to any table, unseen. */
  readonly triggerCount: number;
  /**
   * False when this dialect cannot report auto-updated columns reliably — for
   * example when the behaviour lives in a trigger rather than in the column
   * definition, which is the ordinary way to do it on Postgres.
   *
   * When false, the engine must not silently assume "none": it has to surface
   * the uncertainty and let the caller declare the columns instead. Declared
   * beats detected here, because a wrong "none" is indistinguishable from a
   * concurrency failure at approval time.
   */
  readonly autoColumnsKnown: boolean;
}
