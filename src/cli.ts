#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { planCard } from './card.js';
import { connectionIdentity, loadConfig, type Config, type ConnectionConfig } from './config.js';
import { Refusal } from './refusal.js';
import { openAdminSession, type AdminSession } from './session.js';
import { recordPlan, type PlanStatus } from './store.js';
import { displayReplacer } from './serialize.js';
import { VERSION } from './version.js';

/**
 * `llm-safe-sql` — the human-facing half.
 *
 * This is where approving and applying live, and it is a separate program from
 * the MCP server for a reason that is worth stating plainly: the model has no
 * path to this code. Not a guarded path — no path. The two halves can even run
 * as different operating-system users against different database accounts, and
 * then the separation survives a bug in this library, which is the only kind of
 * separation worth relying on.
 */

const USAGE = `llm-safe-sql ${VERSION} — propose database changes, approve them, apply them.

  llm-safe-sql init                       Print a starter configuration file
  llm-safe-sql check                      Verify the environment and the connections
  llm-safe-sql migrate                    Create the plan and audit tables
  llm-safe-sql read  "<SELECT ...>"       Run a bounded, allowlisted read
  llm-safe-sql plan  "<UPDATE ...>"       Measure a change and save it for approval
  llm-safe-sql list  [--status pending]   Plans waiting, or already dealt with
  llm-safe-sql show <id>                  The confirmation card for one plan
  llm-safe-sql approve <id> --as <who>    Record that a person agreed to it
  llm-safe-sql apply <id> --as <who>      Carry out an approved plan
  llm-safe-sql cancel <id> --as <who> [--reason "..."]

Options
  --config <path>   Defaults to $LLM_SAFE_SQL_CONFIG, then ./llm-safe-sql.config.json
  --as <who>        Who is acting. Defaults to $LLM_SAFE_SQL_ACTOR, then $USER
  --yes             Skip the interactive confirmation (required when not a terminal)
  --limit <n>       Row cap for 'read' and 'list'

Exit codes: 0 success, 1 refused or failed, 2 wrong usage.
`;

const TEMPLATE = `{
  "//dialect": "mysql | postgres | sqlite. For sqlite, replace connection with {\\"file\\": \\"app.db\\"} — no server and no password. Node 24+.",
  "dialect": "postgres",

  "connection": {
    "host": "127.0.0.1",
    "port": 5432,
    "user": "app_readonly_planner",
    "password": "\${LLM_SAFE_SQL_PASSWORD}",
    "database": "app"
  },

  "//readConnection": "Optional, and the cheapest real win here. Point it at a role with NO write privileges. Reads then stop depending on this library being correct — the allowlist runs in this process holding a credential that can write; a role without the privilege is enforced by the database itself. The dry run cannot use it, because planning really executes the statement before rolling it back.",

  "//applyConnection": "Optional. Point this at a DIFFERENT database user, one the model's tools cannot reach. Then the separation between proposing and committing does not depend on this library being free of bugs.",

  "policy": {
    "allow": ["orders"],
    "impact": {
      "orders": "Changing an order moves money: the ship date decides which month the supplier is paid in."
    },
    "denyIdentifiers": {
      "password_hash": "a stored credential",
      "api_token": "a stored credential"
    },
    "denyWriteColumns": {
      "total_amount": "recalculated by the billing job; editing it here would be overwritten"
    }
  },

  "limits": {
    "maxUpdateRows": 200,
    "maxDeleteRows": 50,
    "maxReadRows": 200,
    "statementMs": 5000,
    "lockMs": 3000
  },

  "//autoColumns": "Columns the database maintains itself, per table. Needed on PostgreSQL where an updated_at trigger is invisible to introspection.",
  "autoColumns": {
    "orders": ["updated_at"]
  }
}
`;

interface Args {
  command: string;
  rest: string[];
  config: string;
  actor: string;
  yes: boolean;
  limit: number | undefined;
  status: string | undefined;
  reason: string;
}

function parse(argv: string[]): Args {
  const rest: string[] = [];
  let config = process.env['LLM_SAFE_SQL_CONFIG'] ?? 'llm-safe-sql.config.json';
  let actor = process.env['LLM_SAFE_SQL_ACTOR'] ?? process.env['USER'] ?? process.env['USERNAME'] ?? '';
  let yes = false;
  let limit: number | undefined;
  let status: string | undefined;
  let reason = '';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--config': config = next(); break;
      case '--as': actor = next(); break;
      case '--yes': case '-y': yes = true; break;
      case '--limit': limit = Number(next()); break;
      case '--status': status = next(); break;
      case '--reason': reason = next(); break;
      default: rest.push(a);
    }
  }
  return { command: rest[0] ?? '', rest: rest.slice(1), config, actor, yes, limit, status, reason };
}

class UsageError extends Error {}

async function confirm(question: string, args: Args): Promise<boolean> {
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    throw new UsageError(
      'This is not a terminal, so there is nobody to ask. Pass --yes if you really mean it — and if this ' +
        'is running from a script, consider whether an approval nobody sees is an approval at all.',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(`${question} [type yes to continue] `);
    return a.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function requireActor(args: Args): string {
  if (args.actor.trim() === '') {
    throw new UsageError('Say who is acting: --as you@example.com (or set LLM_SAFE_SQL_ACTOR).');
  }
  return args.actor;
}

function requireId(args: Args): string {
  const id = args.rest[0];
  if (id === undefined) throw new UsageError('Which plan? Pass its id.');
  return id;
}

async function withSession<T>(cfg: Config, fn: (s: AdminSession) => Promise<T>): Promise<T> {
  const session = await openAdminSession(cfg);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

async function run(args: Args): Promise<number> {
  if (args.command === '' || args.command === 'help' || args.command === '--help') {
    out(USAGE);
    return 0;
  }
  if (args.command === 'version' || args.command === '--version') {
    out(VERSION);
    return 0;
  }
  if (args.command === 'init') {
    process.stdout.write(TEMPLATE);
    return 0;
  }

  const cfg = await loadConfig(args.config);

  switch (args.command) {
    case 'check':
      return withSession(cfg, async (s) => {
        await s.engine.adapter.selfCheck();
        await s.applier.adapter.selfCheck();
        if (s.engine.readIsSeparate) await s.engine.readAdapter.selfCheck();
        out(`Connections are usable (${cfg.dialect}).`);
        out('  the session is not shared with another caller');
        out('  a rollback really undoes a write');
        out('  "rows affected" means what this library assumes');
        for (const w of s.engine.adapter.limitations) out(`  NOT enforced here: ${w}`);

        // Which guards are enforced by the database, and which only by this
        // process. Everything else this command prints is about whether the
        // library works; this is about whether it matters if it doesn't.
        out('');
        out('Where the guards actually sit');
        const roles: { name: string; conn: ConnectionConfig; note: string }[] = [
          { name: 'read ', conn: cfg.readConnection ?? cfg.connection, note: 'the model reads through this' },
          { name: 'plan ', conn: cfg.connection, note: 'writes for real, always rolls back' },
          { name: 'apply', conn: cfg.applyConnection ?? cfg.connection, note: 'this one commits' },
          { name: 'store', conn: cfg.storeConnection ?? cfg.connection, note: 'plans and audit records' },
        ];
        for (const r of roles) out(`  ${r.name}  ${connectionIdentity(r.conn)}  — ${r.note}`);

        const idOf = (c: ConnectionConfig): string => connectionIdentity(c);
        const plan = idOf(cfg.connection);
        const warn: string[] = [];
        if (idOf(cfg.applyConnection ?? cfg.connection) === plan) {
          warn.push(
            'apply uses the SAME credential as plan. The separation between proposing and committing then ' +
              'rests entirely on this library being correct. Point applyConnection at a different database ' +
              'user and it survives a bug in here.',
          );
        }
        if (idOf(cfg.readConnection ?? cfg.connection) === plan) {
          warn.push(
            'read uses the SAME credential as plan, so reads run on a connection that can write. The ' +
              'allowlist is then the only thing standing between a read tool and a write — and it runs in ' +
              'this process. Point readConnection at a role with no write privileges.',
          );
        }
        if (idOf(cfg.storeConnection ?? cfg.connection) === idOf(cfg.applyConnection ?? cfg.connection)) {
          warn.push(
            'store uses the same credential as apply, so whatever can commit a change can also edit the ' +
              'record of it having been approved.',
          );
        }
        for (const w of warn) {
          out('');
          out(`  ! ${w}`);
        }
        if (warn.length === 0) out('  every role is a distinct credential.');
        out('');
        for (const table of cfg.policy.allow) {
          const shape = await s.engine.adapter.introspect(table);
          const notes: string[] = [];
          if (!shape.transactional) notes.push('NOT TRANSACTIONAL — no dry run is possible here');
          if (shape.primaryKey.length === 0) notes.push('no primary key — writes cannot be planned');
          if (!shape.autoColumnsKnown && cfg.autoColumns?.[table] === undefined) {
            notes.push('has triggers and no autoColumns declared — writes will be refused until you declare them');
          }
          const cascades = shape.inboundCascades.filter(
            (c) => c.onDelete === 'CASCADE' || c.onUpdate === 'CASCADE',
          );
          if (cascades.length > 0) {
            notes.push(`cascades into ${cascades.map((c) => c.table).join(', ')} — writes will be refused`);
          }
          out(`  ${table}: ${notes.length === 0 ? 'ready' : notes.join('; ')}`);
        }
        return 0;
      });

    case 'migrate':
      return withSession(cfg, async (s) => {
        await s.store.migrate();
        out(`Created ${s.store.planTable} and ${s.store.auditTable} if they were missing.`);
        return 0;
      });

    case 'read': {
      const sql = args.rest.join(' ');
      if (sql.trim() === '') throw new UsageError('Nothing to read. Pass a SELECT statement.');
      return withSession(cfg, async (s) => {
        const r = await s.engine.read(sql, args.limit === undefined ? {} : { limit: args.limit });
        out(JSON.stringify(r.rows, displayReplacer, 2));
        out(r.truncated ? `-- TRUNCATED at ${r.rows.length} rows; there are more.` : `-- ${r.rows.length} row(s)`);
        return 0;
      });
    }

    case 'plan': {
      const sql = args.rest.join(' ');
      if (sql.trim() === '') throw new UsageError('Nothing to plan. Pass an UPDATE or DELETE statement.');
      return withSession(cfg, async (s) => {
        const plan = await s.engine.plan(sql);
        const rec = await recordPlan(s.store, plan, requireActor(args));
        out(planCard(rec));
        return 0;
      });
    }

    case 'list':
      return withSession(cfg, async (s) => {
        const plans = await s.store.list({
          ...(args.status === undefined ? {} : { status: args.status as PlanStatus }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });
        if (plans.length === 0) {
          out('No plans.');
          return 0;
        }
        for (const p of plans) {
          out(
            `${p.id}  ${p.status.padEnd(9)} ${p.plan.op} ${p.plan.table} ` +
              `(${p.plan.rows.length} row(s))  by ${p.createdBy}  ${p.createdAt}`,
          );
        }
        return 0;
      });

    case 'show':
      return withSession(cfg, async (s) => {
        const rec = await s.store.get(requireId(args));
        if (rec === undefined) {
          out('No plan with that id.');
          return 1;
        }
        out(planCard(rec));
        return 0;
      });

    case 'approve': {
      const id = requireId(args);
      const actor = requireActor(args);
      return withSession(cfg, async (s) => {
        const rec = await s.store.get(id);
        if (rec === undefined) {
          out('No plan with that id.');
          return 1;
        }
        out(planCard(rec));
        out('');
        if (!(await confirm(`Approve this as ${actor}?`, args))) {
          out('Not approved. Nothing has changed.');
          return 1;
        }
        await s.applier.approve(id, actor);
        out(`Approved. Apply it with:  llm-safe-sql apply ${id} --as ${actor}`);
        return 0;
      });
    }

    case 'apply': {
      const id = requireId(args);
      const actor = requireActor(args);
      return withSession(cfg, async (s) => {
        const res = await s.applier.apply(id, actor);
        out(`Applied: ${res.op} on ${res.table}, ${res.rowsAffected} row(s), at ${res.appliedAt}.`);
        for (const w of res.warnings) out(`WARNING: ${w}`);
        return res.warnings.length === 0 ? 0 : 1;
      });
    }

    case 'cancel': {
      const id = requireId(args);
      const actor = requireActor(args);
      return withSession(cfg, async (s) => {
        await s.applier.cancel(id, actor, args.reason === '' ? 'no reason given' : args.reason);
        out('Cancelled.');
        return 0;
      });
    }

    default:
      throw new UsageError(`Unknown command: ${args.command}`);
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    process.exit(await run(args));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    // A refusal is a decision, not a crash. It gets the reason and nothing else,
    // because a stack trace here would bury the sentence the operator needs.
    if (e instanceof Refusal) {
      process.stderr.write(`Refused (${e.code}): ${e.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  }
}

void main();
