# llm-safe-sql

[![CI](https://github.com/hyuga611/llm-safe-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/hyuga611/llm-safe-sql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hyuga/llm-safe-sql.svg)](https://www.npmjs.com/package/@hyuga/llm-safe-sql)

*[日本語は下にあります](#日本語)*

**Let a language model propose an `UPDATE` or `DELETE`. Run it for real inside a
transaction, measure the actual before/after values, and always roll back. Show a
human the measurement. Only then, on their word, do it for real.**

The confirmation is not a prediction and not a summary the model wrote. It is
what the database itself did when the statement ran.

---

## The problem this exists for

Every "AI agent with database access" ends the same way: the model writes SQL,
something asks *"Run this?"*, and a person clicks yes based on a sentence the
model wrote about its own SQL.

That sentence is a guess, and so is any static analysis of the statement.
`SET price = price * 1.1` is an expression. Triggers fire. Defaults apply. `WHERE
status = 'pending'` matches whatever it matches at the moment it runs, which is
not the moment it was written. Nothing short of executing the statement can tell
you what it does — so this executes it, and then takes it back.

Here is a real case from this library's own test suite, which an earlier version
of it got wrong:

```sql
UPDATE members SET quota = quota + 10, profile = '{"role":"admin"}' WHERE id = 7
```

A confirmation that compares values with `String(a) === String(b)` reports
`quota: 5 → 15` and says nothing else, because `String({role:'user'})` and
`String({role:'admin'})` are both `[object Object]`. The privilege escalation
rides along under an approved quota change and is never displayed. The same hole
swallows every JSON, JSONB, array and binary column, and every 64-bit id that a
driver hands back as a float.

That class of bug is the reason this library compares by type and by content, and
the reason [SPEC.md](SPEC.md) exists as a testable list rather than a description.

## What it does

```
  model                    llm-safe-sql                        human
    │                           │                                │
    ├── "UPDATE orders …" ─────►│                                │
    │                           ├── BEGIN                        │
    │                           ├── SELECT … (before)            │
    │                           ├── UPDATE …      ← really runs  │
    │                           ├── SELECT … (after)             │
    │                           ├── ROLLBACK, then prove it      │
    │◄── plan id + card ────────┤                                │
    │                           ├── card ───────────────────────►│
    │                           │                                ├── reads it
    │                           │◄── approve (different tool) ───┤
    │                           ├── lock rows, check unchanged   │
    │                           ├── execute, reconcile, COMMIT   │
```

The model gets a plan id. It cannot approve and it cannot apply — not because
those tools are guarded, but because they are in a different process that the
model has no path to. The two halves can run as different OS users against
different database accounts, so the separation survives a bug in this library.

## What a confirmation card looks like

```
Plan 6f5a1c8e-... — proposed, not applied. Nothing in the database has changed.

  UPDATE orders SET status = 'shipped' WHERE id = 42

What this touches
  orders — Changing an order moves money: the ship date decides which month
           the supplier is paid in.
  1 row would change, across 1 column: status

Measured by running the statement and rolling it back
  id = 42
      status: 'pending' -> 'shipped'

This needs a person. Neither the assistant nor this tool can approve it:
  llm-safe-sql approve 6f5a1c8e-... --as you@example.com
  llm-safe-sql apply   6f5a1c8e-... --as you@example.com
```

The sentence under **What this touches** is required configuration. Without it a
non-engineer is being shown column names and asked to judge them, which they
cannot do — so a table with no declared consequence cannot be written at all.

## Try it without setting up a database

SQLite ships inside Node, so there is no server, no container and no credential
to arrange. Copy this and watch the rollback happen to a real file.

```bash
mkdir demo && cd demo && npm install @hyuga/llm-safe-sql

cat > seed.mjs <<'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('app.db');
db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, ref TEXT NOT NULL, status TEXT NOT NULL)");
db.exec("INSERT INTO orders VALUES (1,'R-1','packed'),(2,'R-2','packed'),(3,'R-3','shipped')");
EOF
node seed.mjs

cat > llm-safe-sql.config.json <<'JSON'
{
  "dialect": "sqlite",
  "connection": { "file": "app.db" },
  "policy": {
    "allow": ["orders"],
    "impact": { "orders": "Marking an order shipped emails the customer." }
  }
}
JSON

npx llm-safe-sql check
npx llm-safe-sql migrate
npx llm-safe-sql plan "UPDATE orders SET status='shipped' WHERE status='packed'"
```

The card that comes back names the two rows and the values they would move
between. Then check the table:

```bash
node -e "const{DatabaseSync}=require('node:sqlite');
console.log(new DatabaseSync('app.db').prepare('SELECT id,status FROM orders').all())"
# id 1 and 2 are still 'packed'
```

The statement really ran. The values on the card were read back out of the
database after it ran. And the rows are still as they were, because the
transaction was rolled back — which is the entire claim, demonstrated in about a
minute on a file you can delete afterwards.

`npx llm-safe-sql approve <id> --as you@example.com` and then `apply` will
commit it, and only then does anything change.

**Requires Node 24 or later** (`node:sqlite` ships unflagged from Node 23.4).
MySQL and PostgreSQL work on Node 20+.

## Quick start

```bash
npm install @hyuga/llm-safe-sql pg        # or: mysql2, or nothing at all for sqlite
npx llm-safe-sql init > llm-safe-sql.config.json
$EDITOR llm-safe-sql.config.json          # name your tables and what they mean
export LLM_SAFE_SQL_PASSWORD=…

npx llm-safe-sql check                    # verifies the environment, per table
npx llm-safe-sql migrate                  # creates the plan + audit tables
```

`check` is worth reading. It reports, per table, whether a dry run is even
possible there — a non-transactional storage engine, a missing primary key, a
foreign key that cascades, a trigger whose columns you have not declared. Each of
those is a case where a plan would either be refused later or, worse, be wrong.

Then propose, approve and apply:

```bash
npx llm-safe-sql plan "UPDATE orders SET status='shipped' WHERE id=42"
npx llm-safe-sql approve <id> --as you@example.com
npx llm-safe-sql apply   <id> --as you@example.com
```

### Giving it to an assistant

```bash
claude mcp add database -- npx -y -p @hyuga/llm-safe-sql llm-safe-sql-mcp \
  --config /absolute/path/to/llm-safe-sql.config.json
```

or, for any MCP client that reads a JSON config:

```json
{
  "mcpServers": {
    "database": {
      "command": "llm-safe-sql-mcp",
      "args": ["--config", "/absolute/path/to/llm-safe-sql.config.json"],
      "env": { "LLM_SAFE_SQL_PASSWORD": "…" }
    }
  }
}
```

The assistant gets four tools: `sql_read`, `sql_plan`, `sql_plan_status` and
`sql_schema`. There is no fifth one.

### Using it as a library

```ts
import { Engine, Applier, Policy, SqlPlanStore, recordPlan } from '@hyuga/llm-safe-sql';
import { PostgresAdapter } from '@hyuga/llm-safe-sql/postgres';

const policy = new Policy({
  allow: ['orders'],
  impact: { orders: 'Changing an order moves money: the ship date decides the payment month.' },
  denyIdentifiers: { password_hash: 'a stored credential' },
});

const engine = new Engine({ adapter: await PostgresAdapter.connect(planningCreds), policy });
const plan   = await engine.plan("UPDATE orders SET status='shipped' WHERE id=42");

// plan.rows[0] === { key: {id: 42}, changed: ['status'],
//                    before: {status: 'pending'}, after: {status: 'shipped'} }
```

## What it refuses, and why

Refusing is always safe; a plan that describes something other than what will
happen is not. Every rule below exists because the alternative produces a
confirmation card that disagrees with the database.

| Refused | Because |
|---|---|
| A table you did not allowlist | Default deny. A denylist has to predict every dangerous name; an allowlist only has to know the safe ones, which you do know |
| `INSERT` | There is no "before" for a row that does not exist yet |
| No `WHERE` | Every row is the target |
| `JOIN`, multi-table `UPDATE a, b SET …` | Rows cannot be shown one-to-one, and the second table never appears on the card |
| `ORDER BY` / `LIMIT` on a write | Which rows are affected stops being determined |
| `now()`, `rand()`, `nextval()` in the statement | The rows shown are provably not the rows changed, and the value written was never displayed |
| A table with an inbound `ON DELETE CASCADE` | Approving one row would silently destroy rows in another table, irreversibly |
| A non-transactional table (MyISAM, a foreign table) | The "dry run" would be a permanent write, announced as harmless |
| A table with no primary key | Rows cannot be shown to you one by one |
| A trigger, on a dialect that cannot report auto-maintained columns | Guessing "none" makes every plan fail to confirm with an error that looks like a concurrency problem |
| A statement that matched nothing, or changed nothing | Nothing to approve |
| More rows than the ceiling | Every row is displayed individually; the ceiling is what a person can actually read |
| Reading a column you marked secret — under any alias | To read a column you must name it, so matching the *reference* cannot be aliased around |
| The library's own plan and audit tables, always | A model that can write the plan table can approve its own writes |

At apply time it also refuses if the rows have moved on: a different set now
matches the condition, or a value you approved is no longer what is there.

**And it does not refuse for reasons that are not real.** Somebody else editing a
column your plan does not touch is not a conflict. A concurrent write during the
dry run is not a failed rollback. A statement refused before it ran does not
report a rollback problem. Those three were bugs here, found by adversarial
review, and each has a test named after it — because a safety check that cries
wolf is a safety check somebody eventually switches off.

## What it does not do

- **`INSERT`** — no before-image to show. Use an ordinary migration.
- **Schema changes**, even where the dialect could roll them back.
- **Bulk work.** The ceiling is a few hundred rows, by design: every row is shown.
- **Protect you from a compromised applier.** The apply path holds a credential
  that can write. Point it at a different database user from the planning one.

## Measured, not assumed

Facts marked 🔬 in [SPEC.md](SPEC.md) were established by measuring MySQL 8.4.11
and PostgreSQL 16.14 in CI, not by reading documentation. Where measurement
contradicted the docs, the measurement won. A few that change how this is built:

| | MySQL | PostgreSQL | SQLite |
|---|---|---|---|
| Statement timeout on a **write** | **None** — `max_execution_time` is read-only statements only | `statement_timeout` applies | **None at all** — said on every card |
| A statement cut short by a timeout | can return **success** | raises | n/a |
| Row locks after `ROLLBACK TO SAVEPOINT`, when the caller wrote first | **retained** to end of transaction | released | no row locks exist |
| DDL in a transaction | commits implicitly | transactional | transactional |
| "rows affected" can mean "rows changed" | yes | no | no |
| 64-bit integers arrive as | strings | strings | `bigint` |

The third row is why a dry run always gets its own connection: nested inside
your transaction, on MySQL, it would hold exclusive locks on rows it only
pretended to touch. Testing only the easy shape — savepoint first, then write —
gives the comfortable and wrong answer that locks are always released.

SQLite has no row locks to retain, so it takes the whole-database write lock up
front with `BEGIN IMMEDIATE` instead; that is what makes the apply's
check-then-write atomic without a `FOR UPDATE` to append. Its missing statement
timeout is not hidden in this table — the adapter declares it and the engine
prints it as a warning on every confirmation card, because a limit that is
configured, believed and absent is the exact failure this library was built
after.

## Dependencies

None at runtime. The database driver (`pg` or `mysql2`) is an optional peer, so
you install the one you use. The MCP server speaks the protocol directly rather
than through the official SDK, whose dependency tree is an HTTP server, a JWT
library and thirty-odd other packages that a stdio server never executes. For a
program that sits between a language model and a production database, a tree an
operator can actually audit is worth more than the convenience.

## Contributing

Real bug reports are the most useful thing, especially "it refused something it
should not have" — false refusals are as much a defect here as false approvals.
See [CONTRIBUTING.md](CONTRIBUTING.md); every rule in [SPEC.md](SPEC.md) has an
id, and tests are named after it.

MIT licensed.

---

<a name="日本語"></a>

# 日本語

**LLM に `UPDATE` / `DELETE` を書かせ、それをトランザクション内で実際に実行し、
変更前後の値を実測してから必ずロールバックする。人間はその実測値を見て承認し、
承認された内容だけが本番に適用される。**

確認画面に出るのは予測でも、モデルが自分の SQL について書いた要約でもありません。
その文を実行したときにデータベースが実際にやったことです。

## なぜ必要か

「DB に触れる AI エージェント」はたいてい同じ終わり方をします。モデルが SQL を書き、
「これを実行しますか？」と聞かれ、人間はモデル自身が書いた説明文を根拠に承認する。

その説明文は推測です。文を静的に解析しても同じことです。`SET price = price * 1.1`
は式であり、トリガーは発火し、デフォルト値は適用され、`WHERE status = 'pending'`
が何行に当たるかは「実行した瞬間」に決まります。実行する以外に知る方法はない。
だからこのライブラリは実行し、そして取り消します。

このライブラリ自身のテストにある実例です（初期版はこれを取りこぼしました）:

```sql
UPDATE members SET quota = quota + 10, profile = '{"role":"admin"}' WHERE id = 7
```

値の比較を `String(a) === String(b)` で行う確認画面は `quota: 5 → 15` だけを表示します。
`String({role:'user'})` も `String({role:'admin'})` も `[object Object]` だからです。
**権限昇格が、承認された数量変更に相乗りして一切表示されません。** 同じ穴が JSON・
JSONB・配列・バイナリの全列と、ドライバが浮動小数で返す 64bit id を飲み込みます。

この種の欠陥があるため、比較は型と内容で行い、[SPEC.md](SPEC.md) は説明ではなく
テスト可能な規則の一覧になっています。

## 動作

1. モデルが `sql_plan` で文を提案する
2. エンジンがトランザクション内で**本当に実行**し、前後の行を読み、必ず ROLLBACK し、
   ロールバックされたことを**読み直して証明**する
3. 実測値からなる確認カードと plan id を返す
4. 人間が別のコマンド（別プロセス・別 DB 認証情報）で承認する
5. 適用時にもう一度、対象行をロックして「承認したときの値のままか」を確認してから実行し、
   件数と結果を照合してからコミットする

モデルは承認も適用もできません。ツールを隠しているからではなく、**モデルから到達
できない別プロセスにあるから**です。OS ユーザーも DB アカウントも分けられるので、
この分離はこのライブラリにバグがあっても成立します。

## DB を用意せずに試す

SQLite は Node に内蔵されているので、サーバもコンテナも認証情報も要りません。
下をそのまま貼れば、**実ファイルに対してロールバックが起きるところ**が見られます。

```bash
mkdir demo && cd demo && npm install @hyuga/llm-safe-sql

cat > seed.mjs <<'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('app.db');
db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, ref TEXT NOT NULL, status TEXT NOT NULL)");
db.exec("INSERT INTO orders VALUES (1,'R-1','packed'),(2,'R-2','packed'),(3,'R-3','shipped')");
EOF
node seed.mjs

cat > llm-safe-sql.config.json <<'JSON'
{
  "dialect": "sqlite",
  "connection": { "file": "app.db" },
  "policy": {
    "allow": ["orders"],
    "impact": { "orders": "出荷済みにすると顧客にメールが飛びます。" }
  }
}
JSON

npx llm-safe-sql check
npx llm-safe-sql migrate
npx llm-safe-sql plan "UPDATE orders SET status='shipped' WHERE status='packed'"
```

確認カードに、2 行がどの値からどの値に変わるかが出ます。そのうえで中身を見てください。

```bash
node -e "const{DatabaseSync}=require('node:sqlite');
console.log(new DatabaseSync('app.db').prepare('SELECT id,status FROM orders').all())"
# id 1 と 2 は 'packed' のままです
```

**SQL は本当に実行されました。** カードの値は、実行した後のデータベースから読み出した
ものです。それでも行は元のままです——ロールバックしたからです。これがこのライブラリの
主張のすべてで、消してよいファイル 1 つで 1 分あれば確認できます。

`npx llm-safe-sql approve <id> --as you@example.com` のあと `apply` して、
そこで初めてデータが変わります。

**Node 24 以降が必要**です（`node:sqlite` は Node 23.4 からフラグ無しで使えます）。
MySQL と PostgreSQL は Node 20 以降で動きます。

## 使い方

```bash
npm install @hyuga/llm-safe-sql pg        # または mysql2、sqlite なら追加インストール不要
npx llm-safe-sql init > llm-safe-sql.config.json
# 設定ファイルに「触れてよいテーブル」と「そのテーブルを変えると業務上どうなるか」を書く
export LLM_SAFE_SQL_PASSWORD=…

npx llm-safe-sql check      # 環境とテーブルごとの可否を検査
npx llm-safe-sql migrate    # plan / audit テーブルを作成

npx llm-safe-sql plan "UPDATE orders SET status='shipped' WHERE id=42"
npx llm-safe-sql approve <id> --as you@example.com
npx llm-safe-sql apply   <id> --as you@example.com
```

`check` の出力は一読の価値があります。テーブルごとに、そもそも試走が可能かを報告します
——非トランザクションなストレージエンジン、主キーなし、カスケードする外部キー、
宣言されていないトリガー列。いずれも後で拒否されるか、もっと悪いことに、
**誤った plan が作られる**条件です。

アシスタントに渡す:

```bash
claude mcp add database -- npx -y -p @hyuga/llm-safe-sql llm-safe-sql-mcp \
  --config /絶対パス/llm-safe-sql.config.json
```

アシスタントに渡るツールは `sql_read` / `sql_plan` / `sql_plan_status` / `sql_schema`
の 4 つだけです。5 つめはありません。

## 「業務上の意味」は必須設定です

確認カードの先頭に出る一文——「この注文を変えると支払月が動く」——は設定必須項目で、
これが無いテーブルには書き込みできません。理由は単純で、これが無い確認画面は
**列名と値の一覧**でしかなく、非エンジニアには判断できないからです。判断できない人に
承認させる仕組みは、承認しているように見えて何も守っていません。

## 何を拒否するか

allowlist 外のテーブル、`INSERT`、`WHERE` なし、`JOIN`・複数テーブル更新、
書き込みの `ORDER BY` / `LIMIT`、`now()` や `rand()` を含む文、`ON DELETE CASCADE`
が刺さっているテーブル、非トランザクションなテーブル、主キーの無いテーブル、
自動更新列を報告できない方言でのトリガー付きテーブル、0 件・変化なし、上限行数超過、
別名を付けても秘密列の参照、そして常にこのライブラリ自身の plan / audit テーブル。

**そして、実在しない理由では拒否しません。** 他人が別の列を編集していることは競合では
ないし、試走中の他セッションの書き込みはロールバック失敗ではないし、実行前に拒否した
文は「巻き戻せなかった」とは報告しません。この 3 つはいずれも実際にあったバグで、
敵対的レビューで発見され、それぞれに名前付きのテストがあります——**誤報を出す安全装置は、
いずれ切られる安全装置**だからです。

## 実測に基づく方言差

[SPEC.md](SPEC.md) の 🔬 印は、ドキュメントではなく MySQL 8.4.11 と PostgreSQL 16.14 を
CI 上で実測して確定した事実です。ドキュメントと食い違った場合は実測を採用しています。

| | MySQL | PostgreSQL | SQLite |
|---|---|---|---|
| **書き込み**の実行時間制限 | **無い**（`max_execution_time` は SELECT 専用） | `statement_timeout` が効く | **そもそも無い**（カードに毎回明記） |
| タイムアウトで切られた文 | **成功**として返りうる | エラーになる | 該当なし |
| 先に書いてから張った SAVEPOINT のロールバック後の行ロック | **保持されたまま** | 解放される | 行ロックが存在しない |
| トランザクション内の DDL | 暗黙コミット | トランザクショナル | トランザクショナル |
| 「影響行数」が「変更行数」を意味しうるか | する | しない | しない |
| 64bit 整数の受け取り型 | 文字列 | 文字列 | `bigint` |

3 行目が、試走に必ず専用接続を与える理由です。あなたのトランザクションの内側で走らせると、
MySQL では「触ったふりをしただけの行」に排他ロックが残ります。SAVEPOINT を先に張る
簡単な形だけを試すと「ロックは常に解放される」という**心地よく間違った**結論が出ます。

SQLite には保持される行ロックがありません。代わりに `BEGIN IMMEDIATE` で
**DB 全体の書き込みロックを最初に取る**ので、`FOR UPDATE` を付けなくても
「確認してから書く」が不可分になります。実行時間制限が無いことは表の中に埋めず、
アダプタが自己申告し、エンジンが**確認カードに毎回警告として印字**します。
設定されていて、信じられていて、実は効いていない制限——それがこのライブラリを
作るきっかけになった不具合そのものだからです。

なお SQLite は 64bit 整数を `bigint` で返します。JS の数値は 53bit しか持てないため、
`9223372036854775806` と `9223372036854775807` は数値にすると**同じ値**になります。
そこだけが違う更新は「変化なし」と判定されてカードから消えます。これは
マイクロ秒のタイムスタンプをミリ秒の `Date` で読んでいた既知の不具合と同じ形なので、
テストで固定してあります。

## 依存

実行時ゼロ。DB ドライバ（`pg` / `mysql2`）は optional peer なので使う方だけ入れます。
MCP サーバは公式 SDK を使わずプロトコルを直接話します。SDK の依存ツリーには HTTP
サーバ・JWT ライブラリなど、stdio サーバが一度も実行しない 30 以上のパッケージが
含まれるためです。**LLM と本番 DB の間に立つプログラム**では、運用者が実際に監査できる
依存ツリーのほうが利便性より価値があります。

MIT ライセンス。バグ報告、特に「拒否されるべきでないものが拒否された」という報告を歓迎します。
