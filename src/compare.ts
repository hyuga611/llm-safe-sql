/**
 * Deciding whether two column values are the same.
 *
 * This is load-bearing. If it says "same" when a value really changed, the change
 * never appears on the confirmation card and a human approves something they were
 * never shown. That is the exact failure this library exists to prevent, so the
 * comparison has to be right for every type a driver can hand back — not just the
 * scalars that turn up in the first ten minutes of testing.
 *
 * The naive `String(a) === String(b)` is the trap: `String({v:1})` and
 * `String({v:2})` are both `[object Object]`, so every JSON, JSONB, array and
 * binary column silently compares equal. Buffers stringify to their decoded text,
 * which collides across encodings.
 *
 * It cannot be strict either. Drivers legitimately differ on whether a DECIMAL
 * arrives as `"10.00"` or `10`, and whether a DATETIME arrives as a `Date` or a
 * string. Reporting those as changes would fill the card with noise and train the
 * reader to skim it — which is its own way of defeating human approval.
 *
 * So: exact where the type is meaningful, tolerant only where two spellings are
 * genuinely the same value.
 */

/** Column values, canonicalised for comparison and for stable display. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return '\u0000null';
  if (typeof v === 'bigint') return `n:${v.toString()}`;
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  if (typeof v === 'number') return `n:${normaliseNumber(String(v))}`;
  if (typeof v === 'string') return `s:${v}`;
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (isBuffer(v)) return `x:${v.toString('hex')}`;
  if (ArrayBuffer.isView(v)) return `x:${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}`;
  if (Array.isArray(v)) return `a:[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    // Key order is not part of a JSON value's identity, and drivers do not
    // promise to preserve it. Sort so `{"a":1,"b":2}` and `{"b":2,"a":1}` do not
    // read as a change, while a real edit still does.
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `o:{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return `s:${String(v)}`;
}

function isBuffer(v: unknown): v is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(v);
}

/**
 * Strip only the differences that are spelling, not value: leading zeros, a
 * trailing `.0`, `+` on an exponent. `10.00` and `10` are the same number;
 * `10.01` and `10.1` are not.
 */
function normaliseNumber(s: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
  if (!m) return s.trim();
  const sign = m[1] === '-' ? '-' : '';
  const int = (m[2] ?? '').replace(/^0+(?=\d)/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const exp = m[4] === undefined ? '' : `e${String(Number(m[4]))}`;
  const digits = `${int === '' ? '0' : int}${frac === '' ? '' : `.${frac}`}`;
  return `${sign}${digits}${exp}` === '-0' ? '0' : `${sign}${digits}${exp}`;
}

/**
 * True when two values represent the same stored value.
 *
 * Cross-type tolerance is deliberately narrow:
 *  - number vs numeric string — drivers disagree about DECIMAL and BIGINT
 *  - Date vs a date-shaped string — drivers disagree about DATETIME
 * Everything else must match by type and content.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull && bNull;

  // A date and its textual form.
  if (a instanceof Date || b instanceof Date) {
    const ta = toTime(a);
    const tb = toTime(b);
    return ta !== undefined && tb !== undefined && ta === tb;
  }

  // A number and its textual form — and only *across* types, which is what the
  // tolerance was ever for: drivers disagree about whether DECIMAL and BIGINT
  // arrive as `10` or as `"10.00"`.
  //
  // Applying it between two strings was a silent data-loss bug. Both sides of a
  // diff come from the same driver and the same column, so two strings are two
  // spellings the database is storing verbatim: `'00100'` and `'100'` are
  // different postcodes, different SKUs, different account numbers. `sameValue`
  // called them equal, so the column was dropped from `changed` — and from the
  // card, from the digest, and from the pre-apply comparison. An UPDATE that set
  // a name *and* a zero-padded code was approved as "1 column: name" and
  // committed both. Measured end to end before this line was written.
  const bothStrings = typeof a === 'string' && typeof b === 'string';
  const aNum = bothStrings ? undefined : numericish(a);
  const bNum = bothStrings ? undefined : numericish(b);
  if (aNum !== undefined && bNum !== undefined) return aNum === bNum;
  if (aNum !== undefined || bNum !== undefined) return false;

  return canonical(a) === canonical(b);
}

function toTime(v: unknown): number | undefined {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v.includes('T') || /[+-]\d\d:?\d\d$|Z$/.test(v) ? v : v.replace(' ', 'T'));
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function numericish(v: unknown): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? normaliseNumber(String(v)) : undefined;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) {
    return normaliseNumber(v);
  }
  return undefined;
}
