/**
 * llm-safe-sql — let a model propose a write, then prove what it does.
 *
 * The shape of a session:
 *
 * ```ts
 * const engine  = new Engine({ adapter: planning, policy });
 * const applier = new Applier({ adapter: writing, policy, store });
 *
 * const plan   = await engine.plan("UPDATE orders SET status='shipped' WHERE id=42");
 * const stored = await applier.record(plan, 'assistant');
 * // …a human reads stored.plan.rows and stored.plan.impact, then:
 * await applier.approve(stored.id, 'alice');
 * await applier.apply(stored.id, 'alice');
 * ```
 *
 * `plan()` runs the statement for real inside a transaction, measures the actual
 * before/after values, and always rolls back. Nothing else in this package makes
 * a claim about what a statement will do — the claim is a measurement.
 *
 * Two adapters, deliberately: the engine and the applier should hold different
 * database credentials, so that a model with access to the planning path cannot
 * write even if everything above it is compromised.
 */

export { Engine, PlanRefused } from './engine.js';
export type { Plan, PlanRow, EngineOptions, RefusalCode } from './engine.js';

export { Applier, ApplyRefused } from './apply.js';
export type { ApplyResult, ApplierOptions, ApplyCode } from './apply.js';

export { Policy, PolicyViolation } from './policy.js';
export type { PolicyOptions, PolicyCode } from './policy.js';

export { Refusal } from './refusal.js';

export { normalize, Rejected, stripComments } from './normalize.js';
export type { NormalizeOptions, NormalizeResult, RejectCode, StatementKind, Dialect } from './normalize.js';

export {
  MemoryPlanStore,
  SqlPlanStore,
  StoreUnavailable,
  planStoreDdl,
  recordPlan,
  newPlanId,
  nowIso,
} from './store.js';
export type {
  PlanStore,
  StoredPlan,
  PlanStatus,
  AuditEntry,
  AuditPhase,
  SqlPlanStoreOptions,
} from './store.js';

// The adapters are NOT re-exported here, and that is deliberate: importing them
// from the package root would load both drivers, so a Postgres-only install
// would crash on `import '@hyuga/llm-safe-sql'` because mysql2 is not there.
// Import the one you use:
//
//   import { PostgresAdapter } from '@hyuga/llm-safe-sql/postgres';
//   import { MysqlAdapter }    from '@hyuga/llm-safe-sql/mysql';
//
// Or let the configuration pick, which loads the driver on demand:
export { connectAdapter, loadConfig, parseConfig, policyOf, ConfigError } from './config.js';
export type {
  Config,
  ConnectionConfig,
  ServerConnectionConfig,
  SqliteConnectionConfig,
  LimitsConfig,
} from './config.js';
export { isSqliteConnection } from './config.js';
export { openReadSession, openAdminSession } from './session.js';
export type { ReadSession, AdminSession } from './session.js';
export { planCard, planBody } from './card.js';
export { VERSION } from './version.js';

export type { Adapter, TableShape, ColumnShape, InboundCascade, Row, Savepoint } from './adapter.js';

export { planDigest } from './digest.js';
export { encodePlan, decodePlan } from './serialize.js';

// Lexer and statement helpers are exported because writing an adapter for
// another engine needs them, and because a caller who wants to show a human what
// the library saw should not have to reimplement it.
export { lex, splitStatements, identifiers, SqlLexError } from './lexer.js';
export type { Token, TokenKind } from './lexer.js';
export { tableRefs, setColumns, whereClause } from './statement.js';
export { canonical, sameValue } from './compare.js';
