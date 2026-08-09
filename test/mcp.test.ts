/**
 * The MCP wire protocol, without a database.
 *
 * Written directly against the protocol rather than through the official SDK, so
 * these tests are the thing that says it still speaks it. They also pin the one
 * property that is not about JSON at all: no tool on this interface can commit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer, type JsonRpcResponse, type McpTools } from '../src/mcp/server.js';
import { Refusal } from '../src/refusal.js';
import type { StoredPlan } from '../src/store.js';

const stored: StoredPlan = {
  id: 'plan-1',
  digest: 'x',
  status: 'pending',
  createdBy: 'assistant',
  approvedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  plan: {
    sql: "UPDATE orders SET status = 'shipped' WHERE id = 42",
    dialect: 'postgres',
    table: 'orders',
    op: 'UPDATE',
    rows: [{ key: { id: 42 }, changed: ['status'], covered: ['status'], before: { status: 'pending' }, after: { status: 'shipped' } }],
    columnsTouched: ['status'],
    rowsMatched: 1,
    rowsChanged: 1,
    rowsChangedIsMeaningful: true,
    impact: 'Changing an order moves money.',
    warnings: [],
  },
};

function serverWith(over: Partial<McpTools> = {}): McpServer {
  const tools: McpTools = {
    async read() {
      return { sql: 'SELECT 1', rows: [{ a: 1 }], columns: ['a'], truncated: false };
    },
    async plan() {
      return stored;
    },
    async status() {
      return stored;
    },
    async describe() {
      return 'orders — test';
    },
    ...over,
  };
  return new McpServer(tools, { name: 'llm-safe-sql', version: '9.9.9' });
}

function textOf(res: JsonRpcResponse | undefined): string {
  const result = res?.result as { content?: { text: string }[] } | undefined;
  return result?.content?.[0]?.text ?? '';
}

async function call(server: McpServer, name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res, 'a request must get a response');
  return res;
}

test('initialize agrees on a protocol version the client asked for', async () => {
  const res = await serverWith().handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  });
  const r = res?.result as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(r.protocolVersion, '2024-11-05');
  assert.equal(r.serverInfo.name, 'llm-safe-sql');
});

test('initialize falls back to a version we do speak when the client asks for one we do not', async () => {
  const res = await serverWith().handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  });
  const r = res?.result as { protocolVersion: string };
  assert.equal(r.protocolVersion, '2025-06-18');
});

/**
 * The load-bearing test in this file. If a tool that commits ever appears here,
 * the model can reach it, and everything else this library does stops mattering.
 */
test('no tool on the model-facing interface can commit a change', async () => {
  const res = await serverWith().handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['sql_plan', 'sql_plan_status', 'sql_read', 'sql_schema']);
  for (const forbidden of ['sql_apply', 'sql_approve', 'sql_write', 'sql_execute', 'sql_cancel']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be exposed`);
  }
});

test('the plan tool returns a card and says plainly that nothing happened', async () => {
  const text = textOf(await call(serverWith(), 'sql_plan', { sql: 'UPDATE orders SET status=1 WHERE id=42' }));
  assert.match(text, /Plan plan-1/);
  assert.match(text, /status: 'pending' -> 'shipped'/);
  assert.match(text, /Changing an order moves money/);
  assert.match(text, /Nothing has been changed/);
});

test('a refusal comes back as tool output the model can act on, not a protocol error', async () => {
  const server = serverWith({
    async plan() {
      throw new Refusal('NO_WHERE', 'A write without WHERE would target every row.');
    },
  });
  const res = await call(server, 'sql_plan', { sql: 'UPDATE orders SET status=1' });
  const result = res.result as { isError?: boolean };
  assert.equal(res.error, undefined, 'a refusal is not a JSON-RPC error');
  assert.equal(result.isError, true);
  assert.match(textOf(res), /REFUSED \(NO_WHERE\)/);
});

test('a truncated read is labelled as truncated', async () => {
  const server = serverWith({
    async read() {
      return { sql: 'SELECT 1', rows: [{ a: 1 }], columns: ['a'], truncated: true };
    },
  });
  assert.match(textOf(await call(server, 'sql_read', { sql: 'SELECT * FROM orders' })), /TRUNCATED/);
});

test('binary and bigint survive being reported', async () => {
  const server = serverWith({
    async read() {
      return {
        sql: 'SELECT 1',
        rows: [{ blob: Buffer.from('00ff', 'hex'), big: 9007199254740993n }],
        columns: ['blob', 'big'],
        truncated: false,
      };
    },
  });
  const text = textOf(await call(server, 'sql_read', { sql: 'SELECT * FROM orders' }));
  assert.match(text, /bytes of binary/);
  assert.match(text, /9007199254740993/, 'a 64-bit value must not be rounded on the way out');
});

test('a missing argument is refused with a readable reason', async () => {
  const res = await call(serverWith(), 'sql_read', {});
  assert.equal((res.result as { isError?: boolean }).isError, true);
  assert.match(textOf(res), /`sql` is required/);
});

test('an unknown tool is reported, not crashed on', async () => {
  const res = await call(serverWith(), 'sql_apply', { plan_id: 'x' });
  assert.equal((res.result as { isError?: boolean }).isError, true);
  assert.match(textOf(res), /Unknown tool/);
});

test('notifications get no reply, unknown requests get an error', async () => {
  const server = serverWith();
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const res = await server.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal(res?.error?.code, -32601);
  assert.equal(res?.id, 7);
});

test('ping is answered', async () => {
  const res = await serverWith().handle({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(res?.result, {});
});

// =====================================================================
//  Tool annotations.
//
//   These are how a client decides whether to show a confirmation dialog. They
//   are assertions a server makes about itself, so they are worth getting right
//   rather than optimistic: sql_plan really executes the statement before
//   rolling it back, and claiming readOnlyHint for it would be the convenient
//   answer rather than the true one.
// =====================================================================
test('every tool declares annotations, and only the genuinely read-only ones claim it', async () => {
  const res = await serverWith().handle({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  const tools = (res?.result as { tools: { name: string; annotations?: Record<string, unknown> }[] }).tools;

  for (const t of tools) {
    assert.ok(t.annotations !== undefined, `${t.name} has no annotations`);
    assert.equal(t.annotations?.['destructiveHint'], false, `${t.name} should never be destructive`);
  }

  const byName = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
  assert.equal(byName.get('sql_read')?.['readOnlyHint'], true);
  assert.equal(byName.get('sql_plan_status')?.['readOnlyHint'], true);
  assert.equal(byName.get('sql_schema')?.['readOnlyHint'], true);

  // The one that matters: a dry run writes and then takes it back. No net
  // change is not the same as no change, so it must not claim read-only.
  assert.equal(byName.get('sql_plan')?.['readOnlyHint'], false);
});
