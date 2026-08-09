import { createHash } from 'node:crypto';
import type { Plan, PlanRow } from './engine.js';
import type { StoredPlan } from './store.js';

/**
 * The confirmation card.
 *
 * There is exactly one renderer, used by every surface — the model's tool output,
 * the CLI, anything built on top. That is on purpose: if the text the assistant
 * relays and the text the approver reads are produced by different code, they
 * will eventually disagree, and the disagreement will be discovered by someone
 * approving a change they did not understand.
 *
 * The card leads with what is at stake in words, not with SQL. Someone who can
 * read SQL will read it anyway; someone who cannot is exactly the person whose
 * approval must still mean something.
 */

const ARROW = ' -> ';

/**
 * Strip anything that lets a value rewrite the display around it.
 *
 * Every string on this card comes out of the database or out of the model, and
 * both reach a terminal. A newline lets a value forge the lines beneath it; an
 * escape sequence can repaint or erase what is already on screen. On a card whose
 * whole purpose is that the reader can trust what they see, a value that can draw
 * outside its own line is not a display bug.
 */
function inline(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\x${(c.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`;
  });
}

/**
 * Truncation has to be visible and has to be unambiguous.
 *
 * Cutting both sides of a diff at the same length renders `a…x` and `a…y` as the
 * same text, so a real change reads as `'aaa...' -> 'aaa...'` — no change at all,
 * on the line the reader is there to check. So a truncated value carries its full
 * length and a digest of the whole thing: two different values then differ on the
 * card even when their visible prefixes do not.
 */
const LIMIT = 80;

function clip(s: string, what: string): string {
  if (s.length <= LIMIT) return s;
  const h = createHash('sha256').update(s).digest('hex').slice(0, 8);
  return `${s.slice(0, LIMIT - 3)}... (${what}, ${s.length} chars, sha256:${h})`;
}

function value(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'string') return `'${clip(inline(v), 'truncated')}'`;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return binary(v);
  // Not only Buffer: SQLite hands back a plain Uint8Array, so the same plan
  // rendered one card in the process that proposed it and a different one in the
  // process that approved it — `<3 bytes of binary>` in one and the decoded text
  // in the other, which for a BLOB is whatever bytes happen to look like.
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return binary(Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength));
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return clip(inline(JSON.stringify(v) ?? String(v)), 'truncated');
  return clip(inline(String(v)), 'truncated');
}

function binary(b: Buffer): string {
  const h = createHash('sha256').update(b).digest('hex').slice(0, 8);
  return `<${b.length} bytes of binary, sha256:${h}>`;
}

function keyText(row: PlanRow): string {
  return Object.entries(row.key)
    .map(([k, v]) => `${k} = ${value(v)}`)
    .join(', ');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The body of the card: what changes, row by row, as measured. */
export function planBody(plan: Plan): string {
  const out: string[] = [];
  // The statement is the model's text. It has been normalised — comments removed,
  // one statement only — but nothing has stopped it containing a newline, and a
  // newline here lets it draw the lines below it: a complete second card, with
  // its own row list and its own harmless-looking diff, above the real one.
  out.push(`  ${inline(plan.sql)}`);
  out.push('');
  out.push('What this touches');
  out.push(`  ${plan.table} — ${plan.impact}`);

  if (plan.op === 'DELETE') {
    out.push(`  ${plural(plan.rows.length, 'row')} would be deleted outright.`);
    out.push('');
    out.push('The rows, as they are now');
    for (const r of plan.rows) {
      out.push(`  ${keyText(r)}`);
      const shown = r.changed.filter((c) => r.before[c] !== null && r.before[c] !== undefined);
      const empty = r.changed.length - shown.length;
      for (const c of shown) out.push(`      ${c}: ${value(r.before[c])}`);
      if (empty > 0) out.push(`      (${plural(empty, 'other column')}, all empty)`);
    }
  } else {
    const changing = plan.rows.filter((r) => r.changed.length > 0);
    out.push(
      `  ${plural(changing.length, 'row')} would change, ` +
        `across ${plural(plan.columnsTouched.length, 'column')}: ${plan.columnsTouched.join(', ')}`,
    );
    if (changing.length !== plan.rows.length) {
      out.push(`  (${plan.rows.length - changing.length} more match the condition but are already correct.)`);
    }
    out.push('');
    out.push('Measured by running the statement and rolling it back');
    for (const r of changing) {
      out.push(`  ${keyText(r)}`);
      for (const c of r.changed) {
        out.push(`      ${c}: ${value(r.before[c])}${ARROW}${value(r.after[c])}`);
      }
    }
  }

  if (plan.warnings.length > 0) {
    out.push('');
    out.push('Before you approve');
    for (const w of plan.warnings) out.push(`  - ${w}`);
  }
  return out.join('\n');
}

/** The full card, including the plan's identity and how to act on it. */
export function planCard(rec: StoredPlan, opts: { cli?: string } = {}): string {
  const cli = opts.cli ?? 'llm-safe-sql';
  const head =
    rec.status === 'pending'
      ? `Plan ${rec.id} — proposed, not applied. Nothing in the database has changed.`
      : `Plan ${rec.id} — ${rec.status}.`;

  const foot: string[] = [];
  if (rec.status === 'pending') {
    foot.push('', 'This needs a person. Neither the assistant nor this tool can approve it:');
    foot.push(`  ${cli} approve ${rec.id} --as you@example.com`);
    foot.push(`  ${cli} apply ${rec.id} --as you@example.com`);
  } else if (rec.status === 'approved') {
    foot.push('', `Approved by ${rec.approvedBy ?? 'unknown'}. Not yet applied:`);
    foot.push(`  ${cli} apply ${rec.id} --as you@example.com`);
  }

  return [head, '', planBody(rec.plan), ...foot].join('\n');
}
