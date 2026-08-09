# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-08-09

### Added

- **SQLite, through Node's built-in `node:sqlite`.** `"dialect": "sqlite"` with
  `"connection": { "file": "app.db" }`. No server, no container, no credential —
  which means the claim this library makes can now be watched happening on a file
  in a temp directory in about a minute, before anyone decides whether to trust
  it. The whole SQLite suite runs in the ordinary `npm test`, because there is
  nothing to start. Requires Node 24 (`node:sqlite` ships unflagged from 23.4);
  MySQL and PostgreSQL still run on Node 20+.
- **`Adapter.limitations`** (SPEC E5) — an adapter now declares what it cannot
  guarantee, and the engine prints it on **every** confirmation card. SQLite has
  no statement timeout at all, and `node:sqlite` exposes no interrupt to build
  one from. Accepting the configured limit and quietly dropping it would have
  been the same defect this library was extracted after, so it says so instead.
- **`Adapter.rowLockClause()`** — SQLite has no row locks and `FOR UPDATE` does
  not parse, so it takes the whole-database write lock up front with
  `BEGIN IMMEDIATE` and returns an empty clause. A method rather than a constant
  because getting it wrong is not symmetric: appending `FOR UPDATE` on SQLite
  throws, while *omitting* it on PostgreSQL runs perfectly and silently drops the
  guarantee the apply depends on.
- SPEC **E6** (prove the rollback against the real database, not a scratch table
  — `PRAGMA journal_mode = OFF` accepts a `ROLLBACK` and keeps the change) and
  **E7** (a connection declared read-only is proven so by attempting a write,
  because on SQLite that boundary is a file handle rather than a credential).

### Fixed

- **`keyOf` threw on a 64-bit integer.** Row keys were built with
  `JSON.stringify` over the raw driver value, and `JSON.stringify` throws on a
  `bigint` rather than degrading. MySQL and PostgreSQL both return their 64-bit
  ids as strings, so no test had ever met a real `bigint` — SQLite returns every
  integer as one, and the failure was immediate and total: every plan against a
  table with an integer primary key. Values now go through the same envelope the
  plan is stored with, so a key built from a live row and a key built from a
  decoded snapshot are built the same way.
- **A PostgreSQL-only installation could not connect at all**, and had not been
  able to since 0.1.0. `AdapterUnusable` was defined in the MySQL adapter and
  imported by the Postgres one, so loading Postgres loaded `mysql2` — and the
  error it produced was *"The pg driver is not installed. Run: npm install pg"*
  with `pg` already in `node_modules`, sending the reader to reinstall the one
  thing that was not the problem. The shared error class now lives in the module
  that has no driver imports, and no adapter imports another. CI's existing
  "one driver installed" check missed this because it only imported the package
  root, which deliberately loads no adapter; it now opens a connection.
- `connectAdapter` no longer guesses which package is missing from the dialect.
  It reads the specifier out of the error, so the name it reports cannot drift
  from what actually failed to load, and an unrecognisable one rethrows the
  original rather than replacing it with a confident wrong answer.
- `llm-safe-sql read` crashed on any row containing a 64-bit integer, for the
  same reason and in the same place. The CLI and the MCP server now share one
  replacer, so the model and the human reading the same row see the same text;
  it also summarises `Uint8Array` binary instead of printing it as a numbered
  object.

## [0.1.1] — 2026-08-09

### Fixed

- **Timestamps kept their full precision.** Both drivers parsed a timestamp into a
  JS `Date`, which holds milliseconds, while `DATETIME(6)` and `timestamp(6)` hold
  microseconds — so the digits that differed were exactly the digits being dropped.
  Measured on both engines: a change confined to microseconds compared equal. On
  its own that failed closed (the plan was refused as `NO_CHANGE`, which is wrong
  but harmless); alongside any other edit it produced a plan with the timestamp
  change simply absent from the card. That is the same shape as the JSON-column
  defect fixed in 0.1.0. Dates and times are now read as text on both adapters.
- The same change makes MySQL's zero date arrive as `0000-00-00` instead of
  `1899-11-30` — a value the database does not contain, previously displayed to
  somebody being asked to approve a change to it.
- The test scripts no longer rely on the runner expanding a glob, which Node 20
  does not do. The failure looked like a broken build (`Could not find
  'dist/test/*.test.js'`) rather than like a runner older than the syntax, and it
  only appeared in CI. Passing a directory instead is not a fix either — the
  runner recurses, so the unit run would pull in the integration suite and fail
  on any machine without a database.

## [0.1.0] — 2026-08-09

First public release. The idea and the engine come from a system that has been
running this pattern against a production database; this is a rewrite in
TypeScript with the environment assumptions checked rather than assumed, and with
every rule in [SPEC.md](SPEC.md) pinned by a test on MySQL 8.4 and PostgreSQL 16.

### The library

- **Dry run** (`Engine.plan`) — executes the statement inside a transaction,
  measures the real before/after values, always rolls back, and then re-reads the
  rows to prove the rollback took effect.
- **Apply** (`Applier.apply`) — locks the target rows, checks they still hold the
  approved values, executes, reconciles the counts against the trial, reads back
  to confirm the result, and only then commits.
- **Bounded reads** (`Engine.read`) — allowlisted, secrets denied by reference,
  truncation always reported.
- **Policy** — default-deny table allowlist, denied identifiers, write-denied
  columns, and a required business-impact sentence per table.
- **Durable plans** (`SqlPlanStore`) — plan and audit tables, conditional status
  transitions that cannot apply twice, and an audit record written before the
  write is attempted.
- Adapters for MySQL and PostgreSQL, each with a `selfCheck` that proves the four
  environment assumptions the guarantees rest on.

### The programs

- `llm-safe-sql-mcp` — MCP server over stdio, exposing `sql_read`, `sql_plan`,
  `sql_plan_status` and `sql_schema`. It holds no object capable of committing.
- `llm-safe-sql` — the human side: `check`, `migrate`, `plan`, `list`, `show`,
  `approve`, `apply`, `cancel`.

### Refusals added after adversarial review

Each of these was accepted by an earlier version of the engine, which then
produced a plan describing something other than what would happen:

- Values compared by type and content. `String(a) === String(b)` reported every
  JSON, JSONB, array and binary column as unchanged, so an edit to one could ride
  along under an approved change to a scalar and never be displayed.
- Non-transactional tables refused. A dry run there wrote permanently while
  reporting that production was untouched. The storage engine is a per-table
  property, so the startup probe proves nothing about the target.
- Foreign keys that cascade into another table refused: those rows can never
  appear on the card, and for `DELETE` the loss is irreversible.
- Volatile functions (`now()`, `rand()`, `nextval()`) refused: the rows shown are
  provably not the rows changed.
- Multi-table writes (`UPDATE a, b SET …`, `DELETE a FROM a JOIN b`) refused.
- `ORDER BY` / `LIMIT` on a write refused.
- Schema-qualified names kept whole, so a statement cannot be measured against
  one table while writing to another.
- BIGINT and DECIMAL read as strings: a double loses exactly the digits that
  differ.
- Nested dry runs removed entirely, rather than guarded. Measured: on MySQL a
  rolled-back statement keeps its row locks until the caller's transaction ends.
- An aliased target (`UPDATE orders o SET … WHERE o.id = 1`) is refused with the
  edit to make, instead of reaching the server and returning `missing FROM-clause
  entry for table "o"` — an error about a table the operator never wrote.
- `RETURNING` is no longer carried into the count query the engine builds from
  the condition, where it was a syntax error in a statement written correctly.

### False reports fixed

- A concurrent edit by another session is no longer reported as a failed
  rollback. The check now asks only whether the row still holds *the value this
  trial wrote*; a third value is somebody else's work and is not evidence about
  our rollback. The old behaviour accused the database of corruption during
  ordinary traffic.
- A statement refused before it ran no longer claims the trial could not be
  rolled back.
- `UPDATE order SET …` is no longer read as an `ORDER BY`. Clause detection is
  positional, not word-presence — a refusal that names the wrong problem is worse
  than no refusal, because the operator fixes something unrelated and retries.
- An edit to a column the plan does not touch is not treated as a conflict at
  apply time.

### Notes

- One error type. `Refusal` is the base class for every deliberate "no", with a
  `code`; three layers can refuse and making callers catch three classes
  guaranteed they would catch two.
- No runtime dependencies. Drivers are optional peers; the MCP server implements
  the wire protocol directly.

[0.2.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.2.0
[0.1.1]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.1.1
[0.1.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.1.0
