import type { Row } from './adapter.js';
import type { Plan, PlanRow } from './engine.js';

/**
 * Storing a plan and getting the same values back.
 *
 * A plan is written to a table when it is created and read back, in another
 * process, when a human approves it. Between those two moments it has to survive
 * as text — and plain `JSON.stringify` does not round-trip the types a database
 * driver actually returns. A `Buffer` comes back as `{"type":"Buffer","data":[…]}`,
 * a `Date` comes back as a string, a `bigint` throws on the way out.
 *
 * That is not a cosmetic problem. The apply step compares the live row against
 * the stored snapshot to prove nobody edited it in the meantime. If the snapshot
 * decodes to a different shape than the driver hands back, every plan on a table
 * with a BLOB, a timestamp or a 64-bit id fails that comparison and the operator
 * is told somebody else changed the row. Nobody did. They would retry, get the
 * same accusation, and eventually stop believing the check — which is worse than
 * not having it.
 *
 * So every value is written with its type, and read back as that type.
 */

interface Tagged {
  readonly t: string;
  readonly v?: unknown;
}

/**
 * Tag every value, including the ordinary ones.
 *
 * Tagging only the exotic types would be smaller, but then a JSON column whose
 * own contents happen to look like a tag would be revived as something else.
 * A uniform envelope has no ambiguous case.
 */
export function encodeValue(v: unknown): Tagged {
  if (v === null || v === undefined) return { t: 'null' };
  if (typeof v === 'string') return { t: 's', v };
  if (typeof v === 'number') {
    // JSON has no NaN and no Infinity: `JSON.stringify` turns all three into
    // `null`. The plan read back for approval then differed from the plan that
    // was stored, and every plan touching such a column was refused as tampered —
    // an accusation of tampering caused by a float column holding a value floats
    // are allowed to hold.
    if (!Number.isFinite(v)) {
      return { t: 'nonfinite', v: Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity' };
    }
    return { t: 'n', v };
  }
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'bigint') return { t: 'big', v: v.toString() };
  if (v instanceof Date) return { t: 'date', v: v.toISOString() };
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return { t: 'buf', v: v.toString('hex') };
  if (ArrayBuffer.isView(v)) {
    return { t: 'buf', v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex') };
  }
  // Arrays and JSON documents. These survive JSON encoding as themselves, and
  // the comparison used at apply time is structural, so key order does not
  // matter on the way back.
  return { t: 'json', v };
}

export function decodeValue(x: unknown): unknown {
  if (x === null || typeof x !== 'object') return x;
  const tag = x as Tagged;
  switch (tag.t) {
    case 'null': return null;
    case 's': case 'n': case 'bool': case 'json': return tag.v;
    case 'nonfinite':
      return String(tag.v) === 'NaN' ? Number.NaN : String(tag.v) === 'Infinity' ? Infinity : -Infinity;
    case 'big': return BigInt(String(tag.v));
    case 'date': return new Date(String(tag.v));
    case 'buf': return Buffer.from(String(tag.v), 'hex');
    default: return tag.v;
  }
}

function encodeRow(row: Row): Record<string, Tagged> {
  const out: Record<string, Tagged> = {};
  for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v);
  return out;
}

function decodeRow(raw: unknown): Row {
  const out: Row = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = decodeValue(v);
  return out;
}

/** JSON text for a plan, from which {@link decodePlan} rebuilds an equal plan. */
export function encodePlan(plan: Plan): string {
  return JSON.stringify({
    v: 1,
    sql: plan.sql,
    dialect: plan.dialect,
    table: plan.table,
    op: plan.op,
    rowsMatched: plan.rowsMatched,
    rowsChanged: plan.rowsChanged,
    rowsChangedIsMeaningful: plan.rowsChangedIsMeaningful,
    columnsTouched: plan.columnsTouched,
    impact: plan.impact,
    warnings: plan.warnings,
    rows: plan.rows.map((r) => ({
      key: encodeRow(r.key),
      changed: r.changed,
      covered: r.covered,
      before: encodeRow(r.before),
      after: encodeRow(r.after),
    })),
  });
}

export function decodePlan(text: string): Plan {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const rows: PlanRow[] = (Array.isArray(raw['rows']) ? raw['rows'] : []).map((r: unknown) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      key: decodeRow(o['key']),
      changed: Array.isArray(o['changed']) ? (o['changed'] as string[]) : [],
      covered: Array.isArray(o['covered']) ? (o['covered'] as string[]) : [],
      before: decodeRow(o['before']),
      after: decodeRow(o['after']),
    };
  });
  return {
    sql: String(raw['sql'] ?? ''),
    dialect: String(raw['dialect'] ?? ''),
    table: String(raw['table'] ?? ''),
    op: raw['op'] === 'DELETE' ? 'DELETE' : 'UPDATE',
    rows,
    columnsTouched: Array.isArray(raw['columnsTouched']) ? (raw['columnsTouched'] as string[]) : [],
    rowsMatched: Number(raw['rowsMatched'] ?? 0),
    rowsChanged: Number(raw['rowsChanged'] ?? 0),
    rowsChangedIsMeaningful: raw['rowsChangedIsMeaningful'] === true,
    impact: String(raw['impact'] ?? ''),
    warnings: Array.isArray(raw['warnings']) ? (raw['warnings'] as string[]) : [],
  };
}

/**
 * A `JSON.stringify` replacer for showing rows to a human or to a model.
 *
 * Distinct from {@link encodeValue}, which exists to round-trip a value back
 * into the same type. This one only has to be readable and honest — but it does
 * have to exist, because `JSON.stringify` throws on a `bigint` rather than
 * degrading, and every integer SQLite returns is one. Printing a row from a
 * table with a 64-bit id would otherwise crash the command that printed it.
 *
 * Binary is summarised rather than dumped: a megabyte of hex helps nobody, and
 * pasting it into a model's context is worse than useless.
 */
export function displayReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `<${value.length} bytes of binary>`;
  if (value !== null && typeof value === 'object' && (value as { type?: string }).type === 'Buffer') {
    const data = (value as { data?: number[] }).data ?? [];
    return `<${data.length} bytes of binary>`;
  }
  return value;
}
