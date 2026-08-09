import pg from 'pg';
import type { Adapter, ColumnShape, Row, Savepoint, TableShape } from '../adapter.js';
import { AdapterUnusable } from './mysql.js';

export { AdapterUnusable };

export interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Date and time OIDs, which this adapter takes as text rather than as `Date`.
 *
 * `timestamp(6)` holds microseconds and a JS `Date` holds milliseconds, so the
 * default parser silently drops the last three digits — and a change confined to
 * them then never appears in the diff. The parser is overridden per client rather
 * than through `pg.types.setTypeParser`, which is global to the module and would
 * change how every other query in the host application reads its timestamps.
 */
const TEXTUAL_OIDS = new Set([
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1266, // timetz
]);

const asText = (v: string): string => v;

const TYPES = {
  getTypeParser(oid: number, format?: unknown): unknown {
    if (TEXTUAL_OIDS.has(oid)) return asText;
    return (pg.types.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format);
  },
};

export class PostgresAdapter implements Adapter {
  readonly dialect = 'postgres' as const;
  /** `statement_timeout` and `lock_timeout` are both real here, so there is nothing to disclaim. */
  readonly limitations: readonly string[] = [];
  private readonly client: pg.Client;
  private open = false;
  private savepoints = 0;

  private constructor(client: pg.Client) {
    this.client = client;
  }

  static async connect(cfg: PostgresConfig): Promise<PostgresAdapter> {
    const client = new pg.Client({ ...cfg, types: TYPES as never });
    await client.connect();
    return new PostgresAdapter(client);
  }

  async selfCheck(): Promise<void> {
    // 1. Session stickiness. pgbouncer in transaction mode will fail this, and it
    //    must: it can hand our session to another caller mid-dry-run.
    await this.client.query("SET llm_safe_sql.probe = 'sticky'");
    const stick = await this.client.query<{ v: string }>("SELECT current_setting('llm_safe_sql.probe', true) AS v");
    if (stick.rows[0]?.v !== 'sticky') {
      throw new AdapterUnusable(
        'Session state does not survive between statements. A connection pooler in transaction mode ' +
          'cannot be used: a dry run could be left open on a connection handed to another caller.',
      );
    }

    try {
      await this.client.query('CREATE TEMP TABLE llm_safe_sql_probe (id INT PRIMARY KEY, v INT NOT NULL)');
    } catch (e) {
      throw new AdapterUnusable(
        `Cannot create a temporary table, so the environment cannot be verified. (${String(e)})`,
      );
    }

    try {
      await this.client.query('INSERT INTO llm_safe_sql_probe VALUES (1, 10)');

      // 2. Does a rollback really undo?
      await this.client.query('BEGIN');
      await this.client.query('UPDATE llm_safe_sql_probe SET v = 999 WHERE id = 1');
      await this.client.query('ROLLBACK');
      const back = await this.client.query<{ v: number }>('SELECT v FROM llm_safe_sql_probe WHERE id = 1');
      if (Number(back.rows[0]?.v) !== 10) {
        throw new AdapterUnusable('A rollback did not undo the change; this connection is not transactional.');
      }

      // 3. Confirm the counting model. Postgres rewrites a row even when the new
      //    value equals the old one, so rowCount cannot answer "did anything
      //    really change" and the engine must compare snapshots instead. We check
      //    the assumption rather than trusting it, because building the
      //    reconciliation on the wrong model is silent.
      const same = await this.client.query('UPDATE llm_safe_sql_probe SET v = 10 WHERE v = 10');
      if (same.rowCount !== 1) {
        throw new AdapterUnusable(
          `Expected a same-value UPDATE to report 1 row, got ${String(same.rowCount)}. ` +
            'Row counting does not behave as this adapter assumes.',
        );
      }
    } finally {
      await this.client.query('DROP TABLE IF EXISTS llm_safe_sql_probe').catch(() => {});
    }
  }

  /** Both limits are real session settings here, and both apply to writes. */
  async applyLimits(limits: { statementMs: number; lockMs: number }): Promise<void> {
    await this.client.query(`SET statement_timeout = ${Math.max(0, Math.floor(limits.statementMs))}`);
    await this.client.query(`SET lock_timeout = ${Math.max(0, Math.floor(limits.lockMs))}`);
  }

  async introspect(table: string): Promise<TableShape> {
    const cols = await this.client.query<{ name: string; type: string; nullable: boolean }>(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable
         FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [table],
    );
    if (cols.rows.length === 0) throw new AdapterUnusable(`Table "${table}" was not found.`);

    const pk = await this.client.query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY k.ord`,
      [table],
    );

    // Postgres has no declarative ON UPDATE. The conventional way to maintain an
    // updated_at column is a BEFORE UPDATE trigger — which means the column
    // definitions cannot tell us what moves by itself.
    //
    // This is precisely the case that would otherwise reintroduce "no plan can
    // ever be confirmed": the trigger bumps updated_at between the dry run and
    // the apply, the post-apply comparison sees a value that differs from the
    // plan, and every approval fails citing concurrent modification. So when a
    // trigger exists we report that we do not know, and let the caller declare
    // the columns instead of guessing "none".
    const trig = await this.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`,
      [table],
    );
    const triggerCount = Number(trig.rows[0]?.c ?? 0);

    // Foreign keys pointing AT this table. With CASCADE or SET NULL, changing an
    // approved row also changes rows in another table that were never displayed —
    // and for DELETE that is irreversible.
    const fks = await this.client.query<{ child: string; name: string; del: string; upd: string }>(
      `SELECT c.conrelid::regclass::text AS child,
              c.conname                  AS name,
              c.confdeltype              AS del,
              c.confupdtype              AS upd
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confrelid = $1::regclass`,
      [table],
    );
    const RULE: Record<string, string> = {
      a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT',
    };
    const inboundCascades = fks.rows.map((f) => ({
      table: f.child,
      constraint: f.name,
      onDelete: RULE[f.del] ?? 'NO ACTION',
      onUpdate: RULE[f.upd] ?? 'NO ACTION',
    }));

    // Ordinary and unlogged tables are transactional here. A foreign table is not
    // ours to reason about: the remote side has its own rules about rollback.
    const rel = await this.client.query<{ kind: string }>(
      `SELECT relkind AS kind FROM pg_class WHERE oid = $1::regclass`,
      [table],
    );
    const transactional = ['r', 'p', 'm'].includes(String(rel.rows[0]?.kind ?? ''));

    const columns: ColumnShape[] = cols.rows.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      autoUpdated: false, // never declarative on this engine
    }));

    return {
      table,
      columns,
      primaryKey: pk.rows.map((r) => r.attname),
      autoColumnsKnown: triggerCount === 0,
      transactional,
      inboundCascades,
      triggerCount,
    };
  }

  async begin(isolation: 'default' | 'repeatable-read' = 'default'): Promise<void> {
    // Postgres defaults to READ COMMITTED, under which the count and the snapshot
    // are two different views of the database: a concurrent commit between them
    // shows up in the diff as an effect of the statement being planned. The dry
    // run therefore asks for REPEATABLE READ explicitly.
    await this.client.query(
      isolation === 'repeatable-read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN',
    );
    this.open = true;
  }

  async commit(): Promise<void> {
    await this.client.query('COMMIT');
    this.open = false;
  }

  async rollback(): Promise<void> {
    await this.client.query('ROLLBACK');
    this.open = false;
  }

  inTransaction(): boolean {
    return this.open;
  }

  async savepoint(): Promise<Savepoint> {
    const name = `llm_safe_sql_sp_${++this.savepoints}`;
    await this.client.query(`SAVEPOINT ${name}`);
    const client = this.client;
    return {
      name,
      async rollback() {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      },
      async release() {
        await client.query(`RELEASE SAVEPOINT ${name}`);
      },
    };
  }

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params as unknown[]);
    return res.rows as T[];
  }

  async execute(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rowsMatched: number; rowsChanged: number; changedIsMeaningful: boolean }> {
    const res = await this.client.query(sql, params as unknown[]);
    const n = res.rowCount ?? 0;
    return {
      rowsMatched: n,
      rowsChanged: n,
      // A same-value UPDATE still rewrites the row and still counts, so this
      // number cannot distinguish "changed" from "matched". Only the before/after
      // snapshots can.
      changedIsMeaningful: false,
    };
  }

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  rowLockClause(): string {
    return ' FOR UPDATE';
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
