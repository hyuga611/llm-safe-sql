/**
 * The product as it is actually shipped: two programs and a config file.
 *
 * Everything else in this suite tests the library through its API. This one
 * spawns `llm-safe-sql-mcp`, speaks MCP to it over a pipe the way a client
 * would, then runs the `llm-safe-sql` command to approve and apply — because the
 * separation this library sells is between two *processes*, and a test that
 * imports both halves into one process cannot show it holds.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresAdapter } from '../../src/adapters/postgres.js';

const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'llmsafesql', database: 'llmsafesql' };
const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');
const MCP = join(process.cwd(), 'dist', 'src', 'mcp', 'bin.js');

let dir: string;
let configPath: string;
let db: PostgresAdapter;

/** The password is deliberately a `${VAR}` reference, so the config file stays safe to commit. */
const CONFIG = {
  dialect: 'postgres',
  connection: { host: PG.host, port: PG.port, user: PG.user, password: '${E2E_PASSWORD}', database: PG.database },
  policy: {
    allow: ['e2e_orders'],
    impact: { e2e_orders: 'Changing an order moves money: the ship date decides the payment month.' },
    denyIdentifiers: { api_token: 'a stored credential' },
    // Its own bookkeeping tables: the test files run in parallel and another one
    // clears the defaults between its cases.
    planTable: 'e2e_plans',
    auditTable: 'e2e_audit',
  },
  limits: { maxUpdateRows: 10, maxDeleteRows: 5, maxReadRows: 5 },
};

/**
 * The environment the two programs are started with.
 *
 * `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID` are set by the test runner in
 * this process and must not be passed on. A process started with them believes
 * it is a test worker and can write the runner's own reporting frames to stdout —
 * and one of the two programs started here is an MCP server whose protocol *is*
 * stdout. Inheriting the whole environment is right for everything else; these
 * two are the runner talking to itself.
 */
const { NODE_TEST_CONTEXT: _ctx, NODE_TEST_WORKER_ID: _worker, ...inherited } = process.env;
const env = { ...inherited, E2E_PASSWORD: PG.password, LLM_SAFE_SQL_CONFIG: '' };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-e2e-'));
  configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(CONFIG, null, 2), 'utf8');

  db = await PostgresAdapter.connect(PG);
  await db.query('DROP TABLE IF EXISTS e2e_orders');
  await db.query('CREATE TABLE e2e_orders (id INT PRIMARY KEY, status TEXT NOT NULL, api_token TEXT)');
  await db.query("INSERT INTO e2e_orders VALUES (1,'pending','tok-1'),(2,'pending','tok-2')");
});

after(async () => {
  await db.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
  /** Everything known about the run, for an assertion message that is worth reading. */
  report(): string;
}

/**
 * Run the CLI as a separate process, and keep enough about the run to explain a
 * failure.
 *
 * The first version resolved with `{ code, stdout, stderr }` and every assertion
 * passed `stderr` as its message. When the child died abnormally — exit code
 * 3221226505, which is Windows' `0xC0000409`, a process that aborted rather than
 * returned — stderr was empty, so the whole report was `3221226505 !== 0`. That
 * is a test telling you it failed and refusing to say anything else, in a suite
 * whose subject is not making claims it cannot support. `error` was not handled
 * at all, so a spawn that never started would have hung instead of failing.
 */
function run(args: string[], cfg: string): Promise<Ran> {
  return new Promise((resolve) => {
    const argv = [CLI, ...args, '--config', cfg];
    const p = spawn(process.execPath, argv, { env });
    let stdout = '';
    let stderr = '';
    let spawnError: string | null = null;
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    p.on('error', (e: Error) => (spawnError = String(e)));
    p.on('close', (code, signal) => {
      const ran: Ran = {
        code: code ?? -1,
        stdout,
        stderr,
        signal,
        spawnError,
        report() {
          const lines = [
            `command: node ${argv.join(' ')}`,
            `exit code: ${String(code)}${
              code === 3221226505
                ? ' (0xC0000409 — the process aborted rather than running and failing.\n' +
                  '  Almost always this means dist/ was rewritten while the suite was running:\n' +
                  '  the child loaded a half-written file. Measured: 0 failures in 25 runs with\n' +
                  '  nothing else touching dist, 1 in 8 with a rebuild looping alongside. Check\n' +
                  '  that no build, `npm pack`, or editor task is running, then run it again.)'
                : ''
            }`,
            `signal: ${String(signal)}`,
            `spawn error: ${String(spawnError)}`,
            `stdout: ${stdout.trim() === '' ? '(empty)' : `\n${stdout.trim()}`}`,
            `stderr: ${stderr.trim() === '' ? '(empty)' : `\n${stderr.trim()}`}`,
          ];
          return `\n${lines.join('\n')}\n`;
        },
      };
      resolve(ran);
    });
  });
}

const cli = (...args: string[]): Promise<Ran> => run(args, configPath);

/** A tiny MCP client: one request in, one response out, over the real pipe. */
class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly waiting = new Map<number, (v: unknown) => void>();
  private nextId = 1;

  constructor() {
    this.proc = spawn(process.execPath, [MCP, '--config', configPath], { env });
    this.proc.stdout.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf8');
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf('\n');
        if (line === '') continue;
        const msg = JSON.parse(line) as { id?: number };
        const resolve = msg.id === undefined ? undefined : this.waiting.get(msg.id);
        if (resolve !== undefined && msg.id !== undefined) {
          this.waiting.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number } }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve as (v: unknown) => void);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = await this.request('tools/call', { name, arguments: args });
    const r = res.result as { content?: { text: string }[]; isError?: boolean };
    return { text: r?.content?.[0]?.text ?? '', isError: r?.isError === true };
  }

  stop(): void {
    this.proc.kill();
  }
}

test('a plan proposed over MCP is approved and applied from the command line', async () => {
  const migrated = await cli('migrate');
  assert.equal(migrated.code, 0, migrated.report());

  const mcp = new McpClient();
  try {
    const init = (await mcp.request('initialize', { protocolVersion: '2025-06-18' })).result as {
      serverInfo: { name: string };
    };
    assert.equal(init.serverInfo.name, 'llm-safe-sql');

    const tools = (await mcp.request('tools/list')).result as { tools: { name: string }[] };
    assert.ok(!tools.tools.some((t) => /apply|approve/.test(t.name)), 'the model side must not be able to commit');

    // The secret column is refused however it is mentioned — this is the read
    // rule that a result-set mask cannot express.
    const leak = await mcp.callTool('sql_read', { sql: 'SELECT api_token AS x FROM e2e_orders' });
    assert.equal(leak.isError, true);
    assert.match(leak.text, /REFUSED \(DENIED_IDENTIFIER\)/);

    const proposal = await mcp.callTool('sql_plan', {
      sql: "UPDATE e2e_orders SET status = 'shipped' WHERE id = 1",
    });
    assert.equal(proposal.isError, false, proposal.text);
    assert.match(proposal.text, /status: 'pending' -> 'shipped'/);
    assert.match(proposal.text, /Nothing has been changed/);

    const id = /Plan ([0-9a-f-]{36})/.exec(proposal.text)?.[1];
    assert.ok(id, `no plan id in:\n${proposal.text}`);

    // Still untouched: a proposal is not a change.
    const mid = await db.query<{ status: string }>('SELECT status FROM e2e_orders WHERE id = 1');
    assert.equal(mid[0]?.status, 'pending');

    const approved = await cli('approve', id, '--as', 'tester', '--yes');
    assert.equal(approved.code, 0, approved.report());
    const applied = await cli('apply', id, '--as', 'tester');
    assert.equal(applied.code, 0, applied.report());
    assert.match(applied.stdout, /Applied: UPDATE on e2e_orders, 1 row/);

    const after = await db.query<{ status: string }>('SELECT status FROM e2e_orders WHERE id = 1');
    assert.equal(after[0]?.status, 'shipped');

    // And the model can see that it went through, without being told.
    const status = await mcp.callTool('sql_plan_status', { plan_id: id });
    assert.match(status.text, /applied/);

    const twice = await cli('apply', id, '--as', 'tester');
    assert.equal(twice.code, 1);
    assert.match(twice.stderr, /ALREADY_APPLIED/);
  } finally {
    mcp.stop();
  }
});

test('the config file explains itself when it is wrong', async () => {
  const bad = join(dir, 'bad.json');
  await writeFile(bad, JSON.stringify({ dialect: 'postgres', connection: CONFIG.connection, policy: { allow: ['x'] } }), 'utf8');
  // Through the same helper as every other spawn here. It used to have its own
  // copy, which is how one of them ends up reporting a failure the other cannot.
  const ran = await run(['check'], bad);
  assert.equal(ran.code, 1, ran.report());
  assert.match(ran.stderr, /impact has no entry for x/, ran.report());
});

test('check reports what it verified, per table', async () => {
  const ran = await cli('check');
  assert.equal(ran.code, 0, ran.report());
  assert.match(ran.stdout, /a rollback really undoes a write/);
  assert.match(ran.stdout, /e2e_orders: ready/);
});
