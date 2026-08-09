# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] — 2026-08-09

An audit of the commit path — `apply.ts`, `store.ts`, `serialize.ts`, `card.ts`,
the MCP entry point — which the previous round had not examined. `apply.ts` is
the only code here that changes production data: the dry run always rolls back
and approval only writes a record. It produced twenty-three confirmed defects.

### If you ran 0.4.0 or earlier, check this in your own data

1. **An `UPDATE` that assigned a column the value it already held.** That column
   was written on every execution and verified on none: it was absent from the
   card, from the digest, and from both the pre-apply comparison and the
   read-back. If another session changed it between approval and apply, the apply
   silently wrote the stale value back and reported success. Zero-padded codes,
   status columns set defensively, `SET x = x` idioms — those are the shape.
2. **On PostgreSQL and SQLite, a row the card described as "already correct".**
   Same hole, whole row: nothing about its contents was checked before or after
   the write. On MySQL this case was caught; on the other two it was not.
3. **A long text column, a BLOB, or a large JSON document on a card.** Two
   different values could render as the same line — `'aaa...' -> 'aaa...'` — so a
   real change was displayed as no change on the line you were reading.

### Fixed

- **A column assigned its own current value was written unverified.** `changed`
  is what the trial measured as different; the statement writes what it
  *assigns*, and those are not the same set. Both verification loops iterated
  `changed`. Measured: `UPDATE customers SET name='new', postcode='00100'` on a
  row already holding `'00100'`, approved as "1 column: name", with another
  session correcting the postcode in between — the apply wrote `'00100'` back
  over the correction and returned success. `PlanRow` now carries `covered`,
  every column the statement assigns, snapshotted before and after and verified
  at both ends. `changed` still drives the display, because widening that would
  make the card claim a change where there is none.

- **Rows the card called "already correct" were committed unchecked** on
  PostgreSQL and SQLite, where the rows-changed reconciliation is meaningless and
  so is skipped. Covered by the same change.

- **Assigning a column declared in `autoColumns` is now refused.** Such columns
  are excluded from the diff by design (D8), so a statement that assigned one put
  an arbitrary value into the row with nothing on the card to show for it — and
  `autoColumns` is a config key a model can read.

- **`Applier.apply` had no latch**, though `Engine.plan` was given one in 0.4.0 —
  the same fix written for one of two siblings and not the other, which is the
  third time that shape has appeared here. Its nesting guard sat four `await`s
  from the `begin()` it guarded.

- **The apply ran at the connection's default isolation**, which on PostgreSQL is
  `READ COMMITTED` — under which the row this transaction has just verified can be
  replaced by another session's commit before the `UPDATE` reaches it. The dry run
  has always asked for `repeatable-read`; the half that keeps its result did not.

- **`applyLimits` and `begin` sat outside the try block**, after the plan had been
  claimed and the `attempting` record written — so a throw there wedged the plan
  in `applying` for ever, with no rollback, no `failed` transition and no failure
  record.

- **A trigger created between plan and apply was not re-checked**, though the
  cascade and storage-engine checks are re-run from a fresh introspect for exactly
  that reason. A trigger can write any column of the row, or any row of another
  table, and none of it is on the card.

- **The card could be forged, and could hide a change.** Values and the statement
  went to the terminal unescaped, so a newline let a value draw the lines beneath
  it — a complete second card above the real one. Long values were truncated at
  the same length on both sides of the diff, so two different values rendered
  identically; they now carry their length and a digest. A SQLite `BLOB` arrives
  as a plain `Uint8Array`, which the binary branch did not match, so the same plan
  rendered one card in the process that proposed it and another in the process
  that approved it.

- **`connection.schema` was dropped by the config parser**, which made 0.4.0's
  `search_path` fix inert for anyone configuring it from a file. Unknown keys in a
  connection block are now refused rather than ignored, for the same reason: a
  typo in a security-relevant setting must not read as "not configured".

- **A float column holding `NaN` or `±Infinity`** did not survive the plan's JSON
  encoding — all three became `null` — so every plan touching that table was
  refused as tampered.

- **The forbidden-word list was matched against unquoted identifiers only**, so
  quoting the name bypassed it: `"nextval"`, `"pg_read_file"`,
  `"information_schema"`.

- **`SELECT` was reported as a table name** for any read with a derived table
  (`FROM (SELECT …) x`), and CTE names were treated as tables — so every `WITH`
  statement was refused as not allowlisted, and SPEC R5 could not hold. A CTE's
  body is still scanned, so `WITH x AS (SELECT * FROM secrets) SELECT * FROM x`
  still reports `secrets`.

- **`Engine.read` tested the concurrency latch without taking it**, so a dry run
  starting while a read was in flight still put that read inside the trial
  transaction.

- **The MCP server's lazy session opener raced with itself** (`session ??= await
  …` tests and assigns on opposite sides of an await), so two early tool calls
  opened two sessions — two engines, two latches, neither aware of the other, and
  every session but the last leaked.

- **`columnsTouched` was printed on the card and left out of the digest.**

## [0.4.0] — 2026-08-09

### If you ran 0.1.0 – 0.3.1, check this in your own data

Four of the fixes below could have let a change reach your database without
appearing on the card somebody approved. None of them require anything unusual to
have happened; they are all reachable from ordinary use. In rough order of how
much it is worth looking:

1. **Columns holding numeric-looking text** — postcodes, SKUs, account numbers,
   anything zero-padded. If an `UPDATE` set such a column *and* something else,
   the card showed only the something else and the apply wrote both. Compare the
   approved plans in `llm_safe_sql_plans` against the rows they touched; a plan
   whose `changed` list is shorter than the statement's `SET` clause is the shape
   to look for.
2. **PostgreSQL with a separate `applyConnection` role** — run
   `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON
   n.oid = c.relnamespace WHERE c.relname IN (<your allowlisted tables>)`. More
   than one row for a table name means unqualified names could resolve
   differently per role, and writes may have landed in the schema you did not
   mean. This needs a schema named after one of your roles to have existed.
3. **Two `sql_plan` calls close together over MCP** — on MySQL the second could
   commit the first one's trial. An audit record whose `phase` shows a plan that
   was never applied, against a row that changed anyway, is the signature.
4. **`denyWriteColumns`** — if you rely on it, search your audit trail for
   `SET <table>.<column> =` and, on PostgreSQL, `SET (` . Both spellings were
   accepted for a denied column.

`check` in this version reports more than it used to, and is worth re-running
against every environment before you trust the answer you got from an older one.

### Fixed

- **On PostgreSQL, the apply could commit to a different table from the one the
  plan measured.** `search_path` was never set on any connection, and its default
  is `"$user", public` — where `$user` expands per connection. This library
  recommends giving the plan and the apply different database roles, which is
  exactly what turns that default into two different answers to "which table is
  `orders`".

  Measured on PostgreSQL 16: with a schema named after the apply role holding a
  table of the same name, the planner measured `public.sp_orders` and built a card
  from it; the apply role ran the identical statement and wrote
  `sp_applier.sp_orders`. The approved change did not happen, an unapproved one
  did, and nothing reported an error. A role able to create a schema in its own
  database can arrange this for itself.

  Every Postgres connection now pins `search_path` to one schema — `public` by
  default, `connection.schema` to change it — `selfCheck` proves it is still that
  schema, and `check` prints a non-default schema as part of the connection's
  identity. A deployment whose tables live elsewhere and forgets to say so now
  gets "relation does not exist" instead of a quiet write to the wrong table.

- **`denyWriteColumns` could be escaped by two ordinary spellings**, on the two
  server engines, silently — the statement ran and the denied column was written:

  - `SET orders.price = 1` — the extractor took the first identifier after `SET`,
    so it reported the *table* as the column being assigned.
  - `SET (qty, price) = (1, 2)` — PostgreSQL's multi-column form. The comma inside
    the parentheses was not at depth 0 and was ignored, so only the first column
    in the list was ever seen. Putting the denied column anywhere but first was
    enough.

  The SET clause is now parsed rather than approximated, and an assignment whose
  target cannot be read refuses the statement instead of contributing nothing to
  the check.

- **A read with no `FROM` never met the allowlist.** Nothing in `SELECT 1` or
  `SELECT nextval('order_id_seq')` names a table, so a default-deny policy had
  nothing to compare and let it through. The second one is not hypothetical:
  `nextval` advances a sequence for every session and a rollback does not put it
  back, so the read path — the one an injected instruction reaches first — could
  permanently consume ids. Reads must now name a table, and `nextval`, `setval`,
  `pg_read_file`, `pg_ls_dir`, `lo_import`, `lo_export` and `dblink` join the
  forbidden list.

- **MySQL's `sql_mode` was neither pinned nor probed.** The lexer reads MySQL with
  the server defaults, where `"x"` is a string literal. Under `ANSI_QUOTES` it is
  an *identifier* — so `SELECT "api_token" FROM orders` is a column reference to
  MySQL and a string to us, and `denyIdentifiers`, the rule that stops a
  credential column being read, never fires. `NO_BACKSLASH_ESCAPES` moves where a
  string literal ends, which is a disagreement about how many statements the text
  contains. Both are now cleared per session — built from the current value, so
  `STRICT_TRANS_TABLES` and the rest survive — and `selfCheck` refuses if anything
  puts them back.

- **The plan digest did not cover `impact` or `warnings`**, the two fields a
  non-engineer actually reads: the sentence saying what changing this table means,
  and the adapter limitations printed under "Before you approve". Editing either
  in the stored plan changed what the next person was shown while the digest still
  verified. Now covered; the digest is versioned `v2`, so plans stored by an older
  version no longer verify — which is the correct direction to fail.

- **A changed column could be dropped from the diff, so an unapproved write rode
  along under an approved one.** `sameValue` applied its numeric tolerance
  between two *strings*, not only across types as its own comment described. Both
  sides of a diff come from the same driver and the same column, so two strings
  are two spellings the database is storing verbatim — and `'00100'` and `'100'`
  are different postcodes, different SKUs, different account numbers.

  Measured end to end before the fix: `UPDATE customers SET name = 'Grace',
  postcode = '100'` against a row holding `('Ada', '00100')` produced a card
  reading *"1 row would change, across 1 column: name"*, listing only the name.
  The column was absent from `changed`, therefore from the card, from the plan
  digest, and from the pre-apply comparison — so nothing downstream could catch
  it either. The apply committed both.

  This is the same defect as the microsecond ride-along fixed in 0.1.1, in a
  different type: a real change made invisible by a comparison that was too
  tolerant. The tolerance is now restricted to the disagreement it was written
  for — a driver returning DECIMAL or BIGINT as `10` in one place and `"10.00"`
  in another — and every one of those cases still works.

- **Two overlapping dry runs could commit one another, on MySQL, permanently.**
  The anti-nesting check asks the adapter whether a transaction is already open,
  and it sits several `await`s before the `begin()` it guards — so two calls that
  overlap both saw "no transaction" and both opened one. Measured on MySQL 8.4:
  `START TRANSACTION` on a connection that already has one open **commits** it.
  The first trial's `UPDATE` therefore became a permanent write to production and
  was then reported to the operator as rolled back.

  This needed no concurrency in the caller. The MCP server serves tool calls as
  they arrive, on one shared session, so two `sql_plan` calls close together were
  enough. It is the exact outcome this library exists to make impossible, and it
  was reachable through the shipped configuration.

  `Engine.plan` now takes a latch before its first `await` — the only kind of
  lock a single-threaded runtime has — and refuses with `BUSY` rather than
  queueing, because a caller told "later" can decide what to do and a caller held
  behind a lock of unknown duration cannot. `Engine.read` refuses the same way
  when it shares the planning connection, since a read served from inside an open
  trial returns the values we are only pretending about. With `readConnection`
  configured there is nothing to collide with, and the read proceeds.

- **`SqliteAdapter.selfCheck` ignored its `mode` parameter** — the same defect as
  the two above, in the third adapter, where the parameter was even spelled
  `_mode`. A read-only handle asked for the write path's check returned success
  having proven no rollback and no counting model, after which `check` printed "a
  rollback really undoes a write" about it; and a writable handle used as
  `readConnection` was put through the full write probe on every read, taking
  `BEGIN IMMEDIATE` — a whole-database write lock — so reads failed with
  "database is locked" whenever anything else was writing.

- **The MySQL adapter declared no limitations, and MySQL has one.**
  `max_execution_time` applies to read-only `SELECT`; MySQL has no statement
  timeout for an `UPDATE` or `DELETE` at all. This repository has measured that
  and pinned it in a test since 0.1.0, while the adapter's `limitations` array
  stayed empty and its comment said there was "nothing to disclaim". So
  `limits.statementMs` appeared enforced, no confirmation card mentioned it, and
  `check` said nothing — the precise failure SPEC E5 exists to prevent, on the
  engine where SQLite's identical gap is declared in full.

- **`check` printed "every role is a distinct credential" without comparing the
  store credential against the plan credential.** It compared store against apply
  only, so a configuration whose store and plan are the same account — the
  default, whenever `applyConnection` alone is separated — passed silently. The
  side that proposes a change could also edit the stored plan it is later checked
  against.

- **`check` reported an ordinary read-write account as unable to write** — and
  reports that by printing nothing, which reads as approval. `probeWritable`
  created a temporary table and called success "writable", but that is a
  different privilege: on MySQL `CREATE TEMPORARY TABLES` is granted separately
  from DML, so the account produced by `GRANT SELECT, INSERT, UPDATE, DELETE`
  failed the probe. Measured on MySQL 8.4 and PostgreSQL 16 — the probe said
  "cannot write" about a connection that was updating a row at the time.

  This is the worst output this library can produce. Everything else it gets
  wrong makes it refuse to act; this one tells an operator that a boundary exists
  below the code when there is none, in the command they run specifically to find
  out where the boundaries are.

  `probeWritable(tables)` now attempts the writes this library can actually emit
  — `DELETE ... WHERE 1 = 0`, then `UPDATE ... SET c = c WHERE 1 = 0` per column —
  inside a transaction that is always rolled back. Both engines check the
  privilege while preparing the statement, before a row is matched, so the probe
  is answered without touching data. On PostgreSQL each attempt takes its own
  savepoint: Postgres aborts the whole transaction on the first error, and every
  statement after it fails with `current transaction is aborted`, which a `catch`
  cannot tell from a refusal. Without the savepoints a role holding UPDATE but
  not DELETE probes as read-only — the same false negative, reintroduced.

- **The 0.3.1 fix was applied to PostgreSQL and SQLite and omitted for MySQL**,
  in the same commit, so `readConnection` still refused a least-privilege MySQL
  user with "Cannot create a TEMPORARY table". TypeScript does not catch this:
  a `selfCheck()` that ignores the parameter still satisfies
  `selfCheck(mode?: SelfCheckMode)`, so the gap compiles silently. (The new
  `probeWritable` takes a required argument partly for this reason: a signature
  an adapter cannot satisfy by ignoring it fails the build instead of a user.)

- **`SQLite` resolved table and trigger names case-sensitively**, while SQLite
  itself does not. A table created as `Orders` and allowlisted as `orders` was
  reported as not found, and — worse — a trigger declared `ON orders` against a
  table created as `Orders` was not counted, so `autoColumnsKnown` came back
  `true` and the engine reported "no column moves by itself" about a table with a
  trigger writing to it.

- **`AdapterUnusable` was not a `Refusal`.** SPEC's appendix says every deliberate
  "no" in this library is a `Refusal` carrying a `code`, and this class is the
  source of most of the conditions reported as `ADAPTER_UNUSABLE` — so a caller
  following the documentation and catching `Refusal` caught every refusal except
  "the environment cannot support the guarantees", which escaped as an unhandled
  rejection.

- **`llm-safe-sql check` never verified the store connection**, though it lists
  `store` as a role and then prints "Connections are usable". That is the
  connection the record of an approval lives on.

- **`llm-safe-sql apply` exited 1 for a successful apply that produced a
  warning**, telling every script and CI step that the write had failed when it
  had succeeded — and the obvious response to a failed apply is to run it again.
  A warning is something to read, not a different outcome.

- **A relative SQLite `file` was resolved against the process's working
  directory**, so the CLI run from one directory and the MCP server started from
  another pointed at two different files — and SQLite creates a missing one rather
  than complaining, so the second was an empty database answering questions about
  the first. Paths are now resolved against the config file that names them.

### Added

- **SPEC P7 is implemented**: a `SET` column that does not exist is refused before
  anything runs, naming the columns the table does have. The rule had been in SPEC
  since the first version with nothing behind it, so a misspelling was found by
  the database — after the trial had already executed — and surfaced as a raw
  driver error.
- **SPEC E10**: a probe must attempt the operation it reports on, and must be able
  to answer "not established" rather than collapsing that into the reassuring
  answer. Earned from the `probeWritable` defect below.
- **`connection.schema`** for PostgreSQL.
- **SPEC D12 is withdrawn.** It specified how to compare "masked columns", a
  feature this library deliberately does not have — masking a result set by column
  name is defeated by `SELECT secret AS x`, which is why `denyIdentifiers` refuses
  the reference instead. A rule describing behaviour no code has is the same
  defect as a limit that is documented and unenforced. E6 and E7 are likewise
  rewritten to say what is actually established, per engine, rather than to state
  one universal claim that one adapter of three honoured.

### Changed

- **`Adapter.probeWritable()` is now `probeWritable(tables)` and returns
  `'writable' | 'read-only' | 'unknown'`** rather than a boolean. A custom
  adapter must be updated. The third state is the point: "could not establish"
  and "proved it cannot write" are different answers, and collapsing them into
  `false` is what let a probe that measured nothing print a clean bill of health.
  `check` now prints all three distinctly, and only says a read connection is
  constrained when it proved it on the caller's own tables.

### Testing

- The reason the `readConnection` bug reached a release twice is that nothing
  tested the read path against a real restricted credential on either server
  engine. `test/integration/readonly.test.ts` now builds **three** accounts per
  engine and pins fourteen behaviours across MySQL and PostgreSQL.

  The third account is the one that matters: `rw_probe` holds full DML and cannot
  create a temporary table. The first version of this file had only an
  all-privileges account and a SELECT-only one, and *both* of them agreed with a
  `probeWritable` that was measuring the wrong thing — a suite can be green,
  per-engine, and still be asking the wrong question of every credential it has.

- **The intermittent end-to-end failure was not a flaky test.** It was `dist/`
  being rewritten while the suite ran — a child process loading a half-written
  file aborts, on Windows with exit code `3221226505` and an empty stderr, which
  looks exactly like flakiness. Measured on the same three files: 0 failures in 25
  runs with nothing else touching `dist`, 1 in 8 with a build looping alongside.
  The spawn helper now keeps stdout, stderr, the signal and the spawn error and
  prints all of them, and names this cause when it sees that exit code; the runner
  says not to rebuild during a run. The helper also no longer passes
  `NODE_TEST_CONTEXT` to the programs it starts — a process that inherits it
  believes it is a test worker, and one of the two started here is an MCP server
  whose protocol is stdout.

- The file no longer revokes `TEMPORARY` on the shared test database. That is a
  property of a whole database, so every other connection saw it at once, and a
  process killed between the revoke and the restore left every later run failing
  with an error that points at the library rather than at the test. It now
  creates and drops a database of its own.

## [0.3.1] — 2026-08-09

### Fixed

- **`readConnection` did not work on PostgreSQL with an actual read-only role** —
  which is the configuration 0.3.0 shipped documentation recommending. `read()`
  ran the *write* path's environment check against it, and that check creates a
  temporary table, so a role correctly denied that privilege was rejected with
  "Cannot create a temporary table, so the environment cannot be verified." A
  guard written for one role, applied to another, refusing the correct setup.
  `selfCheck` now takes a mode, and the read path asks only for what reading
  depends on.
- **`Engine.readIsSeparate` reported a separation that did not exist.** It
  compared adapter object identity, and a `readConnection` block with the same
  credentials as `connection` still produced a second object. A session now opens
  a separate read connection only when the credential actually differs.
- `check` no longer takes "you configured a different role" as evidence of
  anything. It calls the new `Adapter.probeWritable()` and says so when a
  `readConnection` is a distinct credential that can still write. Configuring a
  different role and configuring a role that cannot write are separate facts, and
  only the second one is a boundary.

  **Correction (0.4.0).** This entry originally described that probe as "an
  attempted write, rolled back". It was not: it created a temporary table, which
  is a different privilege, and so reported an ordinary read-write account as
  unable to write. The sentence is corrected here rather than deleted, because a
  changelog that quietly stops having said something is no better a record than
  the probe was. Fixed in 0.4.0.

## [0.3.0] — 2026-08-09

### Added

- **`readConnection`** — a separate connection for reads, ideally a role the
  database will not let write (SPEC E9). The dry run genuinely cannot use it,
  since planning executes the statement for real before rolling it back; nothing
  else needs the privilege. Reading is the larger surface anyway — it is what an
  injected instruction reaches first, and exfiltration needs no write at all.
  Until now the allowlist was the only thing between a read tool and a write, and
  it runs in this process holding a credential that can write.
- **`check` now prints where each guard is actually enforced** (SPEC E8), and
  names the ones that are fictional:

  ```text
  Where the guards actually sit
    read   app_ro@db:5432/app   — the model reads through this
    plan   app@db:5432/app      — writes for real, always rolls back
    apply  app@db:5432/app      — this one commits
    store  app@db:5432/app      — plans and audit records

    ! apply uses the SAME credential as plan. The separation between proposing
      and committing then rests entirely on this library being correct.
    ! store uses the same credential as apply, so whatever can commit a change
      can also edit the record of it having been approved.
  ```

  A guard inside this process is only as good as this code is correct; a
  database role without the privilege survives our bugs. Both are worth having.
  Conflating them is how an operator comes to believe in a boundary that is one
  `if` statement in a library they have never read.
- **MCP tool annotations** on all four tools, so a client can decide how to
  render approval. `sql_plan` is deliberately **not** marked `readOnlyHint`: the
  database ends the call unchanged, but planning really executes the statement,
  takes locks and fires triggers, and a trigger can reach outside the
  transaction. "No net change" is not "does not modify its environment", and
  this is not the library to round that off in its own favour.
- `check` also lists whatever the adapter cannot enforce, so SQLite's missing
  statement timeout appears there as well as on every card.

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

[0.4.1]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.1
[0.4.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.4.0
[0.3.1]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.3.1
[0.3.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.3.0
[0.2.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.2.0
[0.1.1]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.1.1
[0.1.0]: https://github.com/hyuga611/llm-safe-sql/releases/tag/v0.1.0
