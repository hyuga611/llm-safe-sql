/**
 * Regressions.
 *
 * Every test here reproduces a defect that adversarial review found in an earlier
 * version of this engine, and each one was demonstrated against a real server
 * before it was fixed. They are kept because these are the failures that do not
 * announce themselves: the tool reported success, the confirmation card looked
 * reasonable, and the database did something else.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MysqlAdapter } from '../../src/adapters/mysql.js';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import { Engine, PlanRefused } from '../../src/engine.js';
import { Policy } from '../../src/policy.js';

const MYSQL = { host: '127.0.0.1', port: 13306, user: 'root', password: 'llmsafesql', database: 'llmsafesql' };
const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };

const policy = new Policy({
  allow: ['items', 'parents', 'children', 'myitems', 'bigids', 'precise'],
  impact: {
    items: 'test', parents: 'test', children: 'test', myitems: 'test', bigids: 'test',
    precise: 'test',
  },
});

let my: MysqlAdapter;
let pgA: PostgresAdapter;
let myE: Engine;
let pgE: Engine;

async function refused(p: Promise<unknown>): Promise<PlanRefused> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PlanRefused, `expected PlanRefused, got ${String(e)}`);
    return e;
  }
  throw new Error('expected a refusal');
}

before(async () => {
  my = await MysqlAdapter.connect(MYSQL);
  pgA = await PostgresAdapter.connect(PG);
  myE = new Engine({ adapter: my, policy });
  pgE = new Engine({ adapter: pgA, policy });
});

beforeEach(async () => {
  // MySQL fixtures
  await my.query('DROP TABLE IF EXISTS children');
  await my.query('DROP TABLE IF EXISTS parents');
  await my.query('CREATE TABLE parents (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB');
  await my.query(
    `CREATE TABLE children (id INT PRIMARY KEY, parent_id INT NOT NULL, v INT NOT NULL,
       CONSTRAINT fk_child FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE) ENGINE=InnoDB`,
  );
  await my.query('DROP TABLE IF EXISTS precise');
  await my.query(
    `CREATE TABLE precise (id INT PRIMARY KEY, ts DATETIME(6) NOT NULL, note VARCHAR(20) NULL) ENGINE=InnoDB`,
  );
  await my.query("INSERT INTO precise VALUES (1,'2026-01-02 03:04:05.123456','x')");
  await my.query('INSERT INTO parents VALUES (1,10),(2,20)');
  await my.query('INSERT INTO children VALUES (100,1,1),(101,1,2)');

  await my.query('DROP TABLE IF EXISTS items');
  await my.query(
    `CREATE TABLE items (id INT PRIMARY KEY, qty INT NOT NULL, payload JSON NULL, blob_col VARBINARY(16) NULL)
     ENGINE=InnoDB`,
  );
  await my.query(
    `INSERT INTO items VALUES (1, 10, '{"role":"user"}', 0xFF01), (2, 20, '{"role":"user"}', 0xFF02)`,
  );

  await my.query('DROP TABLE IF EXISTS myitems');
  await my.query('CREATE TABLE myitems (id INT PRIMARY KEY, qty INT NOT NULL) ENGINE=MyISAM');
  await my.query('INSERT INTO myitems VALUES (1,10)');

  await my.query('DROP TABLE IF EXISTS bigids');
  await my.query('CREATE TABLE bigids (id BIGINT PRIMARY KEY, ref BIGINT NOT NULL) ENGINE=InnoDB');
  await my.query('INSERT INTO bigids VALUES (1, 9007199254740993)');

  // Postgres fixtures
  await pgA.query('DROP TABLE IF EXISTS precise');
  await pgA.query('CREATE TABLE precise (id INT PRIMARY KEY, ts TIMESTAMP(6) NOT NULL, note TEXT)');
  await pgA.query("INSERT INTO precise VALUES (1,'2026-01-02 03:04:05.123456','x')");

  await pgA.query('DROP TABLE IF EXISTS children');
  await pgA.query('DROP TABLE IF EXISTS parents');
  await pgA.query('CREATE TABLE parents (id INT PRIMARY KEY, v INT NOT NULL)');
  await pgA.query(
    `CREATE TABLE children (id INT PRIMARY KEY, parent_id INT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
       v INT NOT NULL)`,
  );
  await pgA.query('INSERT INTO parents VALUES (1,10),(2,20)');
  await pgA.query('INSERT INTO children VALUES (100,1,1)');

  await pgA.query('DROP TABLE IF EXISTS items');
  await pgA.query('CREATE TABLE items (id INT PRIMARY KEY, qty INT NOT NULL, payload JSONB, blob_col BYTEA)');
  await pgA.query(`INSERT INTO items VALUES (1, 10, '{"role":"user"}', '\\xff01'), (2, 20, '{"role":"user"}', '\\xff02')`);
});

after(async () => {
  await my.close();
  await pgA.close();
});

// ---------------------------------------------------------------------
//  A change the card did not show
// ---------------------------------------------------------------------
test('a JSON column rewrite appears in the diff (MySQL)', async () => {
  // Previously invisible: String({role:'user'}) and String({role:'admin'}) are
  // both "[object Object]", so a privilege escalation rode along on a visible
  // quantity change without ever being displayed.
  const plan = await myE.plan(`UPDATE items SET qty = 99, payload = '{"role":"admin"}' WHERE id = 1`);
  assert.ok(plan.columnsTouched.includes('payload'), `columnsTouched was ${plan.columnsTouched.join(',')}`);
  assert.ok(plan.rows[0]?.changed.includes('payload'));
});

test('a JSONB column rewrite appears in the diff (Postgres)', async () => {
  const plan = await pgE.plan(`UPDATE items SET qty = 99, payload = '{"role":"admin"}' WHERE id = 1`);
  assert.ok(plan.columnsTouched.includes('payload'));
});

test('a binary column rewrite appears in the diff (MySQL)', async () => {
  const plan = await myE.plan('UPDATE items SET qty = 99, blob_col = 0xFE01 WHERE id = 1');
  assert.ok(plan.columnsTouched.includes('blob_col'));
});

test('a BIGINT change of one appears in the diff (MySQL)', async () => {
  // A double cannot represent 9007199254740993, so the driver has to hand these
  // back as strings or the last digit — the one that differs — is lost.
  const plan = await myE.plan('UPDATE bigids SET ref = 9007199254740992 WHERE id = 1');
  assert.ok(plan.columnsTouched.includes('ref'));
});

// ---------------------------------------------------------------------
//  A change to rows that were never on the card
// ---------------------------------------------------------------------
for (const [name, eng] of [['mysql', () => myE], ['postgres', () => pgE]] as const) {
  test(`${name}: DELETE with an inbound ON DELETE CASCADE is refused`, async () => {
    // Approving one parent row silently destroyed every child row too, and none
    // of them could be listed on the card. Deletion is irreversible.
    const r = await refused(eng().plan('DELETE FROM parents WHERE id = 1'));
    assert.equal(r.code, 'CASCADE_SIDE_EFFECTS');
    assert.match(r.message, /children/);
  });

  test(`${name}: a volatile predicate is refused`, async () => {
    // The rows counted, the rows executed against and the rows re-read were three
    // different sets, so the card described rows that were never touched.
    const fn = name === 'mysql' ? 'RAND()' : 'random()';
    const r = await refused(eng().plan(`UPDATE items SET qty = 99 WHERE id = 1 AND ${fn} < 2`));
    assert.equal(r.code, 'VOLATILE');
  });

  test(`${name}: a volatile assignment is refused`, async () => {
    // The applied value would differ from the one approved.
    const r = await refused(eng().plan('UPDATE items SET qty = 1 WHERE id = 1 AND qty = CURRENT_TIMESTAMP'));
    assert.equal(r.code, 'VOLATILE');
  });

  test(`${name}: ORDER BY / LIMIT on a write is refused`, async () => {
    const r = await refused(eng().plan('UPDATE items SET qty = 99 WHERE qty > 0 ORDER BY id LIMIT 1'));
    assert.equal(r.code, 'ORDER_OR_LIMIT');
  });

  test(`${name}: a JOIN in a write is refused`, async () => {
    const r = await refused(eng().plan('UPDATE items JOIN parents ON parents.id = items.id SET items.qty = 9 WHERE items.id = 1'));
    assert.ok(r.code === 'MULTI_TABLE' || r.code === 'TABLE_NOT_ALLOWED', r.code);
  });
}

test('MySQL multi-table UPDATE is refused', async () => {
  const r = await refused(myE.plan('UPDATE items, parents SET items.qty = 9 WHERE items.id = parents.id'));
  assert.equal(r.code, 'MULTI_TABLE');
});

test('MySQL multi-table DELETE is refused', async () => {
  const r = await refused(myE.plan('DELETE items FROM items WHERE id = 1'));
  assert.equal(r.code, 'MULTI_TABLE');
});

// ---------------------------------------------------------------------
//  A dry run that was not a dry run
// ---------------------------------------------------------------------
test('MySQL: a non-transactional target is refused before anything runs', async () => {
  // MyISAM accepts a ROLLBACK, reports success and keeps the write. The engine
  // used to plan against it happily and report "production is untouched" while
  // the row had permanently changed. The storage engine is per table, so a probe
  // table proves nothing about the target.
  const r = await refused(myE.plan('UPDATE myitems SET qty = 99 WHERE id = 1'));
  assert.equal(r.code, 'NOT_TRANSACTIONAL');
  const live = await my.query<{ qty: number }>('SELECT qty FROM myitems WHERE id = 1');
  assert.equal(Number(live[0]?.qty), 10, 'and nothing was written');
});

test('a dry run refuses to run inside a transaction the caller opened', async () => {
  // On Postgres this used to issue a bare ROLLBACK, discarding the caller's own
  // uncommitted work; the caller's later commit then succeeded silently with
  // nothing in it.
  await pgA.begin();
  await pgA.query('UPDATE parents SET v = 777 WHERE id = 2');
  try {
    const r = await refused(pgE.plan('UPDATE items SET qty = 99 WHERE id = 1'));
    assert.equal(r.code, 'NESTING_REFUSED');
    const mid = await pgA.query<{ v: number }>('SELECT v FROM parents WHERE id = 2');
    assert.equal(Number(mid[0]?.v), 777, "the caller's work is still there");
  } finally {
    await pgA.rollback();
  }
});

// ---------------------------------------------------------------------
//  False alarms — a refusal that names the wrong problem is its own defect
// ---------------------------------------------------------------------
test('a concurrent edit by someone else is not reported as a failed rollback', async () => {
  // The verification used to compare every column against the snapshot, so any
  // other session's ordinary write produced "the trial run may have persisted" —
  // an accusation of corruption that sends someone to restore a backup over a
  // database that was never damaged.
  const other = await MysqlAdapter.connect(MYSQL);
  try {
    const engine = new Engine({
      adapter: my,
      policy,
      _rollbackHook: async () => {
        await my.rollback();
        // Someone else commits a change to the same row, right in the window.
        await other.query('UPDATE items SET qty = 4242 WHERE id = 1');
      },
    });
    const plan = await engine.plan(`UPDATE items SET payload = '{"role":"admin"}' WHERE id = 1`);
    assert.ok(plan.rows.length === 1, 'the plan is produced, not a false incident');
  } finally {
    await other.query('UPDATE items SET qty = 10 WHERE id = 1').catch(() => {});
    await other.close();
  }
});

test('a statement refused before it runs does not claim a rollback problem', async () => {
  // The finally block used to replace the real reason with ROLLBACK_FAILED, so an
  // operator was told the trial could not be undone when nothing had been written.
  //
  // The engine retires a connection whose rollback failed — it may still hold
  // locks — so this uses its own, which is also what a caller should do.
  const own = await PostgresAdapter.connect(PG);
  const engine = new Engine({
    adapter: own,
    policy,
    _rollbackHook: async () => {
      await own.rollback();
      throw new Error('simulated rollback problem');
    },
  });
  const r = await refused(engine.plan('UPDATE items SET qty = 1 WHERE id = 4242'));
  assert.equal(r.code, 'NO_ROWS', `got ${r.code}: ${r.message}`);
  await own.close().catch(() => {});
});

test('after a failed rollback the engine refuses to reuse the connection', async () => {
  // Handing a connection that may still hold an open transaction back to a pool
  // passes the problem to whoever gets it next.
  const own = await MysqlAdapter.connect(MYSQL);
  const engine = new Engine({
    adapter: own,
    policy,
    _rollbackHook: async () => {
      throw new Error('simulated rollback failure');
    },
  });
  const first = await refused(engine.plan('UPDATE items SET qty = 99 WHERE id = 1'));
  assert.equal(first.code, 'ROLLBACK_FAILED');
  const second = await refused(engine.plan('UPDATE items SET qty = 98 WHERE id = 1'));
  assert.equal(second.code, 'ADAPTER_UNUSABLE');
  await own.close().catch(() => {});
});

test('a table named like a keyword is not mistaken for a clause', async () => {
  // `UPDATE order SET ...` targets a table called "order". Reading it as the start
  // of ORDER BY produced a refusal naming a problem the statement did not have.
  const p = new Policy({ allow: ['order'], impact: { order: 'test' } });
  const e = new Engine({ adapter: my, policy: p, assumeChecked: true });
  await my.query('DROP TABLE IF EXISTS `order`');
  await my.query('CREATE TABLE `order` (id INT PRIMARY KEY, qty INT NOT NULL) ENGINE=InnoDB');
  await my.query('INSERT INTO `order` VALUES (1, 10)');
  const plan = await e.plan('UPDATE `order` SET qty = 99 WHERE id = 1');
  assert.deepEqual(plan.rows[0]?.changed, ['qty']);
  await my.query('DROP TABLE IF EXISTS `order`');
});

/**
 * Sub-millisecond timestamps.
 *
 * Both drivers parse a timestamp into a JS `Date`, which holds milliseconds,
 * while `DATETIME(6)` and `timestamp(6)` hold microseconds. The last three digits
 * were therefore dropped on the way in, and a change confined to them compared
 * equal.
 *
 * On its own that failed closed — the plan was refused as NO_CHANGE, which is
 * wrong but harmless. The damage was the ride-along case below: alongside any
 * other edit, a plan was produced and the timestamp change was simply absent from
 * the card. That is the same shape as the JSON-column defect that started this
 * file, and it is why both adapters now take dates as text.
 */
test('a change of microseconds only is visible, not rounded away', async () => {
  const cases = [
    ['mysql', myE, my, 'CAST(ts AS CHAR)'],
    ['postgres', pgE, pgA, 'ts::text'],
  ] as const;
  for (const [label, e, q, asText] of cases) {
    const plan = await e.plan("UPDATE precise SET ts = '2026-01-02 03:04:05.123789' WHERE id = 1");
    assert.deepEqual(plan.columnsTouched, ['ts'], label);
    assert.match(String(plan.rows[0]?.before['ts']), /\.123456/, label);
    assert.match(String(plan.rows[0]?.after['ts']), /\.123789/, label);
    const now = await q.query<{ t: string }>(`SELECT ${asText} AS t FROM precise WHERE id = 1`);
    assert.match(String(now[0]?.t), /\.123456/, `${label}: the trial must have been rolled back`);
  }
});

test('a microsecond change does not ride along under another column', async () => {
  for (const [label, e] of [['mysql', myE], ['postgres', pgE]] as const) {
    const plan = await e.plan(
      "UPDATE precise SET note = 'edited', ts = '2026-01-02 03:04:05.123789' WHERE id = 1",
    );
    assert.deepEqual([...plan.columnsTouched].sort(), ['note', 'ts'], `${label}: both changes must be shown`);
  }
});

/**
 * MySQL's zero date.
 *
 * With a legacy `sql_mode`, `0000-00-00` is a storable value. The driver used to
 * hand it back as `1899-11-30` — a date the database does not contain, displayed
 * to somebody being asked to approve a change to it.
 */
test('mysql: a zero date is shown as what is stored, not as 1899-11-30', async () => {
  await my.query("SET SESSION sql_mode = ''");
  await my.query('DROP TABLE IF EXISTS zerodate');
  await my.query('CREATE TABLE zerodate (id INT PRIMARY KEY, d DATE NULL) ENGINE=InnoDB');
  await my.query("INSERT INTO zerodate VALUES (1,'0000-00-00')");
  const rows = await my.query<{ d: unknown }>('SELECT d FROM zerodate WHERE id = 1');
  assert.equal(String(rows[0]?.d), '0000-00-00');
  await my.query('DROP TABLE IF EXISTS zerodate');
});

test('P7: a misspelled SET column is refused before anything runs', async () => {
  // SPEC has carried this rule since the first version with nothing implementing
  // it, so the misspelling was found by the database — after the trial statement
  // had already executed inside the dry run — and reached the operator as a raw
  // driver error rather than as a refusal naming the columns the table has.
  const r = await refused(myE.plan('UPDATE parents SET vv = 1 WHERE id = 1'));
  assert.equal(r.code, 'NO_SUCH_COLUMN');
  assert.match(r.message, /\bv\b/, 'it should say what the table does have');

  const p = await refused(pgE.plan('UPDATE precise SET nope = 1 WHERE id = 1'));
  assert.equal(p.code, 'NO_SUCH_COLUMN');
});

test('denyWriteColumns is not escaped by a table-qualified or multi-column SET', async () => {
  // Both spellings were legal SQL that wrote the denied column while the guard
  // reported nothing: `SET t.col = …` handed the *table* name to the check, and
  // Postgres' `SET (a, b) = (…)` reported only the first name in the list.
  const guarded = new Policy({
    allow: ['parents', 'precise'],
    impact: { parents: 'test table', precise: 'test table' },
    denyWriteColumns: { v: 'a protected column' },
  });
  const my2 = new Engine({ adapter: my, policy: guarded, limits: { maxUpdateRows: 5, maxDeleteRows: 5 } });
  const a = await refused(my2.plan('UPDATE parents SET parents.v = 9 WHERE id = 1'));
  assert.equal(a.code, 'DENIED_WRITE_COLUMN');

  const pgGuarded = new Policy({
    allow: ['pgpair'],
    impact: { pgpair: 'test table' },
    denyWriteColumns: { v: 'a protected column' },
  });
  await pgA.query('DROP TABLE IF EXISTS pgpair');
  await pgA.query('CREATE TABLE pgpair (id INT PRIMARY KEY, n INT NOT NULL, v INT NOT NULL)');
  await pgA.query('INSERT INTO pgpair VALUES (1, 1, 1)');
  const pg2 = new Engine({ adapter: pgA, policy: pgGuarded, limits: { maxUpdateRows: 5, maxDeleteRows: 5 } });
  const b = await refused(pg2.plan('UPDATE pgpair SET (n, v) = (2, 2) WHERE id = 1'));
  assert.equal(b.code, 'DENIED_WRITE_COLUMN');
  await pgA.query('DROP TABLE IF EXISTS pgpair');
});
