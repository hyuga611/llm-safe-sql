import type { NormalizeResult } from './normalize.js';
import { tableRefs, setColumns, setColumnsAreCertain, lower } from './statement.js';
import { Refusal } from './refusal.js';

export type PolicyCode =
  | 'ENGINE_TABLE'
  | 'DENIED_IDENTIFIER'
  | 'TABLE_NOT_ALLOWED'
  | 'DENIED_WRITE_COLUMN'
  | 'IMPACT_UNDECLARED'
  | 'NO_TARGET_TABLE';

export class PolicyViolation extends Refusal {
  declare readonly code: PolicyCode;
  constructor(code: PolicyCode, message: string) {
    super(code, message);
  }
}

export interface PolicyOptions {
  /**
   * The only tables this engine may touch, for reads and writes alike.
   *
   * Default-deny is deliberate. The implementation this was ported from carried a
   * hardcoded *denylist* of its own table names, which meant anyone reusing it who
   * forgot to edit that list was running with their audit log deletable — and the
   * list was blind to name variations like `admin_users` or `oauth_tokens` anyway.
   * A denylist has to predict every dangerous name; an allowlist only has to know
   * the safe ones, which the operator does know.
   */
  readonly allow: readonly string[];

  /**
   * Names that must not appear anywhere in a statement, mapped to the reason a
   * human should be told. Applies to reads too: a credential you can read is a
   * credential you have leaked.
   *
   * Matching happens on identifier references, not on output columns. Masking a
   * result set by column name is trivially defeated by `SELECT secret AS x`, and
   * only ever worked for `SELECT *`.
   */
  readonly denyIdentifiers?: Readonly<Record<string, string>>;

  /** Columns that may be read but never written, mapped to the reason. */
  readonly denyWriteColumns?: Readonly<Record<string, string>>;

  /**
   * What it means, in business terms, to change each table. Required before any
   * write to that table can be planned.
   *
   * This is the rule that keeps human approval real. Strip it out and the
   * confirmation card becomes a list of column names and old/new values, which a
   * non-engineer cannot judge — they will click confirm because the diff "looks
   * right". The sentence that actually protects them is the one that says
   * "changing the ship date moves which month this supplier gets paid in".
   */
  readonly impact?: Readonly<Record<string, string>>;

  /** This engine's own tables. Always refused, in every mode, allowlist or not. */
  readonly planTable?: string;
  readonly auditTable?: string;
}

export class Policy {
  private readonly allow: ReadonlySet<string>;
  private readonly denyIdent: ReadonlyMap<string, string>;
  private readonly denyWriteCol: ReadonlyMap<string, string>;
  private readonly impact: ReadonlyMap<string, string>;
  private readonly engineTables: ReadonlySet<string>;

  constructor(opts: PolicyOptions) {
    this.allow = new Set(opts.allow.map(lower));
    this.denyIdent = new Map(Object.entries(opts.denyIdentifiers ?? {}).map(([k, v]) => [lower(k), v]));
    this.denyWriteCol = new Map(Object.entries(opts.denyWriteColumns ?? {}).map(([k, v]) => [lower(k), v]));
    this.impact = new Map(Object.entries(opts.impact ?? {}).map(([k, v]) => [lower(k), v]));
    this.engineTables = new Set([
      // Both the configured names and the defaults. Renaming the tables is a
      // deployment choice; it is not a reason to open up whatever is sitting at
      // the default names, which on a database that once ran the defaults is the
      // old audit log.
      'llm_safe_sql_plans',
      'llm_safe_sql_audit',
      lower(opts.planTable ?? 'llm_safe_sql_plans'),
      lower(opts.auditTable ?? 'llm_safe_sql_audit'),
    ]);
  }

  /** The business consequence registered for a table, if any. */
  impactFor(table: string): string | undefined {
    return this.impact.get(lower(table));
  }

  /** Throws {@link PolicyViolation} if this statement may not proceed. */
  check(stmt: NormalizeResult): void {
    const tokens = stmt.tokens;
    const refs = tableRefs(tokens);

    // 1. Our own bookkeeping is off limits before anything else is considered,
    //    including when the operator has (wrongly) allowlisted it. If a model can
    //    edit the plan table it can approve its own writes; if it can edit the
    //    audit table it can erase the evidence that it did.
    for (const t of [...refs, ...stmt.identifiers]) {
      if (this.engineTables.has(lower(t))) {
        throw new PolicyViolation(
          'ENGINE_TABLE',
          `\`${t}\` belongs to llm-safe-sql (plan and audit records) and is never readable or writable through it.`,
        );
      }
    }

    // 2. Denied identifiers, anywhere, reads included.
    for (const id of stmt.identifiers) {
      const why = this.denyIdent.get(id);
      if (why !== undefined) {
        throw new PolicyViolation(
          'DENIED_IDENTIFIER',
          `\`${id}\` cannot be used here: it is ${why}. ` +
            'Naming it under an alias or inside a function does not change that.',
        );
      }
    }

    // 3. Allowlist, applied to reads and writes alike.
    for (const t of refs) {
      if (!this.allow.has(lower(t))) {
        throw new PolicyViolation(
          'TABLE_NOT_ALLOWED',
          `Table \`${t}\` is not in the allowlist, so llm-safe-sql will not touch it.`,
        );
      }
    }

    if (stmt.kind !== 'write') return;

    const target = refs[0];
    if (target === undefined) {
      throw new PolicyViolation('NO_TARGET_TABLE', 'Could not determine which table this statement writes to.');
    }

    // 4. Columns that must go through a purpose-built operation instead.
    if (this.denyWriteCol.size > 0 && !setColumnsAreCertain(tokens)) {
      // An assignment whose target could not be read is not an assignment to
      // nothing. Passing it would make this guard silently conditional on the
      // parser understanding every spelling of a SET clause — which is how two
      // of them got through before: `SET t.col = …` reported the table as the
      // column, and Postgres' `SET (a, b) = (…)` reported only the first name.
      throw new PolicyViolation(
        'DENIED_WRITE_COLUMN',
        'Part of this SET clause could not be read as a column assignment, and columns are denied here. ' +
          'Rewrite it as plain `column = value` assignments so the guard can see what is being written.',
      );
    }
    for (const col of setColumns(tokens)) {
      const why = this.denyWriteCol.get(lower(col));
      if (why !== undefined) {
        throw new PolicyViolation(
          'DENIED_WRITE_COLUMN',
          `Column \`${col}\` cannot be written here: ${why}.`,
        );
      }
    }

    // 5. No declared consequence, no approval.
    if (!this.impact.has(lower(target))) {
      throw new PolicyViolation(
        'IMPACT_UNDECLARED',
        `No business impact is registered for \`${target}\`, so a human cannot meaningfully approve a change to it. ` +
          'Register what changing this table means before allowing writes.',
      );
    }
  }
}
