import { randomUUID } from 'node:crypto';
import { planDigest } from './digest.js';
import type { Adapter, Row } from './adapter.js';
import type { Plan } from './engine.js';
import type { Dialect } from './lexer.js';
import { placeholder } from './keys.js';
import { decodePlan, encodePlan } from './serialize.js';
import { Refusal } from './refusal.js';

/**
 * Where plans wait for a human.
 *
 * The gap between "the model proposed this" and "a person agreed to it" is the
 * whole product, and that gap is usually measured in minutes and crosses a
 * process boundary — a chat client proposes, a web page approves, a worker
 * applies. So the plan has to be somewhere durable, and three properties of that
 * place are load-bearing:
 *
 *  1. **Only one apply can win.** The transition out of `approved` is a
 *     conditional update that must report exactly one row. Checking the status
 *     and then updating it is the same bug as check-then-write everywhere else;
 *     with a retrying HTTP client it is not a rare race, it is the common case.
 *  2. **The record survives the apply failing.** Which means the store must not
 *     share a connection with the apply, or the evidence rolls back with it.
 *  3. **Nothing here is reachable through this library.** Policy refuses these
 *     two table names unconditionally: a model that can write the plan table can
 *     approve its own writes, and one that can write the audit table can erase
 *     the record that it did.
 */

export type PlanStatus = 'pending' | 'approved' | 'applying' | 'applied' | 'failed' | 'cancelled';

export type AuditPhase = 'planned' | 'approved' | 'cancelled' | 'attempting' | 'applied' | 'failed';

export interface StoredPlan {
  readonly id: string;
  readonly plan: Plan;
  readonly digest: string;
  readonly status: PlanStatus;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditEntry {
  readonly planId: string;
  readonly phase: AuditPhase;
  readonly actor: string;
  readonly detail: string;
  readonly at: string;
}

/** The bookkeeping is unavailable, so nothing may be applied. */
export class StoreUnavailable extends Refusal {
  constructor(message: string) {
    super('STORE_UNAVAILABLE', message);
  }
}

export interface PlanStore {
  put(record: StoredPlan): Promise<void>;
  get(id: string): Promise<StoredPlan | undefined>;
  /**
   * Move a plan between states, but only from one of `from`.
   *
   * Returns true only when exactly one row moved. Anything else — zero rows, or
   * more than one — must be treated as "somebody else got there first".
   */
  transition(id: string, from: readonly PlanStatus[], to: PlanStatus, approvedBy?: string): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
  list(opts?: { status?: PlanStatus; limit?: number }): Promise<StoredPlan[]>;
}

/**
 * Save a fresh plan for a human to look at. Nothing is written to their data.
 *
 * This is a free function rather than a method on {@link Applier} so that a
 * surface which must not be able to apply — the MCP server — never has to hold
 * an object that can. Structure beats discipline for a rule this important.
 */
export async function recordPlan(store: PlanStore, plan: Plan, createdBy: string): Promise<StoredPlan> {
  const at = nowIso();
  const rec: StoredPlan = {
    id: newPlanId(),
    plan,
    digest: planDigest(plan),
    status: 'pending',
    createdBy,
    approvedBy: null,
    createdAt: at,
    updatedAt: at,
  };
  await store.put(rec);
  await store.audit({
    planId: rec.id,
    phase: 'planned',
    actor: createdBy,
    detail: `${plan.op} on ${plan.table}, ${plan.rows.length} row(s): ${plan.sql}`,
    at,
  });
  return rec;
}

export function newPlanId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * In-process store. **For tests and single-process demos only.**
 *
 * It cannot do the one job the durable store exists for: two processes each hold
 * their own copy, so both can win the race to apply the same plan, and the audit
 * trail disappears when the process does. Using it in production would leave
 * every promise in this file's header unkept, silently.
 */
export class MemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, StoredPlan>();
  readonly entries: AuditEntry[] = [];
  /** Test seam: makes the next audit write fail, to exercise the A7 path. */
  failNextAudit = false;

  async put(record: StoredPlan): Promise<void> {
    this.plans.set(record.id, record);
  }

  async get(id: string): Promise<StoredPlan | undefined> {
    return this.plans.get(id);
  }

  async transition(id: string, from: readonly PlanStatus[], to: PlanStatus, approvedBy?: string): Promise<boolean> {
    const cur = this.plans.get(id);
    if (cur === undefined || !from.includes(cur.status)) return false;
    this.plans.set(id, {
      ...cur,
      status: to,
      updatedAt: nowIso(),
      approvedBy: approvedBy ?? cur.approvedBy,
    });
    return true;
  }

  async audit(entry: AuditEntry): Promise<void> {
    if (this.failNextAudit) {
      this.failNextAudit = false;
      throw new StoreUnavailable('audit sink unavailable (test seam)');
    }
    this.entries.push(entry);
  }

  async list(opts: { status?: PlanStatus; limit?: number } = {}): Promise<StoredPlan[]> {
    const all = [...this.plans.values()]
      .filter((p) => opts.status === undefined || p.status === opts.status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return all.slice(0, opts.limit ?? 50);
  }
}

export interface SqlPlanStoreOptions {
  /**
   * A connection of its own — **not** the one the apply runs on.
   *
   * Sharing it would put the audit write inside the transaction being audited,
   * so a failed apply would roll back the record of having tried. The whole
   * point of the record is that it outlives the failure.
   */
  readonly adapter: Adapter;
  readonly planTable?: string;
  readonly auditTable?: string;
}

/**
 * Two ordinary tables. Timestamps are stored as ISO-8601 text on purpose:
 * portable, sortable, and free of the timezone conversions that make
 * `DATETIME` on one engine disagree with `timestamptz` on the other.
 */
export function planStoreDdl(
  dialect: Dialect,
  planTable = 'llm_safe_sql_plans',
  auditTable = 'llm_safe_sql_audit',
): string[] {
  if (dialect === 'mysql') {
    return [
      `CREATE TABLE IF NOT EXISTS \`${planTable}\` (
         id          VARCHAR(64)  NOT NULL,
         status      VARCHAR(16)  NOT NULL,
         digest      CHAR(64)     NOT NULL,
         body        LONGTEXT     NOT NULL,
         created_by  VARCHAR(255) NOT NULL,
         approved_by VARCHAR(255) NULL,
         created_at  VARCHAR(32)  NOT NULL,
         updated_at  VARCHAR(32)  NOT NULL,
         PRIMARY KEY (id),
         KEY ix_${planTable}_status (status)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`${auditTable}\` (
         id        BIGINT       NOT NULL AUTO_INCREMENT,
         plan_id   VARCHAR(64)  NOT NULL,
         phase     VARCHAR(16)  NOT NULL,
         actor     VARCHAR(255) NOT NULL,
         detail    LONGTEXT     NOT NULL,
         logged_at VARCHAR(32)  NOT NULL,
         PRIMARY KEY (id),
         KEY ix_${auditTable}_plan (plan_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
  }
  // Postgres and SQLite differ in exactly one column: the audit table's
  // auto-incrementing key. Everything else is text, which is the point.
  const autoKey = dialect === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'bigserial PRIMARY KEY';

  return [
    `CREATE TABLE IF NOT EXISTS "${planTable}" (
       id          text PRIMARY KEY,
       status      text NOT NULL,
       digest      text NOT NULL,
       body        text NOT NULL,
       created_by  text NOT NULL,
       approved_by text,
       created_at  text NOT NULL,
       updated_at  text NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS ix_${planTable}_status ON "${planTable}" (status)`,
    `CREATE TABLE IF NOT EXISTS "${auditTable}" (
       id        ${autoKey},
       plan_id   text NOT NULL,
       phase     text NOT NULL,
       actor     text NOT NULL,
       detail    text NOT NULL,
       logged_at text NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS ix_${auditTable}_plan ON "${auditTable}" (plan_id)`,
  ];
}

export class SqlPlanStore implements PlanStore {
  readonly adapter: Adapter;
  readonly planTable: string;
  readonly auditTable: string;

  constructor(opts: SqlPlanStoreOptions) {
    this.adapter = opts.adapter;
    this.planTable = opts.planTable ?? 'llm_safe_sql_plans';
    this.auditTable = opts.auditTable ?? 'llm_safe_sql_audit';
  }

  private get dialect(): Dialect {
    return this.adapter.dialect;
  }

  private p(n: number): string {
    return placeholder(this.dialect, n);
  }

  private q(name: string): string {
    return this.adapter.quoteIdent(name);
  }

  /** Create the tables if they are missing. Run once, at deployment, by a human. */
  async migrate(): Promise<void> {
    for (const sql of planStoreDdl(this.dialect, this.planTable, this.auditTable)) {
      await this.adapter.execute(sql);
    }
  }

  async put(record: StoredPlan): Promise<void> {
    await this.adapter.execute(
      `INSERT INTO ${this.q(this.planTable)}
         (id, status, digest, body, created_by, approved_by, created_at, updated_at)
       VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)})`,
      [
        record.id,
        record.status,
        record.digest,
        encodePlan(record.plan),
        record.createdBy,
        record.approvedBy,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(id: string): Promise<StoredPlan | undefined> {
    const rows = await this.adapter.query<Row>(
      `SELECT id, status, digest, body, created_by, approved_by, created_at, updated_at
         FROM ${this.q(this.planTable)} WHERE id = ${this.p(1)}`,
      [id],
    );
    const r = rows[0];
    return r === undefined ? undefined : this.hydrate(r);
  }

  async transition(id: string, from: readonly PlanStatus[], to: PlanStatus, approvedBy?: string): Promise<boolean> {
    const params: unknown[] = [to, nowIso(), approvedBy ?? null, id, ...from];
    const inList = from.map((_, i) => this.p(5 + i)).join(', ');
    const res = await this.adapter.execute(
      `UPDATE ${this.q(this.planTable)}
          SET status = ${this.p(1)},
              updated_at = ${this.p(2)},
              approved_by = COALESCE(${this.p(3)}, approved_by)
        WHERE id = ${this.p(4)} AND status IN (${inList})`,
      params,
    );
    // Every transition changes `status`, so the row is different afterwards
    // whichever of "matched" or "changed" this driver reports.
    return res.rowsMatched === 1;
  }

  async audit(entry: AuditEntry): Promise<void> {
    await this.adapter.execute(
      `INSERT INTO ${this.q(this.auditTable)} (plan_id, phase, actor, detail, logged_at)
       VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)})`,
      [entry.planId, entry.phase, entry.actor, entry.detail, entry.at],
    );
  }

  async list(opts: { status?: PlanStatus; limit?: number } = {}): Promise<StoredPlan[]> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
    const where = opts.status === undefined ? '' : `WHERE status = ${this.p(1)}`;
    const params = opts.status === undefined ? [] : [opts.status];
    const rows = await this.adapter.query<Row>(
      `SELECT id, status, digest, body, created_by, approved_by, created_at, updated_at
         FROM ${this.q(this.planTable)} ${where}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
      params,
    );
    return rows.map((r) => this.hydrate(r));
  }

  private hydrate(r: Row): StoredPlan {
    return {
      id: String(r['id']),
      plan: decodePlan(String(r['body'])),
      digest: String(r['digest']),
      status: String(r['status']) as PlanStatus,
      createdBy: String(r['created_by'] ?? ''),
      approvedBy: r['approved_by'] === null || r['approved_by'] === undefined ? null : String(r['approved_by']),
      createdAt: String(r['created_at'] ?? ''),
      updatedAt: String(r['updated_at'] ?? ''),
    };
  }
}
