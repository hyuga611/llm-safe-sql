import { createHash } from 'node:crypto';
import { canonical } from './compare.js';
import type { Plan } from './engine.js';

/**
 * A fingerprint of exactly what a human approved.
 *
 * Between planning and applying, the plan lives in a table. The threat is not
 * only a malicious edit: a well-meaning operator can "fix" a value in the plan
 * row, and a partially written record can be read back as a plan that looks
 * complete. Either way the apply would proceed against something nobody agreed
 * to, while every message on screen still says "approved".
 *
 * So the digest covers the statement *and* the measured before/after values, and
 * it is checked before approval and again before applying. It is a tamper check,
 * not a security boundary — anyone who can write the plan table can recompute it.
 * The boundary is that the plan table is refused to callers of this library
 * (P5), and that applying needs a credential the model does not have.
 *
 * "Exactly what a human approved" has to mean the whole card, and until 0.4.0 it
 * did not. `impact` and `warnings` were left out, and those are the two fields a
 * non-engineer actually reads: `impact` is the sentence the policy calls "the
 * rule that keeps human approval real" — *changing the ship date moves which
 * month this supplier gets paid in* — and `warnings` is where an adapter's
 * unenforceable limits are surfaced. Editing either in the stored row changed
 * what the next person was shown while the digest still verified. A tamper check
 * that covers the numbers and not the sentence explaining them protects the part
 * nobody was going to be misled by.
 */
export function planDigest(plan: Plan): string {
  const parts: string[] = [
    // v2 added impact and warnings; v3 added the covered-column snapshot. Plans stored by an
    // older version no longer verify, which is the correct direction to fail: a
    // plan whose covered surface is smaller than this version believes is a plan
    // this version cannot vouch for.
    'llm-safe-sql/plan/v3',
    plan.dialect,
    plan.op,
    plan.table,
    plan.sql,
    String(plan.rowsMatched),
    String(plan.rowsChanged),
    String(plan.rowsChangedIsMeaningful),
    plan.impact,
    // Printed on the card as "across N columns: a, b", and read back from the
    // stored body verbatim rather than re-derived, so it was editable without
    // breaking the checksum.
    String(plan.columnsTouched.length),
    ...[...plan.columnsTouched].sort(),
    // Order is meaningful here — it is the order they are printed in.
    String(plan.warnings.length),
    ...plan.warnings,
  ];

  for (const r of plan.rows) {
    parts.push('row');
    for (const k of Object.keys(r.key).sort()) {
      parts.push('key', k, canonical(r.key[k]));
    }
    // Sorted, because the display order of columns is not part of what was
    // agreed; the values are.
    for (const c of [...r.changed].sort()) {
      parts.push('col', c, canonical(r.before[c]), canonical(r.after[c]));
    }
    // And every column the statement writes, which is a wider set: a column
    // assigned its own current value is not in `changed` and is still written.
    // The apply verifies these before and after, so a stored plan with one of
    // them removed would have that column written unchecked.
    for (const c of [...r.covered].sort()) {
      parts.push('cov', c, canonical(r.before[c]), canonical(r.after[c]));
    }
  }

  // Length-prefixed rather than joined by a separator: any separator can also
  // occur inside a value, and two different plans that differ only in where a
  // separator falls would otherwise hash the same.
  const h = createHash('sha256');
  for (const p of parts) h.update(`${p.length}:${p}`);
  return h.digest('hex');
}
