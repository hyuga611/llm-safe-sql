import mysql from 'mysql2/promise';
import type { Adapter, ColumnShape, Row, Savepoint, TableShape } from '../adapter.js';
import { AdapterUnusable } from '../adapter.js';

export { AdapterUnusable };

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class MysqlAdapter implements Adapter {
  readonly dialect = 'mysql' as const;
  /** `max_execution_time` and `innodb_lock_wait_timeout` are both real here, so there is nothing to disclaim. */
  readonly limitations: readonly string[] = [];
  private readonly conn: mysql.Connection;
  private open = false;
  private savepoints = 0;

  private constructor(conn: mysql.Connection) {
    this.conn = conn;
  }

  static async connect(cfg: MysqlConfig): Promise<MysqlAdapter> {
    const conn = await mysql.createConnection({
      ...cfg,
      // Ask for FOUND_ROWS explicitly so affectedRows means rows *matched*.
      // mysql2 happens to enable it by default, but "happens to" is not a
      // guarantee: without it MySQL reports rows *changed* there instead, both
      // numbers become the same one, and the reconciliation that is supposed to
      // catch "rows changed that you were never shown" compares a value against
      // itself and can never fail. selfCheck proves the flag took effect.
      flags: ['+FOUND_ROWS'],
      multipleStatements: false,
      // BIGINT and DECIMAL must arrive as strings. A double cannot hold a 64-bit
      // id or a money value exactly, and the digits it loses are the ones that
      // differ — so a real change becomes invisible in the diff.
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      // Dates as text, for the same reason as BIGINT above. A JS Date holds
      // milliseconds; DATETIME(6) holds microseconds. Parsing to a Date discards
      // the last three digits, so a change confined to them is invisible in the
      // diff and rides along under whatever else the statement touches. It also
      // makes MySQL's zero date arrive as 1899-11-30, which is a value the
      // database does not contain being shown to somebody for approval.
      dateStrings: true,
    });
    return new MysqlAdapter(conn);
  }

  /**
   * Prove the four things this library's guarantees rest on, using a TEMPORARY
   * table so no user data is touched.
   */
  async selfCheck(): Promise<void> {
    // 1. Is the session sticky? A transaction-pooling proxy can hand our session
    //    to somebody else between statements, which would leave an open dry-run
    //    transaction — and its locks — in a stranger's hands.
    await this.conn.query("SET @llm_safe_sql_probe = 'sticky'");
    const [stick] = await this.conn.query<mysql.RowDataPacket[]>('SELECT @llm_safe_sql_probe AS v');
    if (stick[0]?.['v'] !== 'sticky') {
      throw new AdapterUnusable(
        'Session state does not survive between statements. A connection pooler in transaction mode ' +
          'cannot be used: a dry run could be left open on a connection handed to another caller.',
      );
    }

    let probe: mysql.RowDataPacket[];
    try {
      await this.conn.query('CREATE TEMPORARY TABLE llm_safe_sql_probe (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB');
    } catch (e) {
      throw new AdapterUnusable(
        'Cannot create a TEMPORARY table, so the environment cannot be verified. ' +
          `Grant CREATE TEMPORARY TABLES to this user. (${String(e)})`,
      );
    }

    try {
      await this.conn.query('INSERT INTO llm_safe_sql_probe VALUES (1, 10)');

      // 2. Does a rollback actually undo? A non-transactional engine accepts
      //    ROLLBACK, reports success, and changes nothing back — turning every
      //    dry run into an unannounced write.
      await this.conn.query('START TRANSACTION');
      await this.conn.query('UPDATE llm_safe_sql_probe SET v = 999 WHERE id = 1');
      await this.conn.query('ROLLBACK');
      [probe] = await this.conn.query<mysql.RowDataPacket[]>('SELECT v FROM llm_safe_sql_probe WHERE id = 1');
      if (Number(probe[0]?.['v']) !== 10) {
        throw new AdapterUnusable(
          'A rollback did not undo the change. This storage engine is not transactional, ' +
            'so a dry run here would write to production and stay written.',
        );
      }

      // 3. Does "rows affected" mean matched or changed? Every reconciliation in
      //    this library depends on the answer, and it is configurable.
      //    Both halves must be checked. An earlier version asserted only that a
      //    same-value UPDATE reports 0 changed, which is true whether or not
      //    FOUND_ROWS is on — so the number this adapter calls `rowsMatched` was
      //    never verified to be a count of matches at all.
      const [same] = await this.conn.query<mysql.ResultSetHeader>(
        'UPDATE llm_safe_sql_probe SET v = 10 WHERE v = 10',
      );
      if (same.changedRows !== 0) {
        throw new AdapterUnusable(
          `Expected changedRows to be 0 for a same-value UPDATE, got ${same.changedRows}. ` +
            'The reconciliation between "rows the database changed" and "rows we showed you" cannot be trusted here.',
        );
      }
      if (same.affectedRows !== 1) {
        throw new AdapterUnusable(
          `Expected affectedRows to be 1 (rows matched) for a same-value UPDATE, got ${same.affectedRows}. ` +
            'This connection reports rows changed instead of rows matched, so the two counts this library ' +
            'reconciles against each other are the same number and the check cannot fail.',
        );
      }
    } finally {
      await this.conn.query('DROP TEMPORARY TABLE IF EXISTS llm_safe_sql_probe').catch(() => {});
    }
  }

  /**
   * Bound the session in time.
   *
   * 🔴 A limitation worth knowing: MySQL's `max_execution_time` applies to
   * read-only SELECTs only. There is no statement timeout for an UPDATE or
   * DELETE on MySQL at all. The reference implementation's optimizer hint was
   * therefore doubly ineffective — ignored by other engines, and never applicable
   * to the writes it was meant to bound even on its own.
   *
   * What actually protects a write here is `innodb_lock_wait_timeout` plus the
   * engine's own row-count ceiling, so neither of those is optional on MySQL.
   */
  async applyLimits(limits: { statementMs: number; lockMs: number }): Promise<void> {
    await this.conn.query(`SET SESSION max_execution_time = ${Math.max(0, Math.floor(limits.statementMs))}`);
    // innodb_lock_wait_timeout is in whole seconds, minimum 1.
    const secs = Math.max(1, Math.ceil(limits.lockMs / 1000));
    await this.conn.query(`SET SESSION innodb_lock_wait_timeout = ${secs}`);
  }

  async introspect(table: string): Promise<TableShape> {
    const [cols] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table],
    );
    if (cols.length === 0) throw new AdapterUnusable(`Table \`${table}\` was not found.`);

    const [pk] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`,
      [table],
    );

    // A trigger can change any column on update, and nothing in the column
    // definitions says so. When one exists we cannot claim to know which columns
    // move by themselves — and a wrong "none" is indistinguishable, at approval
    // time, from someone else editing the row.
    const [trig] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM information_schema.TRIGGERS
        WHERE EVENT_OBJECT_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ?`,
      [table],
    );
    const triggerCount = Number(trig[0]?.['c'] ?? 0);

    // The storage engine is a per-table property, so a probe table proves nothing
    // about this one. MyISAM accepts a ROLLBACK, reports success, and keeps the
    // write — turning the dry run into a permanent change announced as harmless.
    const [eng] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT ENGINE FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    const engine = String(eng[0]?.['ENGINE'] ?? '').toUpperCase();
    const transactional = engine === 'INNODB' || engine === 'NDBCLUSTER' || engine === 'ROCKSDB';

    // Foreign keys pointing AT this table. With CASCADE or SET NULL, changing an
    // approved row also changes rows in another table that were never displayed.
    const [fks] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT k.TABLE_NAME AS child, r.CONSTRAINT_NAME AS name,
              r.DELETE_RULE AS del, r.UPDATE_RULE AS upd
         FROM information_schema.REFERENTIAL_CONSTRAINTS r
         JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA
          AND k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
        WHERE r.CONSTRAINT_SCHEMA = DATABASE() AND r.REFERENCED_TABLE_NAME = ?
        GROUP BY k.TABLE_NAME, r.CONSTRAINT_NAME, r.DELETE_RULE, r.UPDATE_RULE`,
      [table],
    );
    const inboundCascades = fks.map((f) => ({
      table: String(f['child']),
      constraint: String(f['name']),
      onDelete: String(f['del'] ?? 'NO ACTION').toUpperCase(),
      onUpdate: String(f['upd'] ?? 'NO ACTION').toUpperCase(),
    }));

    const columns: ColumnShape[] = cols.map((c) => ({
      name: String(c['COLUMN_NAME']),
      type: String(c['DATA_TYPE']),
      nullable: String(c['IS_NULLABLE']).toUpperCase() === 'YES',
      autoUpdated: /on update/i.test(String(c['EXTRA'] ?? '')),
    }));

    return {
      table,
      columns,
      primaryKey: pk.map((r) => String(r['COLUMN_NAME'])),
      autoColumnsKnown: triggerCount === 0,
      transactional,
      inboundCascades,
      triggerCount,
    };
  }

  async begin(isolation: 'default' | 'repeatable-read' = 'default'): Promise<void> {
    // MySQL's default already is REPEATABLE READ, so the request is a no-op here;
    // it is set explicitly anyway so a server configured otherwise still gives the
    // dry run one consistent view.
    if (isolation === 'repeatable-read') {
      await this.conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    }
    await this.conn.query('START TRANSACTION');
    this.open = true;
  }

  async commit(): Promise<void> {
    await this.conn.query('COMMIT');
    this.open = false;
  }

  async rollback(): Promise<void> {
    await this.conn.query('ROLLBACK');
    this.open = false;
  }

  inTransaction(): boolean {
    return this.open;
  }

  async savepoint(): Promise<Savepoint> {
    const name = `llm_safe_sql_sp_${++this.savepoints}`;
    await this.conn.query(`SAVEPOINT ${name}`);
    const conn = this.conn;
    return {
      name,
      async rollback() {
        await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
      },
      async release() {
        await conn.query(`RELEASE SAVEPOINT ${name}`);
      },
    };
  }

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(sql, params as unknown[]);
    return rows as unknown as T[];
  }

  async execute(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rowsMatched: number; rowsChanged: number; changedIsMeaningful: boolean }> {
    const [res] = await this.conn.query<mysql.ResultSetHeader>(sql, params as unknown[]);
    return {
      rowsMatched: res.affectedRows,
      // Defined for UPDATE. DELETE reports 0 here and its real count in
      // affectedRows, so callers must pick the right one for the statement.
      rowsChanged: res.changedRows,
      changedIsMeaningful: true,
    };
  }

  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }

  rowLockClause(): string {
    return ' FOR UPDATE';
  }

  async close(): Promise<void> {
    await this.conn.end();
  }
}
