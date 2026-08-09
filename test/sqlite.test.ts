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
      await ro.selfCheck(); // must NOT throw: this is the recommended model-side shape
      const rows = await ro.query<Row>('SELECT qty FROM orders WHERE id = 1');
      assert.equal(Number(rows[0]?.['qty']), 10);
      assert.equal(ro.isReadOnly, true);
    } finally {
      await ro.close();
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
});
