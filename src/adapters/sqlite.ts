import type { Adapter, ColumnShape, InboundCascade, Row, Savepoint, SelfCheckMode, TableShape, WriteAbility } from '../adapter.js';
import { AdapterUnusable, probeWriteAbility } from '../adapter.js';

export { AdapterUnusable };

export interface SqliteConfig {
  /** Path to the database file. `:memory:` is refused — see {@link SqliteAdapter.connect}. */
  file: string;
  /**
   * Open the file read-only, so SQLite itself refuses every write on this handle.
   *
   * This is what the model side should use. On MySQL and Postgres the plan/apply
   * split is enforced by giving the two processes different database users; a
   * SQLite file has no users, so the equivalent is asking the engine to reject
   * writes rather than trusting the policy layer never to issue one.
   */
  readOnly?: boolean;
}

/** The slice of `node:sqlite` this adapter uses, named here so the file type-checks anywhere. */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
type SqliteCtor = new (path: string, opts?: Record<string, unknown>) => SqliteDatabase;

/**
 * Values SQLite will accept as bound parameters.
 *
 * Everything this adapter reads comes back as null, bigint, number, string or
 * Uint8Array, and those are exactly what it can bind. The conversions exist for
 * values arriving from elsewhere — a decoded plan snapshot, a caller's own key —
 * where a `Date` or a boolean is possible and would otherwise throw inside the
 * driver with a message that names no column.
 */
function bindable(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) {
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  }
  return v;
}

const count = (v: number | bigint | undefined): number =>
  v === undefined ? 0 : typeof v === 'bigint' ? Number(v) : v;

/**
 * SQLite, through Node's built-in `node:sqlite`.
 *
 * It earns its place here for a reason the other two adapters cannot serve: it
 * needs no server, so the claim this library makes — "we really ran it, really
 * measured it, and really rolled it back" — can be watched happening against a
 * file in a temp directory, in one command, before anyone decides whether to
 * trust it.
 *
 * Four things work differently enough to state up front.
 *
 * **Integers are read as `bigint`.** SQLite stores 64-bit integers and a JS
 * number holds 53 bits of them. The default would either throw on a large id or,
 * worse, round it — and a change confined to the rounded-away digits would then
 * compare equal and never reach the confirmation card. That is the same defect
 * shape as reading a microsecond timestamp into a millisecond `Date`, which this
 * library shipped once already.
 *
 * **There are no row locks.** `SELECT ... FOR UPDATE` does not parse. A write
 * transaction locks the whole database instead, so this adapter opens every
 * transaction with `BEGIN IMMEDIATE` and takes that lock at the start rather than
 * upgrading to it halfway through.
 *
 * **There is no statement timeout.** `node:sqlite` exposes no interrupt, so the
 * one guarantee this adapter cannot make is that a statement is bounded in time.
 * It says so in {@link limitations}, which the engine prints on every card.
 *
 * **Read-only is a real boundary here.** A handle opened read-only is enforced by
 * SQLite, not by this library, and {@link selfCheck} proves it by trying to write.
 */
export class SqliteAdapter implements Adapter {
  readonly dialect = 'sqlite' as const;

  /**
   * Said on every confirmation card, because a limit nobody is told about is
   * indistinguishable from a limit that works.
   */
  readonly limitations: readonly string[] = [
    'SQLite cannot bound how long a statement runs, so the time limit in the config is not enforced here. ' +
      'A condition over an unindexed column can hold the whole database for as long as it takes.',
  ];

  private readonly db: SqliteDatabase;
  private readonly readOnly: boolean;
  private open = false;
  private savepoints = 0;

  private constructor(db: SqliteDatabase, readOnly: boolean) {
    this.db = db;
    this.readOnly = readOnly;
  }

  static async connect(cfg: SqliteConfig): Promise<SqliteAdapter> {
    if (cfg.file === ':memory:') {
      throw new AdapterUnusable(
        'An in-memory SQLite database is private to one connection, so a plan written here could never be ' +
          'read back by the process that applies it. Use a file path.',
      );
    }

    let DatabaseSync: SqliteCtor;
    try {
      // Imported on demand so that installing this package on a Node without
      // `node:sqlite` costs nothing until sqlite is actually chosen.
      ({ DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: SqliteCtor });
    } catch {
      throw new AdapterUnusable(
        'node:sqlite is not available in this Node build. It ships unflagged from Node 23.4, needs ' +
          '--experimental-sqlite on Node 22.5 to 23.3, and does not exist before that. Use Node 24 or later, ' +
          'or choose the mysql or postgres dialect.',
      );
    }

    const db = new DatabaseSync(cfg.file, {
      readOnly: cfg.readOnly === true,
      // 64-bit integers arrive exact. See the class comment: the alternative is a
      // silent loss of precision in the one comparison this library exists to get
      // right.
      readBigInts: true,
    });
    return new SqliteAdapter(db, cfg.readOnly === true);
  }

  /** True when this handle cannot write, whatever it is asked to do. */
  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * The mode is honoured here, and the underscore it used to carry is the whole
   * story: `_mode` was ignored, so this adapter branched on the handle's flag
   * instead of on what it was being asked to prove. That is the same defect that
   * was fixed for PostgreSQL, then missed for MySQL in the same commit — a
   * parameter added to an interface and left unread by one implementation, which
   * type checking cannot see. It survived here longest because the read/write
   * split on SQLite is a file handle rather than a credential, so the two
   * questions look like one.
   *
   * They are not. A *writable* handle configured as `readConnection` was given the
   * full write probe on every read: `BEGIN IMMEDIATE` takes the whole database
   * against other writers, and the read path would fail with "database is locked"
   * whenever anything else was writing. And a *read-only* handle asked for `'full'`
   * returned success having proven no rollback and no counting model, after which
   * `check` printed "a rollback really undoes a write" about a connection that had
   * demonstrated nothing of the kind.
   */
  async selfCheck(mode: SelfCheckMode = 'full'): Promise<void> {
    // A read-only handle is the recommended shape for the model side, so this is
    // not an error — but the flag is checked rather than believed. If a handle we
    // were told is read-only turns out to accept a write, the separation the
    // deployment is relying on does not exist, and that is worth refusing over.
    if (this.readOnly) {
      let wrote = false;
      try {
        this.db.exec('CREATE TABLE llm_safe_sql_probe (id INTEGER PRIMARY KEY)');
        wrote = true;
      } catch {
        /* expected: SQLite refuses writes on a read-only connection */
      }
      if (wrote) {
        try {
          this.db.exec('DROP TABLE IF EXISTS llm_safe_sql_probe');
        } catch {
          /* nothing better to do */
        }
        throw new AdapterUnusable(
          'This connection was opened read-only but accepted a write. The read/write separation this ' +
            'deployment depends on is not in place. Refusing to run.',
        );
      }
      if (mode === 'full') {
        throw new AdapterUnusable(
          'This connection was opened read-only, and the write path cannot be verified on it: a dry run ' +
            'really executes the statement before rolling it back. Use it as readConnection, and give ' +
            '`connection` a handle that may write.',
        );
      }
      return; // Reads need no transaction, no counting model, and no rollback.
    }

    // Everything below writes — a probe table, a rollback, a counting check —
    // and the read path needs none of it. Demanding it of a read connection is
    // how a guard written for one role ends up refusing another.
    if (mode === 'read') return;

    // Foreign keys are pinned rather than inherited. SQLite's own default is off,
    // the Node driver's default is on, and an application can change it per
    // connection — so leaving it alone means the dry run and the apply could
    // disagree about whether ON DELETE CASCADE fires, in two different processes,
    // with nothing to notice the difference.
    this.db.exec('PRAGMA foreign_keys = ON');
    if (count(this.one<{ foreign_keys: number | bigint }>('PRAGMA foreign_keys')?.foreign_keys) !== 1) {
      throw new AdapterUnusable(
        'Foreign key enforcement could not be turned on, so a cascade shown on the card might not happen — ' +
          'or one not shown might. Refusing rather than measuring something the apply will not repeat.',
      );
    }

    // One probe, inside a transaction that is rolled back, so it leaves nothing
    // behind and exercises the real journal of the real database file. A probe on
    // a temp table would pass even with journalling disabled on the main file.
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.open = true;
      this.db.exec('CREATE TABLE llm_safe_sql_probe (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
      this.db.exec('INSERT INTO llm_safe_sql_probe VALUES (1, 10)');

      // The counting model. SQLite rewrites a row even when the new value equals
      // the old one, exactly like Postgres, so `changes` answers "how many rows
      // did the WHERE reach" and can never answer "did anything really change".
      // The engine compares snapshots for that, and it only does so because this
      // adapter reports `changedIsMeaningful: false` — a claim worth proving.
      const same = this.db.prepare('UPDATE llm_safe_sql_probe SET v = 10 WHERE v = 10').run();
      if (count(same.changes) !== 1) {
        throw new AdapterUnusable(
          `Expected a same-value UPDATE to report 1 row, got ${String(same.changes)}. ` +
            'Row counting does not behave as this adapter assumes.',
        );
      }
      this.db.exec('ROLLBACK');
      this.open = false;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already gone */
      }
      this.open = false;
      if (e instanceof AdapterUnusable) throw e;
      throw new AdapterUnusable(`The environment could not be verified: ${String(e)}`);
    }

    // Did the rollback really undo? With `PRAGMA journal_mode = OFF` SQLite
    // accepts a ROLLBACK, reports success, and keeps the change — which would
    // make every dry run a permanent write to production, announced to the
    // operator as "nothing has changed". The probe table must be gone.
    const survived = count(
      this.one<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'llm_safe_sql_probe'",
      )?.n,
    );
    if (survived > 0) {
      this.db.exec('DROP TABLE IF EXISTS llm_safe_sql_probe');
      throw new AdapterUnusable(
        'A rollback did not undo the change: the probe table survived it. This database is not journalling, ' +
          'so a dry run here would be a permanent write. Refusing to run.',
      );
    }
  }

  /**
   * Only one of these two is real here, and {@link limitations} says which.
   *
   * `busy_timeout` is a genuine bound on waiting for the database lock.
   * `statementMs` has no equivalent in `node:sqlite`. Accepting it silently is
   * precisely the failure described in the {@link Adapter} docs — a limit that is
   * configured, believed, and absent.
   */
  async applyLimits(limits: { statementMs: number; lockMs: number }): Promise<void> {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(limits.lockMs))}`);
  }

  async introspect(table: string): Promise<TableShape> {
    // Case-insensitively, because that is how SQLite itself resolves the name.
    // With `= ?` a table created as `Orders` and allowlisted as `orders` was
    // reported as not found, while the statement the engine was about to run
    // would have resolved it perfectly well — the guard disagreeing with the
    // database about which tables exist.
    const meta = this.one<{ type: string; sql: string | null }>(
      "SELECT type, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type IN ('table', 'view')",
      table,
    );
    if (meta === undefined) throw new AdapterUnusable(`Table "${table}" was not found.`);

    const info = this.all<{ name: string; type: string; notnull: number | bigint; pk: number | bigint }>(
      `PRAGMA table_info(${this.quoteIdent(table)})`,
    );
    if (info.length === 0) throw new AdapterUnusable(`Table "${table}" has no readable columns.`);

    const columns: ColumnShape[] = info.map((c) => ({
      name: c.name,
      // SQLite's declared type is advisory — an affinity, not a constraint. It is
      // reported as written because that is what the schema says; nothing here
      // relies on it.
      type: c.type === '' ? 'BLOB' : c.type,
      nullable: count(c.notnull) === 0,
      // SQLite has no declarative ON UPDATE. The conventional way to maintain an
      // updated_at column is a trigger, so the column definitions cannot tell us
      // what moves by itself — the same situation as Postgres.
      autoUpdated: false,
    }));

    // `pk` is the 1-based position within the primary key, or 0 outside it.
    // Sorting by it matters: a composite key read in table order addresses a
    // different row than the same key read in key order.
    const primaryKey = info
      .filter((c) => count(c.pk) > 0)
      .sort((a, b) => count(a.pk) - count(b.pk))
      .map((c) => c.name);

    // `tbl_name` holds the name as the CREATE TRIGGER spelled it, and SQLite
    // table names are case-insensitive — so `CREATE TABLE Orders` with
    // `CREATE TRIGGER … ON orders` stored two different strings for one table. A
    // `= ?` comparison missed the trigger, `autoColumnsKnown` came back true, and
    // the engine then reported "no column moves by itself" about a table with a
    // trigger writing to it. The inbound-cascade scan twenty lines below already
    // folded case for exactly this reason; this query did not.
    //
    // NOCASE is SQLite's own ASCII case folding, which is the same rule it uses
    // to resolve the table name in the first place.
    const triggerCount = count(
      this.one<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE",
        table,
      )?.n,
    );

    // Foreign keys pointing AT this table. SQLite keeps no reverse index for
    // them, so every other table is asked in turn. Missing one would mean
    // deleting an approved row and silently deleting rows in another table that
    // never appeared on the card.
    const inboundCascades: InboundCascade[] = [];
    for (const o of this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )) {
      for (const f of this.all<{
        table: string;
        on_update: string;
        on_delete: string;
        id: number | bigint;
      }>(`PRAGMA foreign_key_list(${this.quoteIdent(o.name)})`)) {
        if (f.table.toLowerCase() !== table.toLowerCase()) continue;
        inboundCascades.push({
          table: o.name,
          // SQLite does not name its foreign keys; the index within the child
          // table is the only stable handle there is.
          constraint: `${o.name}.fk${String(count(f.id))}`,
          onDelete: f.on_delete === '' ? 'NO ACTION' : f.on_delete,
          onUpdate: f.on_update === '' ? 'NO ACTION' : f.on_update,
        });
      }
    }

    // A view has no rows of its own to roll back, and a virtual table's storage
    // belongs to a module that makes its own rules about transactions. Neither is
    // a target this library can make its guarantee about.
    const isVirtual = /^\s*create\s+virtual\s/i.test(meta.sql ?? '');
    const transactional = meta.type === 'table' && !isVirtual;

    return {
      table,
      columns,
      primaryKey,
      autoColumnsKnown: triggerCount === 0,
      transactional,
      inboundCascades,
      triggerCount,
    };
  }

  /**
   * Always `BEGIN IMMEDIATE`, for the dry run and for the apply.
   *
   * SQLite's default `BEGIN` is deferred: it takes no write lock until the first
   * write, which means the apply could read the rows, confirm they still match
   * the plan, and only then fail to acquire the lock — or succeed after another
   * writer committed in between. Taking the lock up front is what makes the
   * check-then-write sequence atomic, and it is why {@link rowLockClause} can be
   * empty here.
   *
   * It also makes the isolation argument moot: a write transaction sees a stable
   * snapshot for its whole life, which is what `repeatable-read` asks for.
   */
  async begin(_isolation: 'default' | 'repeatable-read' = 'default'): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    this.open = true;
  }

  async commit(): Promise<void> {
    this.db.exec('COMMIT');
    this.open = false;
  }

  async rollback(): Promise<void> {
    this.db.exec('ROLLBACK');
    this.open = false;
  }

  inTransaction(): boolean {
    return this.open;
  }

  async savepoint(): Promise<Savepoint> {
    const name = `llm_safe_sql_sp_${++this.savepoints}`;
    this.db.exec(`SAVEPOINT ${name}`);
    const db = this.db;
    return {
      name,
      async rollback() {
        db.exec(`ROLLBACK TO ${name}`);
      },
      async release() {
        db.exec(`RELEASE ${name}`);
      },
    };
  }

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params.map(bindable)) as T[];
  }

  async execute(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rowsMatched: number; rowsChanged: number; changedIsMeaningful: boolean }> {
    // Reached on a read-only handle only by a dry run or a migration. SQLite would
    // refuse it anyway; saying which of the two connections is the wrong one is
    // the difference between a fixable message and a driver error.
    if (this.readOnly) {
      throw new AdapterUnusable(
        'This connection is read-only, and a dry run really executes the statement before rolling it back. ' +
          'Give the planner a writable connection and keep the read-only one for reads.',
      );
    }
    const res = this.db.prepare(sql).run(...params.map(bindable));
    const n = count(res.changes);
    return {
      rowsMatched: n,
      rowsChanged: n,
      // A same-value UPDATE still rewrites the row and still counts, so this
      // number cannot distinguish "changed" from "matched". Only the before/after
      // snapshots can. Proven in selfCheck rather than assumed.
      changedIsMeaningful: false,
    };
  }

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  /**
   * Ask SQLite whether this handle may change the allowlisted tables.
   *
   * A read-only handle is still probed rather than assumed. It would be true to
   * return `'read-only'` on the flag alone — SQLite enforces it in the library
   * below us — but the flag records what we *asked* for, and the answer this
   * command exists to give is what the database will actually refuse. The
   * difference costs two statements and covers the case the flag cannot see: a
   * writable handle on a file the filesystem will not let us write.
   *
   * No savepoints, unlike Postgres: SQLite leaves a transaction usable after a
   * statement is refused.
   */
  async probeWritable(tables: readonly string[]): Promise<WriteAbility> {
    if (this.inTransaction()) return 'unknown';
    const attempt = async (sql: string): Promise<boolean> => {
      try {
        this.db.exec(sql);
        return true;
      } catch {
        return false;
      }
    };
    const columnsOf = async (t: string): Promise<readonly string[]> =>
      (await this.introspect(t)).columns.map((c) => c.name);
    const quote = (name: string): string => this.quoteIdent(name);

    // A read-only handle cannot open a write transaction, and failing to open one
    // must not be mistaken for failing to write. Nothing here can change the file
    // anyway — that is the proposition under test.
    let wrapped = false;
    if (!this.readOnly) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        wrapped = true;
      } catch {
        wrapped = false;
      }
    }
    try {
      return await probeWriteAbility(tables, columnsOf, quote, attempt);
    } finally {
      if (wrapped) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* nothing to undo */
        }
      }
    }
  }

  /**
   * Empty, and deliberately so: SQLite has no row locks to take.
   *
   * The guarantee `FOR UPDATE` provides elsewhere is provided here by
   * {@link begin} opening with `BEGIN IMMEDIATE`, which holds the whole database
   * against other writers for the life of the transaction.
   */
  rowLockClause(): string {
    return '';
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params.map(bindable)) as T[];
  }

  private one<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params.map(bindable)) as T | undefined;
  }
}
