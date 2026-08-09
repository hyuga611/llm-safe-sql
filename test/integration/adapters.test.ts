/**
 * Adapter contract tests, run against real servers.
 *
 * Every assertion here corresponds to something the reference implementation
 * assumed and never verified. The point is not that these behaviours are exotic;
 * it is that assuming them is how a library keeps claiming a guarantee after the
 * guarantee has stopped holding.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MysqlAdapter } from '../../src/adapters/mysql.js';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import type { Adapter } from '../../src/adapter.js';
import { AdapterUnusable } from '../../src/adapter.js';

const MYSQL = { host: '127.0.0.1', port: 13306, user: 'root', password: 'llmsafesql', database: 'llmsafesql' };
const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };

let my: MysqlAdapter;
let pgA: PostgresAdapter;

before(async () => {
  my = await MysqlAdapter.connect(MYSQL);
  pgA = await PostgresAdapter.connect(PG);

  await my.query('DROP TABLE IF EXISTS ad_plain');
  await my.query(
    'CREATE TABLE ad_plain (id INT PRIMARY KEY, v INT NOT NULL, note VARCHAR(50) NULL, ' +
      'updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB',
  );
  await my.query('INSERT INTO ad_plain (id, v) VALUES (1, 10), (2, 10)');

  await my.query('DROP TABLE IF EXISTS ad_trig');
  await my.query('CREATE TABLE ad_trig (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB');
  await my.query('DROP TRIGGER IF EXISTS ad_trig_bu');
  await my.query('CREATE TRIGGER ad_trig_bu BEFORE UPDATE ON ad_trig FOR EACH ROW SET NEW.v = NEW.v');

  await pgA.query('DROP TABLE IF EXISTS ad_plain');
  await pgA.query('CREATE TABLE ad_plain (id INT PRIMARY KEY, v INT NOT NULL, note TEXT, updated_at TIMESTAMP)');
  await pgA.query('INSERT INTO ad_plain (id, v) VALUES (1, 10), (2, 10)');

  await pgA.query('DROP TABLE IF EXISTS ad_trig');
  await pgA.query('CREATE TABLE ad_trig (id INT PRIMARY KEY, v INT NOT NULL, updated_at TIMESTAMP)');
  await pgA.query(`CREATE OR REPLACE FUNCTION ad_touch() RETURNS trigger AS $fn$
    BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$ LANGUAGE plpgsql`);
  await pgA.query('CREATE TRIGGER ad_trig_bu BEFORE UPDATE ON ad_trig FOR EACH ROW EXECUTE FUNCTION ad_touch()');
});

after(async () => {
  await my.close();
  await pgA.close();
});

for (const name of ['mysql', 'postgres'] as const) {
  describe(name, () => {
    const a = (): Adapter => (name === 'mysql' ? my : pgA);

    test('selfCheck passes on a healthy connection', async () => {
      await a().selfCheck();
    });

    test('a rollback really undoes the write (the premise of the whole library)', async () => {
      const ad = a();
      await ad.begin();
      await ad.execute('UPDATE ad_plain SET v = 42 WHERE id = 2');
      const mid = await ad.query<{ v: number }>('SELECT v FROM ad_plain WHERE id = 2');
      assert.equal(Number(mid[0]?.v), 42);
      await ad.rollback();
      const done = await ad.query<{ v: number }>('SELECT v FROM ad_plain WHERE id = 2');
      assert.equal(Number(done[0]?.v), 10);
      assert.equal(ad.inTransaction(), false);
    });

    test('savepoint names are unique per call', async () => {
      const ad = a();
      await ad.begin();
      const s1 = await ad.savepoint();
      const s2 = await ad.savepoint();
      assert.notEqual(s1.name, s2.name);
      await s2.rollback();
      await s1.rollback();
      await ad.rollback();
    });

    test('introspect reports columns and the primary key', async () => {
      const shape = await a().introspect('ad_plain');
      assert.deepEqual([...shape.primaryKey], ['id']);
      const names = shape.columns.map((c) => c.name).sort();
      assert.deepEqual(names, ['id', 'note', 'updated_at', 'v']);
      assert.equal(shape.columns.find((c) => c.name === 'note')?.nullable, true);
      assert.equal(shape.columns.find((c) => c.name === 'v')?.nullable, false);
    });

    test('applyLimits sets real session settings, not an ignorable hint', async () => {
      const ad = a();
      await ad.applyLimits({ statementMs: 300, lockMs: 1000 });
      const q =
        name === 'mysql'
          ? 'SELECT @@max_execution_time AS s, @@innodb_lock_wait_timeout AS l'
          : "SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l";
      const r = await ad.query<{ s: unknown; l: unknown }>(q);
      assert.equal(String(r[0]?.s).replace(/\D/g, ''), '300');
      assert.ok(String(r[0]?.l).length > 0);
      await ad.applyLimits({ statementMs: 30_000, lockMs: 10_000 });
    });
  });
}

// ---------------------------------------------------------------------
//  Dialect-specific truths that the engine has to know about
// ---------------------------------------------------------------------
test('MySQL: rowsChanged is meaningful and differs from rowsMatched', async () => {
  const r = await my.execute('UPDATE ad_plain SET v = 10 WHERE v = 10');
  assert.equal(r.rowsMatched, 2);
  assert.equal(r.rowsChanged, 0);
  assert.equal(r.changedIsMeaningful, true);
});

test('Postgres: rowsChanged is NOT meaningful, so the engine must not trust it', async () => {
  const r = await pgA.execute('UPDATE ad_plain SET v = 10 WHERE v = 10');
  assert.equal(r.rowsMatched, 2);
  assert.equal(r.changedIsMeaningful, false);
});

test('MySQL: an ON UPDATE CURRENT_TIMESTAMP column is flagged, and is knowable', async () => {
  const shape = await my.introspect('ad_plain');
  assert.equal(shape.columns.find((c) => c.name === 'updated_at')?.autoUpdated, true);
  assert.equal(shape.columns.find((c) => c.name === 'v')?.autoUpdated, false);
  assert.equal(shape.autoColumnsKnown, true, 'no triggers, so the declaration is the whole story');
});

test('MySQL: a table with a trigger is NOT knowable, because a trigger can touch anything', async () => {
  const shape = await my.introspect('ad_trig');
  assert.equal(shape.autoColumnsKnown, false);
});

test('Postgres: a table with no triggers is knowable', async () => {
  const shape = await pgA.introspect('ad_plain');
  assert.equal(shape.autoColumnsKnown, true);
  assert.equal(shape.columns.every((c) => !c.autoUpdated), true, 'Postgres has no declarative ON UPDATE');
});

// ---------------------------------------------------------------------
//  Statement timeouts: what each engine can and cannot bound.
//
//  Measured on MySQL 8.4.11 and PostgreSQL 16.14. These are pinned as tests
//  because the difference decides what else has to protect a write.
// ---------------------------------------------------------------------
test('Postgres: statement_timeout interrupts a slow WRITE, with an error', async () => {
  await pgA.applyLimits({ statementMs: 300, lockMs: 1000 });
  await pgA.begin();
  await assert.rejects(
    () => pgA.execute("UPDATE ad_plain SET v = v WHERE id = 1 AND pg_sleep(2) IS NOT NULL"),
    /statement timeout|canceling statement/i,
  );
  await pgA.rollback();
  await pgA.applyLimits({ statementMs: 30_000, lockMs: 10_000 });
});

test('MySQL: max_execution_time does NOT bound a write at all', async () => {
  // 🔴 Measured, not assumed: with the limit at 300ms an UPDATE that sleeps for
  // two seconds runs to completion. MySQL's max_execution_time applies to
  // read-only SELECTs only, so on this engine there is no statement timeout for
  // the very operation this library exists to make safe.
  //
  // What must protect a write here instead: innodb_lock_wait_timeout, and the
  // engine's own ceiling on how many rows a plan may touch. Neither is optional.
  await my.applyLimits({ statementMs: 300, lockMs: 5000 });
  await my.begin();
  const t0 = Date.now();
  await my.execute('UPDATE ad_plain SET v = v WHERE id = 1 AND SLEEP(2) = 0');
  const elapsed = Date.now() - t0;
  await my.rollback();
  await my.applyLimits({ statementMs: 30_000, lockMs: 10_000 });
  assert.ok(elapsed > 1500, `expected the write to run past its 300ms limit, took ${elapsed}ms`);
});

test('MySQL: even for reads, a cut-short statement can return success', async () => {
  // SELECT SLEEP() stops early when the limit fires but reports no error, so
  // "the query returned" does not mean "the query finished".
  await my.applyLimits({ statementMs: 300, lockMs: 5000 });
  const t0 = Date.now();
  await my.query('SELECT SLEEP(3)');
  const elapsed = Date.now() - t0;
  await my.applyLimits({ statementMs: 30_000, lockMs: 10_000 });
  assert.ok(elapsed < 1500, `expected the read to be cut short, took ${elapsed}ms`);
});

test('Postgres: the ordinary updated_at trigger makes auto columns unknowable', async () => {
  // This is the case that would otherwise reintroduce "no plan can ever be
  // confirmed": the trigger moves updated_at, the post-apply check sees a value
  // that does not match the plan, and every approval fails with a message about
  // concurrent modification. Detected honestly rather than guessed.
  const shape = await pgA.introspect('ad_trig');
  assert.equal(shape.autoColumnsKnown, false);
});

test('MySQL: the session agrees with the parser about what the text means', async () => {
  // The lexer reads MySQL with the server defaults: `"x"` is a string, and a
  // backslash escapes inside one. `ANSI_QUOTES` makes `"api_token"` an
  // *identifier* instead, so `denyIdentifiers` — the rule that stops a credential
  // column being read — never fires while MySQL happily returns the column.
  // `NO_BACKSLASH_ESCAPES` moves where a string literal ends, which is a
  // disagreement about how many statements the text contains.
  //
  // The adapter clears both when it opens the connection. Verified separately,
  // by hand, against a server whose GLOBAL sql_mode was set to ANSI_QUOTES: the
  // new session came back without it and kept STRICT_TRANS_TABLES. That is not
  // done here, because setting a GLOBAL leaves the server changed for every
  // later run if this process is killed between the set and the restore.
  const [row] = await my.query<{ m: string }>('SELECT @@SESSION.sql_mode AS m');
  const modes = String(row?.m ?? '').split(',');
  for (const bad of ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES', 'ANSI']) {
    assert.ok(!modes.includes(bad), `${bad} must not be active on a connection this library opened`);
  }
});

test('MySQL: a sql_mode changed underneath us is refused, not worked around', async () => {
  const probe = await MysqlAdapter.connect(MYSQL);
  try {
    await probe.selfCheck('read'); // clean to start with
    await probe.query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',ANSI_QUOTES')");
    await assert.rejects(
      () => probe.selfCheck('read'),
      (e: unknown) => e instanceof AdapterUnusable && /ANSI_QUOTES/.test((e as Error).message),
    );
  } finally {
    await probe.close();
  }
});
