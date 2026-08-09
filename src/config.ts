import { readFile } from 'node:fs/promises';
import type { Adapter } from './adapter.js';
import type { Dialect } from './lexer.js';
import { Policy, type PolicyOptions } from './policy.js';
import { Refusal } from './refusal.js';

/**
 * One JSON file describing what this deployment is allowed to touch.
 *
 * The alternative — configuring the allowlist and the impact statements in code
 * — sounds tidier and is worse in practice: the person who knows that changing
 * `invoices.status` decides when a supplier gets paid is not usually the person
 * who deploys. A file they can read, review and put under version control is the
 * thing that gets this right, and a diff on it is a meaningful thing to approve.
 *
 * Secrets are not in it. Any string may contain `${VAR}` and is filled in from
 * the environment at load time, so the file itself stays safe to commit.
 */

export class ConfigError extends Refusal {
  constructor(message: string) {
    super('CONFIG_INVALID', message);
  }
}

export interface ServerConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/**
 * A SQLite database is a file, so there is no credential to separate.
 *
 * That matters for the plan/apply split this library is built around. On MySQL
 * and Postgres you point `applyConnection` at a different database user and the
 * separation stops depending on this library being correct. Here the equivalent
 * is `readOnly`: the model side opens the file read-only and SQLite itself
 * refuses every write on that handle, whatever the policy layer does or fails to
 * do. It is a weaker boundary than a separate credential — the process can still
 * open a second, writable handle — but it is enforced by the engine rather than
 * by us, which is more than a shared credential gives you.
 */
export interface SqliteConnectionConfig {
  readonly file: string;
  readonly readOnly?: boolean;
}

export type ConnectionConfig = ServerConnectionConfig | SqliteConnectionConfig;

export function isSqliteConnection(c: ConnectionConfig): c is SqliteConnectionConfig {
  return typeof (c as SqliteConnectionConfig).file === 'string';
}

/**
 * How this connection would appear to the database, with no secret in it.
 *
 * Used to answer one question the operator cannot otherwise check: are the
 * connections this deployment separates actually different credentials? Two
 * config blocks that differ only in whitespace look like a boundary in the
 * config file and are none, and nothing else in the system will ever say so.
 * The password is deliberately not part of it — two entries with the same user
 * and different passwords are the same identity to the database's audit log.
 */
export function connectionIdentity(c: ConnectionConfig): string {
  if (isSqliteConnection(c)) return `file:${c.file}${c.readOnly === true ? ' (read-only)' : ''}`;
  return `${c.user}@${c.host}:${String(c.port)}/${c.database}`;
}

export interface LimitsConfig {
  readonly maxUpdateRows?: number;
  readonly maxDeleteRows?: number;
  readonly maxReadRows?: number;
  readonly statementMs?: number;
  readonly lockMs?: number;
}

export interface Config {
  readonly dialect: Dialect;
  /** The connection used for reads and dry runs. Should be able to write, but never commits. */
  readonly connection: ConnectionConfig;
  /**
   * The connection used to apply approved plans. Defaults to `connection`.
   *
   * Point it at a different database user, and the separation this library is
   * built around stops depending on this library being correct: the credential
   * the model's tools can reach is then not the credential that can commit.
   */
  readonly applyConnection?: ConnectionConfig;
  /** Where plans and audit records live. Defaults to `connection`. Must not be the apply connection's session. */
  readonly storeConnection?: ConnectionConfig;
  /**
   * The connection used for reads. Defaults to `connection`.
   *
   * Point it at a role the database will not let write, and the read path stops
   * depending on this library being correct. That matters more than it sounds:
   * the allowlist and the secret-column check run in this process holding a
   * credential that can write, so they are guards a bug can get past. A role
   * without write privileges is enforced by the database, below us.
   *
   * The dry run deliberately cannot use this connection — planning executes the
   * statement for real before rolling it back — which is why it is a separate
   * setting rather than a flag on `connection`.
   */
  readonly readConnection?: ConnectionConfig;
  readonly policy: PolicyOptions;
  readonly limits?: LimitsConfig;
  readonly autoColumns?: Readonly<Record<string, readonly string[]>>;
}

/** Fill `${VAR}` from the environment, everywhere, and say which one is missing. */
function expand(value: unknown, path: string, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const got = env[name];
      if (got === undefined) {
        throw new ConfigError(
          `${path} refers to \${${name}}, but that environment variable is not set. ` +
            'Set it, or replace the reference with a literal value.',
        );
      }
      return got;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => expand(v, `${path}[${i}]`, env));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expand(v, `${path}.${k}`, env);
    }
    return out;
  }
  return value;
}

function connectionOf(raw: unknown, path: string, dialect: Dialect): ConnectionConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError(
      dialect === 'sqlite'
        ? `${path} must be an object with a file path, e.g. {"file": "./app.db"}.`
        : `${path} must be an object with host, port, user, password and database.`,
    );
  }
  const o = raw as Record<string, unknown>;

  if (dialect === 'sqlite') {
    if (typeof o['file'] !== 'string' || o['file'] === '') {
      throw new ConfigError(`${path}.file must be a path to a SQLite database file.`);
    }
    // ':memory:' is refused rather than quietly accepted. Each connection gets its
    // own private in-memory database, so the plan written by one process would be
    // invisible to the process approving it — every plan would come back "not
    // found", with nothing to suggest why.
    if (o['file'] === ':memory:') {
      throw new ConfigError(
        `${path}.file cannot be ":memory:". An in-memory database is private to a single connection, so a ` +
          'plan created here could never be read back by the process that applies it. Use a file path.',
      );
    }
    return {
      file: String(o['file']),
      ...(o['readOnly'] === undefined ? {} : { readOnly: Boolean(o['readOnly']) }),
    };
  }

  for (const k of ['host', 'user', 'database']) {
    if (typeof o[k] !== 'string' || o[k] === '') throw new ConfigError(`${path}.${k} must be a non-empty string.`);
  }
  const port = Number(o['port']);
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError(`${path}.port must be a port number.`);
  return {
    host: String(o['host']),
    port,
    user: String(o['user']),
    password: String(o['password'] ?? ''),
    database: String(o['database']),
  };
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = expand(raw, 'config', env) as Record<string, unknown>;

  const dialect = cfg['dialect'];
  if (dialect !== 'mysql' && dialect !== 'postgres' && dialect !== 'sqlite') {
    throw new ConfigError('config.dialect must be "mysql", "postgres" or "sqlite".');
  }

  const connection = connectionOf(cfg['connection'], 'config.connection', dialect);

  const p = (cfg['policy'] ?? {}) as Record<string, unknown>;
  const allow = p['allow'];
  if (!Array.isArray(allow) || allow.length === 0 || allow.some((x) => typeof x !== 'string')) {
    throw new ConfigError(
      'config.policy.allow must list the tables this deployment may touch. It is empty by design: ' +
        'nothing is reachable until you name it.',
    );
  }
  const impact = (p['impact'] ?? {}) as Record<string, string>;
  const missing = (allow as string[]).filter((t) => typeof impact[t] !== 'string' || impact[t] === '');
  if (missing.length > 0) {
    throw new ConfigError(
      `config.policy.impact has no entry for ${missing.join(', ')}. Write one sentence per table saying what ` +
        'changing it means in business terms. It is the sentence the person approving a change actually reads: ' +
        'without it they are being shown a list of column names and asked to judge it, which they cannot do.',
    );
  }

  const policy: PolicyOptions = {
    allow: allow as string[],
    impact,
    ...(p['denyIdentifiers'] === undefined ? {} : { denyIdentifiers: p['denyIdentifiers'] as Record<string, string> }),
    ...(p['denyWriteColumns'] === undefined
      ? {}
      : { denyWriteColumns: p['denyWriteColumns'] as Record<string, string> }),
    ...(p['planTable'] === undefined ? {} : { planTable: String(p['planTable']) }),
    ...(p['auditTable'] === undefined ? {} : { auditTable: String(p['auditTable']) }),
  };

  return {
    dialect,
    connection,
    ...(cfg['applyConnection'] === undefined
      ? {}
      : { applyConnection: connectionOf(cfg['applyConnection'], 'config.applyConnection', dialect) }),
    ...(cfg['storeConnection'] === undefined
      ? {}
      : { storeConnection: connectionOf(cfg['storeConnection'], 'config.storeConnection', dialect) }),
    ...(cfg['readConnection'] === undefined
      ? {}
      : { readConnection: connectionOf(cfg['readConnection'], 'config.readConnection', dialect) }),
    policy,
    ...(cfg['limits'] === undefined ? {} : { limits: cfg['limits'] as LimitsConfig }),
    ...(cfg['autoColumns'] === undefined
      ? {}
      : { autoColumns: cfg['autoColumns'] as Record<string, string[]> }),
  };
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`Could not read the config file at ${path}: ${String(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${path} is not valid JSON: ${String(e)}`);
  }
  return parseConfig(raw, env);
}

export function policyOf(cfg: Config): Policy {
  return new Policy(cfg.policy);
}

/**
 * Load the driver on demand.
 *
 * Static imports of both drivers would make a Postgres-only installation fail at
 * import time because `mysql2` is not there — for a package the user is
 * installing precisely to be careful with, that is a bad first impression and an
 * unnecessary one.
 */
export async function connectAdapter(dialect: Dialect, conn: ConnectionConfig): Promise<Adapter> {
  try {
    if (dialect === 'sqlite') {
      if (!isSqliteConnection(conn)) {
        throw new ConfigError('A sqlite connection needs a "file" path, not host/port/user.');
      }
      const { SqliteAdapter } = await import('./adapters/sqlite.js');
      return SqliteAdapter.connect(conn);
    }
    if (isSqliteConnection(conn)) {
      throw new ConfigError(`A ${dialect} connection needs host, port, user, password and database — not "file".`);
    }
    if (dialect === 'mysql') {
      const { MysqlAdapter } = await import('./adapters/mysql.js');
      return await MysqlAdapter.connect(conn);
    }
    const { PostgresAdapter } = await import('./adapters/postgres.js');
    return await PostgresAdapter.connect(conn);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const missing = missingPackage(e);
    if (missing !== undefined) {
      throw new ConfigError(`The ${missing} driver is not installed. Run: npm install ${missing}`);
    }
    throw e;
  }
}

/**
 * The package Node could not find, taken from the error rather than guessed.
 *
 * This used to infer the name from the dialect — `mysql` meant `mysql2`, and
 * anything else meant `pg` — which is right only while the guess and the reality
 * agree. They stopped agreeing when the Postgres adapter imported a shared error
 * class from the MySQL adapter: loading Postgres then loaded `mysql2`, and a
 * Postgres-only install was told *"The pg driver is not installed"* with `pg`
 * sitting in `node_modules`. Reading the name out of the error cannot drift from
 * what actually failed, and if the specifier is unrecognisable the original
 * error is rethrown rather than replaced with a confident wrong one.
 */
function missingPackage(e: unknown): string | undefined {
  const msg = String((e as { message?: unknown })?.message ?? e);
  if (!msg.includes('ERR_MODULE_NOT_FOUND') && !msg.includes('Cannot find package')) return undefined;
  const named = /Cannot find package '([^']+)'/.exec(msg) ?? /Cannot find module '([^']+)'/.exec(msg);
  const spec = named?.[1];
  if (spec === undefined) return undefined;
  // Only report a bare package name. A relative specifier means one of our own
  // files is missing, which is a broken install, not a driver the user forgot.
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) return undefined;
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string);
}
