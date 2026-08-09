import { planCard } from '../card.js';
import { Refusal } from '../refusal.js';
import type { ReadResult } from '../engine.js';
import type { StoredPlan } from '../store.js';
import { displayReplacer } from '../serialize.js';

/**
 * An MCP server over stdio, written directly against the wire protocol.
 *
 * Using the official SDK would be the obvious choice, and it was the first one.
 * It brings an HTTP server, a JWT library, a schema validator and thirty-odd
 * other packages, none of which a stdio server executes — and this particular
 * program sits between a language model and a production database. Every package
 * in that tree is something an operator has to trust and nobody will audit.
 * Newline-delimited JSON-RPC is about a hundred lines, so the trade is not close.
 *
 * The protocol surface implemented here is the whole of what a tools-only server
 * needs: `initialize`, `tools/list`, `tools/call`, `ping`, and notifications,
 * which are acknowledged by not replying.
 */

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = SUPPORTED_PROTOCOLS[0] as string;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * What the server is allowed to do.
 *
 * There is no `apply` here and there must never be one. The separation between
 * "a model may propose" and "a person may commit" is the product; an apply tool
 * on this interface would delete it, however carefully it were guarded, because
 * everything on this interface is reachable by anything the model reads.
 */
export interface McpTools {
  read(sql: string, limit?: number): Promise<ReadResult>;
  plan(sql: string): Promise<StoredPlan>;
  status(id: string): Promise<StoredPlan | undefined>;
  /** Shown in tool descriptions so the model does not have to guess the shape of the data. */
  describe(): Promise<string>;
}

const TOOLS = [
  {
    name: 'sql_read',
    description:
      'Run a read-only SELECT against the configured database and return the rows. ' +
      'Only tables the operator has allowlisted are readable, and columns marked as secrets are refused ' +
      'wherever they are mentioned — including under an alias. Results are capped; when the answer is cut ' +
      'short you are told so explicitly, so never report a truncated result as if it were complete.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT statement. No semicolon-separated statements.' },
        limit: { type: 'integer', description: 'Maximum rows to return. Defaults to the configured cap.' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'sql_plan',
    description:
      'Propose an UPDATE or DELETE. This does NOT change anything. The statement is executed inside a ' +
      'transaction, the real before/after values are measured, and the transaction is always rolled back — ' +
      'so what comes back is a measurement, not a prediction. The result is a plan id and a confirmation ' +
      'card that a human must approve out-of-band; you cannot approve or apply it, and neither can this ' +
      'tool. Relay the card to the user as it is written, including the row counts, and do not describe ' +
      'the change as done. If the statement is refused, the reason says what to fix.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            'One UPDATE or DELETE with a WHERE clause, targeting one table. No JOIN, no ORDER BY/LIMIT, ' +
            'and no functions whose value changes between calls (now(), rand()) — those make the rows ' +
            'shown differ from the rows changed.',
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'sql_plan_status',
    description:
      'Look up a plan by id: whether a person has approved it, applied it, or cancelled it. ' +
      'Use this instead of assuming a plan went through.',
    inputSchema: {
      type: 'object',
      properties: { plan_id: { type: 'string' } },
      required: ['plan_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sql_schema',
    description:
      'List the tables this deployment may touch, what changing each one means, and their columns. ' +
      'Read this before writing a statement rather than guessing column names.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

interface ToolOutcome {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function text(s: string): ToolOutcome {
  return { content: [{ type: 'text', text: s }] };
}

function failed(s: string): ToolOutcome {
  return { content: [{ type: 'text', text: s }], isError: true };
}

export interface McpServerOptions {
  readonly name?: string;
  readonly version?: string;
  /** Name of the CLI shown in the card's instructions, for installs that rename it. */
  readonly cli?: string;
}

export class McpServer {
  private readonly tools: McpTools;
  private readonly opts: McpServerOptions;

  constructor(tools: McpTools, opts: McpServerOptions = {}) {
    this.tools = tools;
    this.opts = opts;
  }

  /** Handle one message. Returns undefined for notifications, which take no reply. */
  async handle(msg: JsonRpcMessage): Promise<JsonRpcResponse | undefined> {
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined;

    if (msg.method === undefined) {
      return isNotification ? undefined : this.error(id, -32600, 'Not a JSON-RPC request: no method.');
    }

    switch (msg.method) {
      case 'initialize': {
        const asked = (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        const version = asked !== undefined && SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST;
        return this.ok(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.opts.name ?? 'llm-safe-sql', version: this.opts.version ?? '0.0.0' },
        });
      }
      case 'ping':
        return this.ok(id, {});
      case 'tools/list':
        return this.ok(id, { tools: TOOLS });
      case 'tools/call':
        return this.ok(id, await this.call(msg.params));
      default:
        // Notifications we do not implement are simply ignored, which is what the
        // protocol asks for; unknown *requests* get a proper error.
        if (isNotification) return undefined;
        return this.error(id, -32601, `Unknown method: ${msg.method}`);
    }
  }

  private async call(params: unknown): Promise<ToolOutcome> {
    const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const args = p.arguments ?? {};
    try {
      switch (p.name) {
        case 'sql_read': {
          const sql = requireString(args['sql'], 'sql');
          const limit = args['limit'] === undefined ? undefined : Number(args['limit']);
          const r = await this.tools.read(sql, limit);
          return text(renderRead(r));
        }
        case 'sql_plan': {
          const sql = requireString(args['sql'], 'sql');
          const rec = await this.tools.plan(sql);
          const card = planCard(rec, this.opts.cli === undefined ? {} : { cli: this.opts.cli });
          return text(`${card}\n\nNothing has been changed. Report this to the user and stop here.`);
        }
        case 'sql_plan_status': {
          const rec = await this.tools.status(requireString(args['plan_id'], 'plan_id'));
          if (rec === undefined) return failed('No plan with that id.');
          return text(planCard(rec, this.opts.cli === undefined ? {} : { cli: this.opts.cli }));
        }
        case 'sql_schema':
          return text(await this.tools.describe());
        default:
          return failed(`Unknown tool: ${String(p.name)}`);
      }
    } catch (e) {
      // A refusal is information the model should act on — a wrong column name, a
      // table that is not open, a statement that cannot be measured. Returning it
      // as tool output rather than a protocol error is what lets it correct
      // itself instead of reporting a broken tool to the user.
      if (e instanceof Refusal) return failed(`REFUSED (${e.code}): ${e.message}`);
      return failed(`The database or this tool failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private ok(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Refusal('BAD_ARGUMENT', `\`${name}\` is required and must be a non-empty string.`);
  }
  return v;
}

function renderRead(r: ReadResult): string {
  const head = r.truncated
    ? `${r.rows.length} rows (TRUNCATED — there are more; narrow the query before drawing conclusions)`
    : `${r.rows.length} row(s)`;
  return `${head}\n${JSON.stringify(r.rows, replacer, 2)}`;
}

/**
 * Values a database returns are not all JSON-native; say what they are rather
 * than dropping them. Shared with the CLI so the model and the human reading the
 * same row see the same text.
 */
const replacer = displayReplacer;

/**
 * Read newline-delimited JSON-RPC from a stream and write replies to another.
 *
 * Framing note: MCP's stdio transport is one JSON object per line, with no
 * embedded newlines — not the Content-Length framing used by LSP. Anything the
 * server wants to say to a human goes to stderr, because stdout is the wire.
 */
export function serveStdio(
  server: McpServer,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  let buffer = '';
  input.setEncoding?.('utf8');
  input.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line === '') continue;
      void dispatch(server, line, output);
    }
  });
}

async function dispatch(server: McpServer, line: string, output: NodeJS.WritableStream): Promise<void> {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line) as JsonRpcMessage;
  } catch {
    output.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
    );
    return;
  }
  try {
    const res = await server.handle(msg);
    if (res !== undefined) output.write(`${JSON.stringify(res)}\n`);
  } catch (e) {
    if (msg.id !== undefined) {
      output.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
        })}\n`,
      );
    }
  }
}
