/**
 * SQLite, end to end, against a real database file.
 *
 * This suite lives beside the unit tests rather than in `test/integration`
 * because it needs no server, no container and no credentials — which is the
 * whole reason the adapter exists. Everything the library claims can be watched
 * happening here in about a second: the statement really runs, the diff is really
 * measured, the rollback really undoes it, and the apply really commits.
 *
 * Each test names the SPEC rule it pins.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter, AdapterUnusable } from '../src/adapters/sqlite.js';
import { Engine, PlanRefused } from '../src/engine.js';
import { Applier } from '../src/apply.js';
import { SqlPlanStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { parseConfig, ConfigError } from '../src/config.js';
import type { Row } from '../src/adapter.js';

/**
 * `node:sqlite` ships unflagged from Node 23.4 and needs --experimental-sqlite on
 * 22.5 to 23.3. The library supports Node 20+ for MySQL and PostgreSQL, so this
 * whole suite is skipped rather than failed where the module does not exist — and
 * named in the skip reason, so a green run on Node 20 is not mistaken for
 * coverage that did not happen.
 */
const SQLITE_AVAILABLE = await import('node:sqlite').then(
  () => true,
  () => false,
);
const skip = SQLITE_AVAILABLE
  ? undefined
  : 'node:sqlite is not available in this Node build (needs Node 24, or 22.5+ with --experimental-sqlite)';

describe('sqlite', { skip }, () => {
  const policy = new Policy({
    allow: ['orders', 'big', 'parent', 'trig', 'a_view'],
    impact: {
      orders: 'Changing an order moves money: the ship date decides the payment month.',
      big: 'test table',
      parent: 'test table',
      trig: 'test table',
      a_view: 'test view',
    },
  });

  let dir: string;
  let file: string;
  let planning: SqliteAdapter;
  let writing: SqliteAdapter;
  let bookkeeping: SqliteAdapter;
  let engine: Engine;
  let applier: Applier;
  let store: SqlPlanStore;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-sqlite-'));
    file = join(dir, 'app.db');

    // Three separate connections to the same file, exactly as the two-process
    // deployment would have. A single shared handle would hide any locking problem.
    planning = await SqliteAdapter.connect({ file });
    writing = await SqliteAdapter.connect({ file });
    bookkeeping = await SqliteAdapter.connect({ file });
    store = new SqlPlanStore({ adapter: bookkeeping });
    await store.migrate();
    engine = new Engine({ adapter: planning, policy });
    applier = new Applier({ adapter: writing, policy, store });
  });

  after(async () => {
    await planning.close().catch(() => {});
    await writing.close().catch(() => {});
    await bookkeeping.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await bookkeeping.query('DROP TABLE IF EXISTS orders');
    await bookkeeping.query(
      `CREATE TABLE orders (
         id INTEGER PRIMARY KEY,
         ref TEXT NOT NULL,
         qty INTEGER NOT NULL,
         amount REAL NOT NULL,
         payload BLOB,
         note TEXT
       )`,
    );
    await bookkeeping.query(
      `INSERT INTO orders VALUES
         (1,'R-1',10,12.5,x'deadbeef',NULL),
         (2,'R-2',20,99.99,NULL,'keep'),
         (3,'R-3',30,0.01,NULL,NULL)`,
    );
    await bookkeeping.query('DELETE FROM llm_safe_sql_plans');
    await bookkeeping.query('DELETE FROM llm_safe_sql_audit');
  });

  async function qtyOf(id: number): Promise<number> {
    const rows = await bookkeeping.query<Row>('SELECT qty FROM orders WHERE id = ?', [id]);
    return Number(rows[0]?.['qty']);
  }

  // =====================================================================
  //  E — the environment is verified, not assumed.
  // =====================================================================

  test('E: selfCheck passes on an ordinary file, and leaves no probe table behind', async () => {
    await planning.selfCheck();
    const left = await bookkeeping.query<Row>(
      "SELECT name FROM sqlite_master WHERE name = 'llm_safe_sql_probe'",
    );
    assert.equal(left.length, 0, 'the probe must be rolled back, not dropped');
  });

  test('E: an in-memory database is refused — a plan written there could never be read back', async () => {
    await assert.rejects(
      () => SqliteAdapter.connect({ file: ':memory:' }),
      (e: unknown) => e instanceof AdapterUnusable && /in-memory/i.test((e as Error).message),
    );
  });

  test('E: a read-only connection can read, and is proven to be read-only', async () => {
    const ro = await SqliteAdapter.connect({ file, readOnly: true });
    try {
      // 'read' is the mode this connection exists for, and it must not throw:
      // this is the recommended model-side shape.
      await ro.selfCheck('read');
      const rows = await ro.query<Row>('SELECT qty FROM orders WHERE id = 1');
      assert.equal(Number(rows[0]?.['qty']), 10);
      assert.equal(ro.isReadOnly, true);
    } finally {
      await ro.close();
    }
  });

  test('E: the write path cannot be verified on a read-only connection, and says so', async () => {
    // This assertion used to be `await ro.selfCheck()` with a comment saying it
    // must not throw. It did not throw, because the mode was ignored entirely —
    // so the suite recorded, as intended behaviour, a connection passing the
    // write path's check without establishing one thing the write path needs.
    // `check` then printed "a rollback really undoes a write" about it.
    const ro = await SqliteAdapter.connect({ file, readOnly: true });
    try {
      await assert.rejects(
        () => ro.selfCheck('full'),
        (e: unknown) => e instanceof AdapterUnusable && /read-only/i.test((e as Error).message),
      );
    } finally {
      await ro.close();
    }
  });

  test('E: a writable connection used for reads is not put through the write probe', async () => {
    // `readConnection` need not be a read-only handle, and when it is not, the
    // read path must still ask only for what reading depends on. The full probe
    // opens BEGIN IMMEDIATE, which takes the whole database against other
    // writers — so this used to make an ordinary read fail with "database is
    // locked" whenever anything else was mid-write.
    const other = await SqliteAdapter.connect({ file });
    const reader = await SqliteAdapter.connect({ file });
    try {
      await other.begin();
      await other.query('UPDATE orders SET qty = qty WHERE id = 1');
      await reader.selfCheck('read'); // must not need the write lock `other` holds
      const rows = await reader.query<Row>('SELECT qty FROM orders WHERE id = 1');
      assert.equal(Number(rows[0]?.['qty']), 10);
    } finally {
      await other.rollback().catch(() => {});
      await other.close();
      await reader.close();
    }
  });

  test('E: a read-only connection refuses to run a dry run, and says which connection is wrong', async () => {
    const ro = await SqliteAdapter.connect({ file, readOnly: true });
    try {
      await assert.rejects(
        () => ro.execute('UPDATE orders SET qty = 1 WHERE id = 1'),
        (e: unknown) => e instanceof AdapterUnusable && /read-only/i.test((e as Error).message),
      );
    } finally {
      await ro.close();
    }
  });

  // =====================================================================
  //  D — the dry run measures what really happened, then really undoes it.
  // =====================================================================

  test('D: the statement really runs, the diff is measured, and the row is left untouched', async () => {
    const plan = await engine.plan('UPDATE orders SET qty = qty + 5 WHERE id = 1');

    assert.equal(plan.op, 'UPDATE');
    assert.equal(plan.table, 'orders');
    assert.equal(plan.rows.length, 1);
    assert.deepEqual(plan.rows[0]?.changed, ['qty']);
    assert.equal(Number(plan.rows[0]?.before['qty']), 10);
    assert.equal(Number(plan.rows[0]?.after['qty']), 15);

    // The claim that matters: production is untouched. Read it back on a different
    // connection, so a rollback that only worked in our own session would fail here.
    assert.equal(await qtyOf(1), 10);
  });

  test('D: a statement that changes nothing is refused rather than shown as a change', async () => {
    await assert.rejects(
      () => engine.plan('UPDATE orders SET qty = 10 WHERE id = 1'),
      (e: unknown) => e instanceof PlanRefused,
    );
    assert.equal(await qtyOf(1), 10);
  });

  test('D: a DELETE is measured and rolled back, and its rows are still there', async () => {
    const plan = await engine.plan('DELETE FROM orders WHERE id = 3');
    assert.equal(plan.op, 'DELETE');
    assert.equal(plan.rows.length, 1);
    const rows = await bookkeeping.query<Row>('SELECT id FROM orders WHERE id = 3');
    assert.equal(rows.length, 1, 'the dry-run DELETE must have been rolled back');
  });

  test('D: SQLite cannot tell "changed" from "matched", and says so rather than guessing', async () => {
    const plan = await engine.plan('UPDATE orders SET qty = qty + 1 WHERE id = 2');
    assert.equal(plan.rowsChangedIsMeaningful, false);
  });

  // =====================================================================
  //  D — 64-bit integers survive exactly.
  //
  //   A JS number holds 53 bits. Both of the values below round to the SAME
  //   double, so an adapter that read them as numbers would compare them equal,
  //   report NO_CHANGE, and the edit would vanish from the card. This is the same
  //   defect shape as reading a microsecond timestamp into a millisecond Date,
  //   which this library shipped once and had to fix.
  // =====================================================================

  test('D: a change beyond 2^53 is still seen as a change', async () => {
    const before = 9223372036854775806n; // int64 max - 1
    const after = 9223372036854775807n; // int64 max

    // The premise, asserted rather than assumed: these two distinct integers are
    // the SAME double. Anything that reads them as JS numbers cannot tell them
    // apart, so the edit below would compare equal and vanish from the card.
    assert.notEqual(before, after);
    assert.equal(Number(before), Number(after));

    await bookkeeping.query('DROP TABLE IF EXISTS big');
    await bookkeeping.query('CREATE TABLE big (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
    await bookkeeping.query(`INSERT INTO big VALUES (1, ${before})`);

    const plan = await engine.plan(`UPDATE big SET n = ${after} WHERE id = 1`);
    assert.equal(plan.rows.length, 1);
    assert.deepEqual(plan.rows[0]?.changed, ['n']);
    assert.equal(String(plan.rows[0]?.before['n']), String(before));
    assert.equal(String(plan.rows[0]?.after['n']), String(after));
  });

  // =====================================================================
  //  D13 / introspection — what the schema really says.
  // =====================================================================

  test('introspect: a composite primary key comes back in key order, not table order', async () => {
    await bookkeeping.query('DROP TABLE IF EXISTS parent');
    // `b` is declared first but is the SECOND key column. Reading these in table
    // order would address a different row than the one approved.
    await bookkeeping.query('CREATE TABLE parent (b TEXT NOT NULL, a TEXT NOT NULL, PRIMARY KEY (a, b))');
    const shape = await planning.introspect('parent');
    assert.deepEqual(shape.primaryKey, ['a', 'b']);
  });

  test('introspect: an inbound ON DELETE CASCADE is found', async () => {
    await bookkeeping.query('DROP TABLE IF EXISTS child');
    await bookkeeping.query('DROP TABLE IF EXISTS parent');
    await bookkeeping.query('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
    await bookkeeping.query(
      'CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id) ON DELETE CASCADE)',
    );
    const shape = await planning.introspect('parent');
    assert.equal(shape.inboundCascades.length, 1);
    assert.equal(shape.inboundCascades[0]?.table, 'child');
    assert.equal(shape.inboundCascades[0]?.onDelete, 'CASCADE');
    await bookkeeping.query('DROP TABLE IF EXISTS child');
  });

  test('introspect: a trigger makes auto-maintained columns unknown, never silently "none"', async () => {
    await bookkeeping.query('DROP TABLE IF EXISTS trig');
    await bookkeeping.query('CREATE TABLE trig (id INTEGER PRIMARY KEY, v INTEGER, updated_at TEXT)');
    await bookkeeping.query(
      'CREATE TRIGGER trig_bu AFTER UPDATE ON trig BEGIN ' +
        "UPDATE trig SET updated_at = datetime('now') WHERE id = NEW.id; END",
    );
    const shape = await planning.introspect('trig');
    assert.equal(shape.triggerCount, 1);
    assert.equal(shape.autoColumnsKnown, false, 'a trigger can maintain a column invisibly');
  });

  test('introspect: a view is not a transactional target', async () => {
    await bookkeeping.query('DROP VIEW IF EXISTS a_view');
    await bookkeeping.query('CREATE VIEW a_view AS SELECT id, qty FROM orders');
    const shape = await planning.introspect('a_view');
    assert.equal(shape.transactional, false);
    await bookkeeping.query('DROP VIEW IF EXISTS a_view');
  });

  // =====================================================================
  //  The card says what this engine cannot do.
  // =====================================================================

  test('every plan carries the missing statement timeout as a warning', async () => {
    const plan = await engine.plan('UPDATE orders SET qty = qty + 5 WHERE id = 1');
    assert.ok(
      plan.warnings.some((w) => /cannot bound how long a statement runs/i.test(w)),
      `expected the limitation on the card, got: ${JSON.stringify(plan.warnings)}`,
    );
  });

  // =====================================================================
  //  A — apply, with no row locks to take.
  // =====================================================================

  test('A: an approved plan writes exactly what was shown, from a second connection', async () => {
    const plan = await engine.plan('UPDATE orders SET qty = qty + 5 WHERE id = 1');
    const rec = await applier.record(plan, 'assistant');
    await applier.approve(rec.id, 'alice');

    const res = await applier.apply(rec.id, 'alice');
    assert.equal(res.rowsAffected, 1);
    assert.equal(await qtyOf(1), 15);
  });

  test('A: applying twice is refused — the second attempt changes nothing', async () => {
    const plan = await engine.plan('UPDATE orders SET qty = qty + 5 WHERE id = 1');
    const rec = await applier.record(plan, 'assistant');
    await applier.approve(rec.id, 'alice');
    await applier.apply(rec.id, 'alice');

    await assert.rejects(() => applier.apply(rec.id, 'alice'));
    assert.equal(await qtyOf(1), 15, 'the row must not move a second time');
  });

  test('A: a plan nobody approved cannot be applied', async () => {
    const plan = await engine.plan('UPDATE orders SET qty = qty + 5 WHERE id = 1');
    const rec = await applier.record(plan, 'assistant');
    await assert.rejects(() => applier.apply(rec.id, 'alice'));
    assert.equal(await qtyOf(1), 10);
  });

  // =====================================================================
  //  Config.
  // =====================================================================

  test('config: a sqlite connection takes a file, and :memory: is refused with a reason', () => {
    const base = {
      dialect: 'sqlite',
      connection: { file: './app.db' },
      policy: { allow: ['orders'], impact: { orders: 'test' } },
    };
    const cfg = parseConfig(base);
    assert.equal(cfg.dialect, 'sqlite');
    assert.deepEqual(cfg.connection, { file: './app.db' });

    assert.throws(
      () => parseConfig({ ...base, connection: { file: ':memory:' } }),
      (e: unknown) => e instanceof ConfigError && /never be read back/i.test((e as Error).message),
    );
  });

  test('config: host/port is not a sqlite connection', () => {
    assert.throws(
      () =>
        parseConfig({
          dialect: 'sqlite',
          connection: { host: '127.0.0.1', port: 5432, user: 'x', password: '', database: 'y' },
          policy: { allow: ['orders'], impact: { orders: 'test' } },
        }),
      (e: unknown) => e instanceof ConfigError && /file/i.test((e as Error).message),
    );
  });

  // =====================================================================
  //  The read path can be enforced below this library.
  // =====================================================================

  test('read: a separate read-only connection serves reads and refuses writes', async () => {
    const ro = await SqliteAdapter.connect({ file, readOnly: true });
    const e = new Engine({ adapter: planning, readAdapter: ro, policy });
    try {
      assert.equal(e.readIsSeparate, true);

      const r = await e.read('SELECT id, qty FROM orders WHERE id = 1');
      assert.equal(r.rows.length, 1);
      assert.equal(Number(r.rows[0]?.['qty']), 10);

      // The guarantee is not that we refuse — it is that SQLite refuses, one
      // layer below anything this library gets right or wrong.
      await assert.rejects(() => ro.query("UPDATE orders SET qty = 999 WHERE id = 1"));
      assert.equal(await qtyOf(1), 10);
    } finally {
      await ro.close();
    }
  });

  test('read: planning still works while reads are read-only, because it needs its own connection', async () => {
    const ro = await SqliteAdapter.connect({ file, readOnly: true });
    const e = new Engine({ adapter: planning, readAdapter: ro, policy });
    try {
      const plan = await e.plan('UPDATE orders SET qty = qty + 5 WHERE id = 1');
      assert.equal(plan.rows.length, 1);
      assert.equal(await qtyOf(1), 10, 'the dry run must still roll back');
    } finally {
      await ro.close();
    }
  });

  test('read: with no readAdapter, reads share the connection that can write', async () => {
    const e = new Engine({ adapter: planning, policy });
    assert.equal(e.readIsSeparate, false);
    assert.equal(e.readAdapter, e.adapter);
  });

  test('read: a read-only connection is verified as a read connection, not as a write one', async () => {
    const ro = await SqliteAdapter.connect({ file, readOnly: true });
    try {
      // The write path's guarantees cannot be established without writing. Asking
      // for them here refused the exact configuration the docs recommend — a
      // Postgres role with no privilege to create a temporary table.
      await ro.selfCheck('read');
      // Proved, not read off the flag we opened the handle with.
      assert.equal(await ro.probeWritable(['orders']), 'read-only');
    } finally {
      await ro.close();
    }
  });

  test('probeWritable says yes for a writable connection, and changes nothing', async () => {
    const before = await bookkeeping.query<Row>('SELECT * FROM orders ORDER BY id');
    assert.equal(await planning.probeWritable(['orders']), 'writable');
    const left = await bookkeeping.query<Row>(
      "SELECT name FROM sqlite_master WHERE name = 'llm_safe_sql_wprobe'",
    );
    assert.equal(left.length, 0, 'the write probe must leave no table behind');
    assert.deepEqual(await bookkeeping.query<Row>('SELECT * FROM orders ORDER BY id'), before);
  });

  test('probeWritable says "unknown" when there was nothing it could ask about', async () => {
    // Not "read-only". A table it cannot read establishes nothing, and reporting
    // nothing as a boundary is the failure this method was rewritten to remove.
    assert.equal(await planning.probeWritable(['no_such_table']), 'unknown');
    assert.equal(await planning.probeWritable([]), 'unknown');
  });

  test('a zero-padded code does not ride along under an approved change', () => {
    // The end-to-end shape of the compare.ts bug, kept here because the unit test
    // for `sameValue` pins the primitive and this pins the consequence: the card
    // said "1 row would change, across 1 column: name" while the statement also
    // rewrote a stored code, and the apply committed both. It is the same defect
    // as the microsecond ride-along above, in a different type.
    return (async (): Promise<void> => {
      await bookkeeping.query('DROP TABLE IF EXISTS padded');
      await bookkeeping.query('CREATE TABLE padded (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL)');
      await bookkeeping.query("INSERT INTO padded VALUES (1, 'Ada', '00100')");
      const e = new Engine({
        adapter: planning,
        policy: new Policy({ allow: ['padded'], impact: { padded: 'test table' } }),
      });
      const plan = await e.plan("UPDATE padded SET name = 'Grace', code = '100' WHERE id = 1");
      assert.deepEqual(
        [...plan.rows[0]?.changed ?? []].sort(),
        ['code', 'name'],
        'every column the statement really changed has to be on the card',
      );
      assert.equal(plan.rows[0]?.before['code'], '00100');
      assert.equal(plan.rows[0]?.after['code'], '100');
    })();
  });

  test('a column assigned its own value is still verified before the apply writes it', async () => {
    // The card shows what CHANGED. The statement writes what it ASSIGNS, and the
    // two differ whenever a column is set to the value it already holds. Both the
    // pre-apply comparison and the read-back used to iterate the displayed set,
    // so such a column was written having been checked against nothing: another
    // session correcting it between approval and apply had its correction
    // reverted, off the card, and the apply reported success.
    await bookkeeping.query('DROP TABLE IF EXISTS assigned');
    await bookkeeping.query('CREATE TABLE assigned (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL)');
    await bookkeeping.query("INSERT INTO assigned VALUES (1, 'old', '00100')");
    const pol = new Policy({ allow: ['assigned'], impact: { assigned: 'test table' } });
    const e = new Engine({ adapter: planning, policy: pol });
    const store = new SqlPlanStore({ adapter: bookkeeping });
    await store.migrate();
    const applier = new Applier({ adapter: planning, policy: pol, store });

    const plan = await e.plan("UPDATE assigned SET name = 'new', code = '00100' WHERE id = 1");
    assert.deepEqual(plan.rows[0]?.changed, ['name'], 'only name really differs, so only name is displayed');
    assert.deepEqual(
      [...(plan.rows[0]?.covered ?? [])].sort(),
      ['code', 'name'],
      'but both are written, so both must be covered',
    );

    const rec = await applier.record(plan, 'model');
    await applier.approve(rec.id, 'operator');
    // Somebody corrects the code in the meantime.
    await bookkeeping.query("UPDATE assigned SET code = '90210' WHERE id = 1");

    await assert.rejects(
      () => applier.apply(rec.id, 'operator'),
      (err: unknown) => (err as { code?: string }).code === 'ROW_CHANGED',
      'the apply must refuse rather than write the stale value back',
    );
    const [row] = await bookkeeping.query<Row>('SELECT code FROM assigned WHERE id = 1');
    assert.equal(row?.['code'], '90210', 'and the correction must still be there');
  });

  test('a row the card calls "already correct" is verified too', async () => {
    // On PostgreSQL and SQLite the rows-changed reconciliation is meaningless, so
    // a row whose `changed` is empty had nothing checked before or after the
    // write. The card advertises those rows as harmless — "1 more match the
    // condition but are already correct" — while the statement rewrites them.
    await bookkeeping.query('DROP TABLE IF EXISTS batch');
    await bookkeeping.query('CREATE TABLE batch (id INTEGER PRIMARY KEY, status TEXT NOT NULL, note TEXT NOT NULL)');
    await bookkeeping.query("INSERT INTO batch VALUES (1,'new','b7'), (2,'shipped','b7')");
    const pol = new Policy({ allow: ['batch'], impact: { batch: 'test table' } });
    const e = new Engine({ adapter: planning, policy: pol });
    const store = new SqlPlanStore({ adapter: bookkeeping });
    await store.migrate();
    const applier = new Applier({ adapter: planning, policy: pol, store });

    const plan = await e.plan("UPDATE batch SET status = 'shipped' WHERE note = 'b7'");
    assert.equal(plan.rows.length, 2);
    const quiet = plan.rows.find((r) => r.changed.length === 0);
    assert.ok(quiet !== undefined, 'row 2 already holds the value, so it displays as no change');
    assert.deepEqual(quiet.covered, ['status'], 'and it is still written, so it is still covered');

    const rec = await applier.record(plan, 'model');
    await applier.approve(rec.id, 'operator');
    await bookkeeping.query("UPDATE batch SET status = 'CANCELLED' WHERE id = 2");

    await assert.rejects(
      () => applier.apply(rec.id, 'operator'),
      (err: unknown) => (err as { code?: string }).code === 'ROW_CHANGED',
    );
    const [row] = await bookkeeping.query<Row>('SELECT status FROM batch WHERE id = 2');
    assert.equal(row?.['status'], 'CANCELLED', 'the cancellation must not be reverted');
  });

  test('assigning a column declared auto-maintained is refused, not hidden', async () => {
    // Auto columns are dropped from the diff by design (D8). A statement that
    // assigns one would then put an arbitrary value in the row with nothing on
    // the card to show for it — and autoColumns is a config key a model can read.
    await bookkeeping.query('DROP TABLE IF EXISTS autoassign');
    await bookkeeping.query('CREATE TABLE autoassign (id INTEGER PRIMARY KEY, v INTEGER, updated_at TEXT)');
    await bookkeeping.query("INSERT INTO autoassign VALUES (1, 1, '2020-01-01')");
    const e = new Engine({
      adapter: planning,
      policy: new Policy({ allow: ['autoassign'], impact: { autoassign: 'test table' } }),
      autoColumns: { autoassign: ['updated_at'] },
    });
    await assert.rejects(
      () => e.plan("UPDATE autoassign SET v = 2, updated_at = '1999-01-01' WHERE id = 1"),
      (err: unknown) => (err as { code?: string }).code === 'AUTO_COLUMN_ASSIGNED',
    );
  });

  // =====================================================================
  //  One at a time, per connection.
  // =====================================================================

  test('D6: two overlapping dry runs do not both open a transaction', async () => {
    // The anti-nesting check asks the adapter whether a transaction is open, and
    // it sits several awaits before the begin() it guards. Two calls that overlap
    // therefore both saw "no transaction" and both opened one. On MySQL the
    // second START TRANSACTION commits the first — a dry run made permanent and
    // reported as rolled back. The MCP server reaches this with no concurrency in
    // the caller at all: it serves tool calls as they arrive, on one session.
    const before = await qtyOf(1);
    const settled = await Promise.allSettled([
      engine.plan('UPDATE orders SET qty = 91 WHERE id = 1'),
      engine.plan('UPDATE orders SET qty = 92 WHERE id = 2'),
    ]);

    const refused = settled.filter((s) => s.status === 'rejected').map((s) => s.reason as PlanRefused);
    assert.equal(refused.length, 1, 'exactly one of two overlapping dry runs may proceed');
    assert.equal(refused[0]?.code, 'BUSY');
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);

    assert.equal(await qtyOf(1), before, 'and production is untouched either way');
  });

  test('a read on the planning connection is refused while a dry run holds it', async () => {
    // Not a nicety: that read would be served from inside the open trial
    // transaction and would report the values we are only pretending about.
    const e = new Engine({ adapter: planning, policy });
    const planning_ = e.plan('UPDATE orders SET qty = 93 WHERE id = 1');
    const read = e.read('SELECT qty FROM orders WHERE id = 1');
    const [p, r] = await Promise.allSettled([planning_, read]);
    assert.equal(p.status, 'fulfilled');
    assert.equal(r.status, 'rejected');
    assert.equal((r.reason as PlanRefused).code, 'BUSY');
    assert.match((r.reason as PlanRefused).message, /readConnection/);
  });

  test('a read on a separate connection is not blocked by a dry run', async () => {
    // The same reason it is safe: nothing is shared, so there is no transaction
    // for the read to fall inside.
    const ro = await SqliteAdapter.connect({ file, readOnly: true });
    try {
      const e = new Engine({ adapter: planning, readAdapter: ro, policy });
      const [p, r] = await Promise.allSettled([
        e.plan('UPDATE orders SET qty = 94 WHERE id = 1'),
        e.read('SELECT qty FROM orders WHERE id = 1'),
      ]);
      assert.equal(p.status, 'fulfilled');
      assert.equal(r.status, 'fulfilled');
    } finally {
      await ro.close();
    }
  });
});
