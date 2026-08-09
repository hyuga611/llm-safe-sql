import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripComments, identifiers, splitStatements, lex } from '../src/lexer.js';

// =====================================================================
//  SPEC N2 -- comments are STRIPPED, not rejected.
//
//   The implementation this was ported from rejected them with a regex, which
//   `WHERE b='x'-- AND c=0` walks straight past: the `--` is not preceded by
//   whitespace. The comment then survived into the executed statement while the
//   human was shown something else. Stripping makes the displayed text and the
//   executed text the same text, which is the only version of this that cannot
//   drift apart.
// =====================================================================
test('N2: -- comment is stripped even with no preceding whitespace (MySQL)', () => {
  const out = stripComments("UPDATE t SET a=1 WHERE b='x'-- AND c=0", 'mysql');
  assert.equal(out.trim(), "UPDATE t SET a=1 WHERE b='x'");
});

test('N2: MySQL requires whitespace after -- ; `a--b` is arithmetic, not a comment', () => {
  assert.equal(stripComments('SELECT 5--3', 'mysql'), 'SELECT 5--3');
  // Postgres does not require that whitespace, so the same text IS a comment.
  assert.equal(stripComments('SELECT 5--3', 'postgres').trim(), 'SELECT 5');
});

test('N2: # is a comment in MySQL but NOT in Postgres', () => {
  assert.equal(stripComments('SELECT 1 # hidden', 'mysql').trim(), 'SELECT 1');
  assert.equal(stripComments('SELECT 1 # hidden', 'postgres'), 'SELECT 1 # hidden');
});

test('N2: comment markers inside string literals survive (no false stripping)', () => {
  const sql = "UPDATE t SET name='No.1 #best -- really /* yes */' WHERE id='1'";
  assert.equal(stripComments(sql, 'mysql'), sql);
});

test('N2: block comments are stripped; Postgres nests them', () => {
  assert.equal(stripComments('SELECT /* x */ 1', 'mysql').replace(/\s+/g, ' ').trim(), 'SELECT 1');
  assert.equal(
    stripComments('SELECT /* a /* b */ c */ 1', 'postgres').replace(/\s+/g, ' ').trim(),
    'SELECT 1',
  );
});

test('N2: unterminated block comment is an error, not silently accepted', () => {
  assert.throws(() => stripComments('SELECT 1 /* never closed', 'mysql'), /unterminated/i);
});

test('N2: unterminated string literal is an error', () => {
  assert.throws(() => stripComments("SELECT 'oops", 'mysql'), /unterminated/i);
});

// =====================================================================
//  SPEC N3 -- one statement only, and a `;` inside a literal is not a separator.
// =====================================================================
test('N3: semicolon inside a literal is not a statement separator', () => {
  const parts = splitStatements("UPDATE t SET a=';' WHERE id='1'", 'mysql');
  assert.equal(parts.length, 1);
});

test('N3: trailing semicolon yields one statement', () => {
  assert.deepEqual(
    splitStatements('SELECT 1;', 'mysql').map((s) => s.trim()),
    ['SELECT 1'],
  );
});

test('N3: two real statements are detected', () => {
  assert.equal(splitStatements('SELECT 1; SELECT 2', 'mysql').length, 2);
});

test('N3: a comment cannot hide a second statement', () => {
  // The same shape as the comment bypass above: the second statement only becomes
  // visible once the comment is removed, which is why counting happens after.
  assert.equal(splitStatements("UPDATE t SET a=1 WHERE b='x'--\n; DROP TABLE t", 'mysql').length, 2);
});

// =====================================================================
//  SPEC R1/R2 + N4 -- scanning identifiers.
//
//   Two properties, and both matter: text inside a string literal is not an
//   identifier, so `SET note='Please call the customer'` is not rejected for the
//   word 'call'; and a quoted identifier is unwrapped before it is matched, so
//   quoting a denied name is not a way around the check.
// =====================================================================
test('R2: quoted identifiers are unwrapped and scanned (MySQL backtick)', () => {
  assert.ok(identifiers('SELECT * FROM `AdminUser`', 'mysql').includes('adminuser'));
});

test('R2: quoted identifiers are unwrapped and scanned (Postgres double quote)', () => {
  assert.ok(identifiers('SELECT * FROM "AdminUser"', 'postgres').includes('adminuser'));
});

test('R2: in MySQL a double-quoted token is a STRING, so it is not an identifier', () => {
  // Under MySQL default sql_mode a double-quoted token is a string. Reading it as
  // an identifier would refuse ordinary statements for words in their own data.
  assert.ok(!identifiers('SELECT * FROM t WHERE note="AdminUser"', 'mysql').includes('adminuser'));
});

test('R2: string literal contents are never identifiers', () => {
  const ids = identifiers("SELECT * FROM Product WHERE name='AdminUser passwordHash'", 'mysql');
  assert.ok(!ids.includes('adminuser'));
  assert.ok(!ids.includes('passwordhash'));
  assert.ok(ids.includes('product'));
});

test('R2: aliasing and wrapping cannot hide the source column name', () => {
  for (const sql of [
    'SELECT passwordHash AS x FROM AdminUser',
    'SELECT SUBSTRING(passwordHash,1,20) FROM AdminUser',
    "SELECT CONCAT(passwordHash,'') FROM AdminUser",
    'SELECT (SELECT passwordHash FROM AdminUser LIMIT 1) AS p',
  ]) {
    const ids = identifiers(sql, 'mysql');
    assert.ok(ids.includes('passwordhash'), sql);
    assert.ok(ids.includes('adminuser'), sql);
  }
});

test('R2: identifiers are case-folded', () => {
  assert.ok(identifiers('SELECT * FROM AdMiNuSeR', 'mysql').includes('adminuser'));
});

test('R2: Postgres dollar-quoted body is a literal, not identifiers', () => {
  const ids = identifiers('SELECT $tag$ AdminUser passwordHash $tag$ AS x FROM t', 'postgres');
  assert.ok(!ids.includes('adminuser'));
  assert.ok(!ids.includes('passwordhash'));
  assert.ok(ids.includes('t'));
});

test('R2: MySQL backslash escape inside a literal does not end it early', () => {
  // That is one string literal. Ending it early would let the rest of the literal
  // be read as identifiers, which is how a denied name slips through unnoticed.
  const ids = identifiers("SELECT * FROM t WHERE a='\\'AdminUser' AND b=1", 'mysql');
  assert.ok(!ids.includes('adminuser'));
});

test("R2: doubled quote '' inside a literal does not end it", () => {
  const ids = identifiers("SELECT * FROM t WHERE a='it''s AdminUser'", 'mysql');
  assert.ok(!ids.includes('adminuser'));
});

test('R2: Postgres does NOT treat backslash as an escape by default', () => {
  // With standard_conforming_strings=on the literal closes at the backslash.
  // Assuming MySQL rules here would mis-parse everything after it.
  const ids = identifiers("SELECT * FROM t WHERE a='a\\' AND AdminUser IS NULL", 'postgres');
  assert.ok(ids.includes('adminuser'));
});

test("R2: Postgres E'' string DOES honour backslash escapes", () => {
  const ids = identifiers("SELECT * FROM t WHERE a=E'\\'AdminUser' AND b=1", 'postgres');
  assert.ok(!ids.includes('adminuser'));
});

// =====================================================================
//  The lexer's own invariants
// =====================================================================
test('lex: raw slices reassemble into the original input exactly', () => {
  const samples = [
    "UPDATE `Order` SET shipDate='2026-08-08' WHERE ref='R-1' -- note\n",
    'SELECT /* c */ a, "b" FROM t WHERE x=$tag$y$tag$',
    "SELECT 5--3, 'it''s', E'\\n' FROM t",
  ];
  for (const dialect of ['mysql', 'postgres'] as const) {
    for (const s of samples) {
      const joined = lex(s, dialect)
        .map((t) => t.raw)
        .join('');
      assert.equal(joined, s, `${dialect}: ${s}`);
    }
  }
});

// =====================================================================
//  SPEC N2/R2 -- SQLite.
//
//   SQLite accepts THREE spellings of a quoted identifier: "x" like the
//   standard, `x` like MySQL, and [x] like MS Access. Every one of them was
//   confirmed against a real database before these tests were written, because
//   the risk here is specific: if SQLite reads `[users]` as one identifier and
//   this lexer reads it as punctuation around a bare word, then a denylist that
//   inspects identifiers is looking at a different statement than the one that
//   will run. Agreement with the engine is the whole job.
// =====================================================================

test('N2: SQLite needs no whitespace after -- , like Postgres and unlike MySQL', () => {
  assert.equal(stripComments('SELECT 5--3', 'sqlite').trim(), 'SELECT 5');
  assert.equal(stripComments('SELECT 5--3', 'mysql'), 'SELECT 5--3');
});

test('N2: # is NOT a comment in SQLite', () => {
  assert.equal(stripComments('SELECT 1 # hidden', 'sqlite'), 'SELECT 1 # hidden');
});

test('N2: SQLite block comments do not nest', () => {
  // The inner `*/` closes it, so `c */ 1` is live SQL — same as MySQL.
  assert.equal(
    stripComments('SELECT /* a /* b */ c */ 1', 'sqlite').replace(/\s+/g, ' ').trim(),
    'SELECT c */ 1',
  );
});

test('R2: all three SQLite identifier quotings surface the same name', () => {
  for (const sql of [
    'UPDATE "AdminUser" SET a=1',
    'UPDATE `AdminUser` SET a=1',
    'UPDATE [AdminUser] SET a=1',
    'UPDATE AdminUser SET a=1',
  ]) {
    assert.ok(identifiers(sql, 'sqlite').includes('adminuser'), sql);
  }
});

test('R2: a bracketed name inside a string literal is NOT an identifier', () => {
  const ids = identifiers("UPDATE t SET note='see [AdminUser] for details' WHERE id=1", 'sqlite');
  assert.ok(!ids.includes('adminuser'), 'a denylist must not fire on prose');
});

test('R2: SQLite does not honour backslash escapes in strings, so the literal ends at the quote', () => {
  // In MySQL the backslash escapes the quote and the literal swallows the rest;
  // in SQLite it does not, so `AdminUser` really is an identifier here.
  const ids = identifiers("UPDATE t SET a='x\\' WHERE b=AdminUser", 'sqlite');
  assert.ok(ids.includes('adminuser'));
});

test('R2: a double-quoted name is an identifier in SQLite, not a string', () => {
  const toks = lex('SELECT "col" FROM t', 'sqlite');
  assert.equal(toks.find((t) => t.value === 'col')?.kind, 'quotedIdent');
  // In MySQL's default sql_mode the same text is a string literal.
  assert.equal(lex('SELECT "col" FROM t', 'mysql').find((t) => t.value === 'col')?.kind, 'string');
});

test('lex: an unterminated [ is refused rather than guessed at', () => {
  assert.throws(() => lex('SELECT * FROM [oops', 'sqlite'), /unterminated/i);
});

test('lex: SQLite raw slices reassemble into the original input exactly', () => {
  const samples = [
    'UPDATE [Order] SET shipDate=\'2026-08-08\' WHERE ref=`R-1` -- note\n',
    'SELECT /* c */ a, "b" FROM t WHERE x=1',
    "SELECT 5--3, 'it''s' FROM t",
  ];
  for (const s of samples) {
    assert.equal(
      lex(s, 'sqlite')
        .map((t) => t.raw)
        .join(''),
      s,
    );
  }
});
