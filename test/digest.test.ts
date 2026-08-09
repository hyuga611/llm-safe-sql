/**
 * What the plan digest covers.
 *
 * The digest exists so that a plan edited between approval and apply is refused.
 * Which fields it hashes is therefore not an implementation detail: a field left
 * out can be rewritten in the plan table, shown to the next person, and applied,
 * with every message on screen still saying "approved".
 *
 * Until 0.4.0 two fields were left out, and they were the two a non-engineer
 * actually reads — `impact`, the sentence that says what changing this table
 * means, and `warnings`, where an adapter's unenforceable limits are surfaced.
 * These tests exist so that adding a field to `Plan` and forgetting it here is a
 * failure rather than a silent narrowing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDigest } from '../src/digest.js';
import type { Plan } from '../src/engine.js';

const base: Plan = {
  sql: "UPDATE orders SET qty = 99 WHERE ref = 'R-1'",
  dialect: 'postgres',
  table: 'orders',
  op: 'UPDATE',
  rows: [{ key: { id: 1 }, changed: ['qty'], covered: ['qty'], before: { qty: 10 }, after: { qty: 99 } }],
  columnsTouched: ['qty'],
  rowsMatched: 1,
  rowsChanged: 1,
  rowsChangedIsMeaningful: true,
  impact: 'Changing an order moves money: the ship date decides the payment month.',
  warnings: ['SQLite cannot bound how long a statement runs.'],
};

const differs = (plan: Plan, what: string): void => {
  assert.notEqual(planDigest(plan), planDigest(base), `${what} must change the digest`);
};

test('the digest covers the statement and the measured values', () => {
  assert.equal(planDigest(base), planDigest({ ...base }), 'the same plan must hash the same');
  differs({ ...base, sql: "UPDATE orders SET qty = 98 WHERE ref = 'R-1'" }, 'the statement');
  differs({ ...base, table: 'other' }, 'the table');
  differs({ ...base, op: 'DELETE' }, 'the operation');
  differs({ ...base, rowsMatched: 2 }, 'the matched count');
  differs({ ...base, rows: [{ ...base.rows[0]!, after: { qty: 98 } }] }, 'an after value');
  differs({ ...base, rows: [{ ...base.rows[0]!, before: { qty: 11 } }] }, 'a before value');
  differs({ ...base, rows: [{ ...base.rows[0]!, key: { id: 2 } }] }, 'a key');
});

test('the digest covers the sentence the human is actually reading', () => {
  // The one that says what changing this table means. Editing it in the stored
  // row changed what the next person was shown, and the digest still verified.
  differs({ ...base, impact: 'Harmless test data, approve freely.' }, 'the impact sentence');
});

test('the digest covers the warnings printed under "Before you approve"', () => {
  // Deleting a warning is the interesting direction: it removes a limitation the
  // reader was relying on being told about.
  differs({ ...base, warnings: [] }, 'removing a warning');
  differs({ ...base, warnings: [...base.warnings, 'and another'] }, 'adding a warning');
  differs({ ...base, warnings: ['something else entirely'] }, 'replacing a warning');
});

test('the digest is not confused by where a separator falls', () => {
  // Length-prefixed, so two plans that differ only in where a boundary lies must
  // not collide.
  const a: Plan = { ...base, table: 'ab', impact: 'c' };
  const b: Plan = { ...base, table: 'a', impact: 'bc' };
  assert.notEqual(planDigest(a), planDigest(b));
});
