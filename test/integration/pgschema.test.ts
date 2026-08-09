/**
 * Which table `orders` means.
 *
 * PostgreSQL resolves an unqualified name through `search_path`, whose default is
 * `"$user", public` — and `$user` expands per connection. This library recommends
 * giving the plan and the apply different database roles, so that default made
 * "the table we measured" and "the table we write" two different questions with
 * two different answers, silently.
 *
 * Measured on PostgreSQL 16 before the fix: with a schema named after the apply
 * role holding a table of the same name, the planner measured `public.sp_orders`
 * and built a card from it; the apply role ran the identical statement and wrote
 * `sp_applier.sp_orders`. The approved change did not happen, an unapproved one
 * did, and nothing anywhere reported an error.
 *
 * A role that can create a schema in its own database can arrange this for
 * itself, which is the ordinary shape of a search-path attack. The adapter now
 * pins the path on every connection it opens.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAdapter } from '../../src/adapters/postgres.js';
import { AdapterUnusable } from '../../src/adapter.js';

const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };
const ROLE = 'sp_applier';

let admin: PostgresAdapter;
const opened: PostgresAdapter[] = [];

/** Setup and teardown are the same statements: a killed run must not poison the next one. */
async function scrub(): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS ${ROLE} CASCADE`).catch(() => {});
  await admin.query(`REASSIGN OWNED BY ${ROLE} TO postgres`).catch(() => {});
  await admin.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await admin.query('DROP TABLE IF EXISTS public.sp_orders').catch(() => {});
}

before(async () => {
  admin = await PostgresAdapter.connect(PG);
  opened.push(admin);
  await scrub();

  await admin.query('CREATE TABLE public.sp_orders (id INT PRIMARY KEY, qty INT NOT NULL)');
  await admin.query('INSERT INTO public.sp_orders VALUES (1, 10)');
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'probe'`);
  await admin.query(`GRANT CONNECT ON DATABASE llmsafesql TO ${ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.sp_orders TO ${ROLE}`);

  // The decoy: a schema named after the role, first in its default search_path,
  // holding a table with the same name as the real one.
  await admin.query(`CREATE SCHEMA ${ROLE} AUTHORIZATION ${ROLE}`);
  await admin.query(`CREATE TABLE ${ROLE}.sp_orders (id INT PRIMARY KEY, qty INT NOT NULL)`);
  await admin.query(`INSERT INTO ${ROLE}.sp_orders VALUES (1, 999)`);
  await admin.query(`ALTER TABLE ${ROLE}.sp_orders OWNER TO ${ROLE}`);
});

after(async () => {
  for (const a of opened.slice(1)) await a.close().catch(() => {});
  await scrub();
  await admin.close().catch(() => {});
});

async function asRole(): Promise<PostgresAdapter> {
  const a = await PostgresAdapter.connect({ ...PG, user: ROLE, password: 'probe' });
  opened.push(a);
  return a;
}

test('a role with a schema of its own still resolves the configured schema', async () => {
  const a = await asRole();
  const where = await a.query<{ r: string }>("SELECT to_regclass('sp_orders')::text AS r");
  assert.equal(where[0]?.r, 'sp_orders');
  const which = await a.query<{ s: string }>('SELECT current_schema() AS s');
  assert.equal(which[0]?.s, 'public', 'the decoy schema must not be first');
});

test('the write lands in the table the planner measured', async () => {
  const a = await asRole();
  await a.query('UPDATE sp_orders SET qty = 42 WHERE id = 1');

  const real = await admin.query<{ qty: number }>('SELECT qty FROM public.sp_orders WHERE id = 1');
  const decoy = await admin.query<{ qty: number }>(`SELECT qty FROM ${ROLE}.sp_orders WHERE id = 1`);
  assert.equal(Number(real[0]?.qty), 42, 'the write must reach the table that was measured');
  assert.equal(Number(decoy[0]?.qty), 999, 'and must not reach the one shadowing it');

  await admin.query('UPDATE public.sp_orders SET qty = 10 WHERE id = 1');
});

test('a configured schema is honoured, and is part of the connection identity', async () => {
  const a = await PostgresAdapter.connect({ ...PG, user: ROLE, password: 'probe', schema: ROLE });
  opened.push(a);
  const which = await a.query<{ s: string }>('SELECT current_schema() AS s');
  assert.equal(which[0]?.s, ROLE);
  const seen = await a.query<{ qty: number }>('SELECT qty FROM sp_orders WHERE id = 1');
  assert.equal(Number(seen[0]?.qty), 999, 'this connection really is looking somewhere else');
});

test('a session whose search_path is changed underneath us is refused', async () => {
  // Pinning at connect time is not enough on its own: whatever could reset it
  // between statements — a pooler, an `ALTER ROLE ... SET search_path` picked up
  // on reconnect — would do it silently, and every unqualified name in every
  // statement would then mean a different table from the one measured.
  const a = await asRole();
  await a.query(`SET search_path TO ${ROLE}`);
  await assert.rejects(
    () => a.selfCheck('read'),
    (e: unknown) => e instanceof AdapterUnusable && /resolves unqualified names/.test((e as Error).message),
  );
});
