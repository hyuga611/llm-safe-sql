#!/usr/bin/env node
/**
 * Run the compiled tests in one directory, without recursing into the others.
 *
 * `node --test "dist/test/*.test.js"` looks obvious and works on Node 22 and
 * later, where the runner expands globs itself. On Node 20 it does not, and the
 * error is `Could not find 'dist/test/*.test.js'` — which reads like the build
 * failed rather than like the runner is older than the syntax. Passing a
 * directory instead is not a fix: the runner recurses, so the unit run would
 * pull in the integration suite and fail on a machine with no database.
 *
 * So the file list is resolved here, in about ten lines, and every supported
 * Node version gets the same command. It also removes the dependency on shell
 * glob expansion, which differs between bash and PowerShell.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('usage: node scripts/run-tests.mjs <directory>');
  process.exit(2);
}

let entries;
try {
  entries = readdirSync(dir, { withFileTypes: true });
} catch (e) {
  console.error(`Cannot read ${dir}: ${String(e)}. Run the build first.`);
  process.exit(1);
}

const files = entries
  .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
  .map((e) => join(dir, e.name))
  .sort();

if (files.length === 0) {
  console.error(`No *.test.js files in ${dir}. Run the build first.`);
  process.exit(1);
}

// Integration files share ONE database, so running them concurrently means one
// file's DDL, GRANT or REVOKE lands in the middle of another's transaction. That
// has bitten this suite twice: once as a plan-table collision, once as a test
// that passed alone and failed in the full run. A flaky suite is worse than a
// slow one — it trains you to re-run instead of to look — so anything sharing a
// database runs one file at a time.
//
// One more thing to know, because it costs an afternoon otherwise: do not rebuild
// while this is running. `tsc` rewrites the same files the runner is loading and
// the end-to-end test is spawning, and a child that loads a half-written file
// aborts — on Windows with exit code 3221226505 and an empty stderr, which looks
// exactly like a flaky test and is not one. Measured on this suite: 0 failures in
// 25 runs with nothing else touching dist, 1 in 8 with a build looping alongside.
const serial = process.argv.includes('--serial');
const args = serial ? ['--test', '--test-concurrency=1', ...files] : ['--test', ...files];
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
