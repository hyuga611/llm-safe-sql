import type { Adapter } from './adapter.js';
import { Applier } from './apply.js';
import { connectAdapter, connectionIdentity, policyOf, type Config } from './config.js';
import { Engine } from './engine.js';
import type { Policy } from './policy.js';
import { SqlPlanStore } from './store.js';

/**
 * Wiring a configuration into working objects.
 *
 * Note that every session gets its own connection, even when two of them are
 * configured identically. That is not wasteful, it is the point: the dry run has
 * to own the transaction it rolls back, and the audit record has to survive the
 * apply that failed. Both of those stop being true the moment two roles share a
 * session, and sharing is exactly what a connection pool would quietly do.
 */

export interface ReadSession {
  readonly cfg: Config;
  readonly policy: Policy;
  readonly engine: Engine;
  readonly store: SqlPlanStore;
  close(): Promise<void>;
}

export interface AdminSession extends ReadSession {
  readonly applier: Applier;
}

function engineOptions(cfg: Config, adapter: Adapter, policy: Policy): ConstructorParameters<typeof Engine>[0] {
  return {
    adapter,
    policy,
    ...(cfg.limits === undefined ? {} : { limits: cfg.limits }),
    ...(cfg.autoColumns === undefined ? {} : { autoColumns: cfg.autoColumns }),
  };
}

function storeOf(cfg: Config, adapter: Adapter): SqlPlanStore {
  return new SqlPlanStore({
    adapter,
    ...(cfg.policy.planTable === undefined ? {} : { planTable: cfg.policy.planTable }),
    ...(cfg.policy.auditTable === undefined ? {} : { auditTable: cfg.policy.auditTable }),
  });
}

/**
 * Everything needed to read and to propose — and deliberately nothing that can
 * commit. This is what the MCP server is given.
 */
export async function openReadSession(cfg: Config): Promise<ReadSession> {
  const planning = await connectAdapter(cfg.dialect, cfg.connection);
  const opened: Adapter[] = [planning];
  const closeAll = async (): Promise<void> => {
    for (const a of opened) await a.close().catch(() => {});
  };

  let bookkeeping: Adapter;
  let reading: Adapter | undefined;
  try {
    bookkeeping = await connectAdapter(cfg.dialect, cfg.storeConnection ?? cfg.connection);
    opened.push(bookkeeping);
    // A separate connection only when the credential actually differs. Opening a
    // second session with the same identity would look like a boundary in the
    // process list and be none — and `Engine.readIsSeparate` would then report a
    // separation that does not exist, which is worse than not having one.
    if (
      cfg.readConnection !== undefined &&
      connectionIdentity(cfg.readConnection) !== connectionIdentity(cfg.connection)
    ) {
      reading = await connectAdapter(cfg.dialect, cfg.readConnection);
      opened.push(reading);
    }
  } catch (e) {
    await closeAll();
    throw e;
  }

  const policy = policyOf(cfg);
  return {
    cfg,
    policy,
    engine: new Engine({
      ...engineOptions(cfg, planning, policy),
      ...(reading === undefined ? {} : { readAdapter: reading }),
    }),
    store: storeOf(cfg, bookkeeping),
    close: closeAll,
  };
}

/** The same, plus the connection that may actually write. This is what the CLI is given. */
export async function openAdminSession(cfg: Config): Promise<AdminSession> {
  const base = await openReadSession(cfg);
  let writing: Adapter;
  try {
    writing = await connectAdapter(cfg.dialect, cfg.applyConnection ?? cfg.connection);
  } catch (e) {
    await base.close();
    throw e;
  }
  const applier = new Applier({
    adapter: writing,
    policy: base.policy,
    store: base.store,
    ...(cfg.limits === undefined
      ? {}
      : {
          limits: {
            ...(cfg.limits.statementMs === undefined ? {} : { statementMs: cfg.limits.statementMs }),
            ...(cfg.limits.lockMs === undefined ? {} : { lockMs: cfg.limits.lockMs }),
          },
        }),
  });
  return {
    ...base,
    applier,
    async close() {
      await writing.close().catch(() => {});
      await base.close();
    },
  };
}
