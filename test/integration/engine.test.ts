/**
 * The dry-run engine, against real servers.
 *
 * Each test names the SPEC rule it pins. The rules exist because the reference
 * implementation either lacked them or had them in a form that only worked by
 * accident on one engine.
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
  allow: ['orders', 'nopk', 'trig'],
  impact: {
    orders: 'Changing an order moves money: the ship date decides the payment month.',
    nopk: 'test table',
    trig: 'test table',
  },
});

let my: MysqlAdapter;
let pgA: PostgresAdapter;
let myEngine: Engine;
let pgEngine: Engine;

async function seedMysql(): Promise<void> {
  await my.query('DROP TABLE IF EXISTS orders');
  await my.query(
    `CREATE TABLE orders (
       id INT PRIMARY KEY, ref VARCHAR(20) NOT NULL, qty INT NOT NULL,
       note VARCHAR(50) NULL,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`,
  );
  await my.query("INSERT INTO orders (id, ref, qty, note) VALUES (1,'R-1',10,NULL),(2,'R-2',20,'x'),(3,'R-3',30,NULL)");
  await my.query('DROP TABLE IF EXISTS nopk');
  await my.query('CREATE TABLE nopk (id INT NOT NULL, v INT NOT NULL) ENGINE=InnoDB');
  await my.query('INSERT INTO nopk VALUES (1,1),(1,2)');
}

async function seedPg(): Promise<void> {
  await pgA.query('DROP TABLE IF EXISTS orders');
  await pgA.query(
    `CREATE TABLE orders (id INT PRIMARY KEY, ref TEXT NOT NULL, qty INT NOT NULL,
                          note TEXT, updated_at TIMESTAMP DEFAULT now())`,
  );
  await pgA.query("INSERT INTO orders VALUES (1,'R-1',10,NULL,now()),(2,'R-2',20,'x',now()),(3,'R-3',30,NULL,now())");
  await pgA.query('DROP TABLE IF EXISTS trig');
  await pgA.query('CREATE TABLE trig (id INT PRIMARY KEY, v INT NOT NULL, updated_at TIMESTAMP)');
  await pgA.query(`CREATE OR REPLACE FUNCTION trig_touch() RETURNS trigger AS $fn$
      BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END $fn$ LANGUAGE plpgsql`);
  await pgA.query('DROP TRIGGER IF EXISTS trig_bu ON trig');
  await pgA.query('CREATE TRIGGER trig_bu BEFORE UPDATE ON trig FOR EACH ROW EXECUTE FUNCTION trig_touch()');
  await pgA.query('INSERT INTO trig VALUES (1,1,now())');
}

before(async () => {
  my = await MysqlAdapter.connect(MYSQL);
  pgA = await PostgresAdapter.connect(PG);
  myEngine = new Engine({ adapter: my, policy, limits: { maxUpdateRows: 2, maxDeleteRows: 2 } });
  pgEngine = new Engine({ adapter: pgA, policy, limits: { maxUpdateRows: 2, maxDeleteRows: 2 } });
});

beforeEach(async () => {
  await seedMysql();
  await seedPg();
});

after(async () => {
  await my.close();
  await pgA.close();
});

function refusal(p: Promise<unknown>): Promise<PlanRefused> {
  return p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => {
      assert.ok(e instanceof PlanRefused, `expected PlanRefused, got ${String(e)}`);
      return e;
    },
  );
}

// ---------------------------------------------------------------------
for (const [name, eng] of [
  ['mysql', () => myEngine],
  ['postgres', () => pgEngine],
] as const) {
  test(`${name} D7: the dry run leaves production untouched`, async () => {
    const e = eng();
    const plan = await e.plan("UPDATE orders SET qty = 99 WHERE ref = 'R-1'");
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0]?.after['qty'], 99);
    const live = await e.adapter.query<{ qty: number }>("SELECT qty FROM orders WHERE ref = 'R-1'");
    assert.equal(Number(live[0]?.qty), 10, 'the real row must still hold its original value');
  });

  test(`${name} D2: a WHERE that matches nothing is refused`, async () => {
    const r = await refusal(eng().plan("UPDATE orders SET qty = 1 WHERE ref = 'MISSING'"));
    assert.equal(r.code, 'NO_ROWS');
  });

  test(`${name} D3: more rows than the ceiling is refused`, async () => {
    const r = await refusal(eng().plan('UPDATE orders SET qty = qty + 1 WHERE qty > 0'));
    assert.equal(r.code, 'TOO_MANY_ROWS');
    assert.match(r.message, /3/);
  });

  test(`${name} D10: a statement that changes nothing is refused`, async () => {
    const r = await refusal(eng().plan("UPDATE orders SET qty = 10 WHERE ref = 'R-1'"));
    assert.equal(r.code, 'NO_CHANGE');
  });

  test(`${name} D8: a column the database maintains is kept out of the diff`, async () => {
    // Without this the plan records updated_at as it was during the dry run, the
    // apply writes a later one, and every confirmation fails forever.
    const plan = await eng().plan("UPDATE orders SET qty = 99 WHERE ref = 'R-1'");
    assert.deepEqual(plan.rows[0]?.changed, ['qty']);
    assert.ok(!('updated_at' in (plan.rows[0]?.after ?? {})));
  });

  test(`${name} D11: DELETE shows every column, including the empty ones`, async () => {
    // Columns that were NULL at plan time must stay in the snapshot: dropping
    // them from the display also drops them from the pre-apply comparison, so a
    // value written in between would be deleted unseen.
    const plan = await eng().plan("DELETE FROM orders WHERE ref = 'R-1'");
    assert.equal(plan.op, 'DELETE');
    assert.ok('note' in (plan.rows[0]?.before ?? {}), 'a NULL column must still be recorded');
    assert.equal(plan.rows[0]?.before['note'], null);
  });

  test(`${name} the plan carries the business consequence`, async () => {
    const plan = await eng().plan("UPDATE orders SET qty = 99 WHERE ref = 'R-1'");
    assert.match(plan.impact, /payment month/);
  });

  test(`${name} reads are not plannable`, async () => {
    const r = await refusal(eng().plan('SELECT * FROM orders'));
    assert.equal(r.code, 'NOT_A_WRITE');
  });
}

// ---------------------------------------------------------------------
//  Rules where the engines differ
// ---------------------------------------------------------------------
test('D5/P6 MySQL: a table with no primary key is refused', async () => {
  const r = await refusal(myEngine.plan('UPDATE nopk SET v = 9 WHERE id = 1'));
  assert.equal(r.code, 'NO_PRIMARY_KEY');
});

test('D6 MySQL: a dry run may not nest inside a caller transaction', async () => {
  // Measured in semantics.test.ts: on MySQL the rolled-back statement keeps its
  // row locks until the outer transaction ends, so nesting would hold locks on
  // rows we only pretended to touch.
  await my.begin();
  try {
    const r = await refusal(myEngine.plan("UPDATE orders SET qty = 99 WHERE ref = 'R-1'"));
    assert.equal(r.code, 'NESTING_REFUSED');
  } finally {
    await my.rollback();
  }
});

test('D6 MySQL: two overlapping dry runs cannot commit one another', async () => {
  // The worst outcome this library can have, and it needed no concurrency in the
  // caller to reach — the MCP server serves tool calls as they arrive on one
  // session. The nesting check asks "is a transaction open?" several awaits
  // before the begin() it guards, so two overlapping calls both saw no and both
  // opened one. On MySQL, START TRANSACTION on a connection that already has one
  // open **commits** it: the first dry run becomes a permanent write to
  // production, and is reported to the operator as rolled back.
  const settled = await Promise.allSettled([
    myEngine.plan("UPDATE orders SET qty = 91 WHERE ref = 'R-1'"),
    myEngine.plan("UPDATE orders SET qty = 92 WHERE ref = 'R-2'"),
  ]);
  const refused = settled.filter((s) => s.status === 'rejected').map((s) => s.reason as PlanRefused);
  assert.equal(refused.length, 1, 'exactly one may hold the connection');
  assert.equal(refused[0]?.code, 'BUSY');

  const live = await my.query<{ ref: string; qty: number }>('SELECT ref, qty FROM orders ORDER BY id');
  assert.deepEqual(
    live.map((r) => Number(r.qty)),
    [10, 20, 30],
    'neither trial may survive in production',
  );
});

test('D8 Postgres: an undeclared trigger-maintained column refuses rather than guesses', async () => {
  const r = await refusal(pgEngine.plan('UPDATE trig SET v = 9 WHERE id = 1'));
  assert.equal(r.code, 'AUTO_COLUMNS_UNKNOWN');
  assert.match(r.message, /trig/);
});

test('D8 Postgres: declaring the column makes the table plannable again', async () => {
  const declared = new Engine({
    adapter: pgA,
    policy,
    limits: { maxUpdateRows: 2, maxDeleteRows: 2 },
    autoColumns: { trig: ['updated_at'] },
  });
  const plan = await declared.plan('UPDATE trig SET v = 9 WHERE id = 1');
  assert.deepEqual(plan.rows[0]?.changed, ['v']);
});

test('D7 fail-closed: a rollback that cannot be verified produces no plan', async () => {
  // Simulate the one failure that must never be survivable: rollback did not undo.
  const broken = new Engine({
    adapter: my,
    policy,
    limits: { maxUpdateRows: 2, maxDeleteRows: 2 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _rollbackHook: async () => {
      throw new Error('simulated rollback failure');
    },
  });
  const r = await refusal(broken.plan("UPDATE orders SET qty = 99 WHERE ref = 'R-1'"));
  assert.equal(r.code, 'ROLLBACK_FAILED');
});
