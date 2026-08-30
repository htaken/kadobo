# 実装設計 MVP（稼働記録・経費管理システム）

対象: 要件定義 v1.1（`docs/稼働記録・経費管理システム_要件定義_v1.1.md`）§8 の **MVP フェーズ**
作成: 2026-08-27 ／ 役割: 本書は実装者（Sonnet）が従う**契約**。要件定義と矛盾する場合は本書を優先し、矛盾箇所は §9 に記録する。

---

## 0. 実装体制と原則

- 実装は Sonnet、監督・レビューは Fable。作業パッケージ（§8）単位で指示→実装→レビュー→修正のサイクルを回す
- **決めてあることを勝手に変えない**。本書に無い判断が必要になったら、実装せずに「未決事項」として報告する
- **純粋ロジックと I/O を分離する**。状態機械・集計・封筒検証は外部 API に依存しない純関数として書き、Node の Vitest でテストする。Sheets／Slack／Drive／D1 に触るコードは薄いアダプタに限定する
- 秘密情報（Slack signing secret／bot token／GAS 共有シークレット／GAS URL）はコード・テスト・ドキュメントに書かない。テストではダミー値を使う
- ログに bot token・`response_url`・署名・封筒全文を出さない
- 依存は最小限。フレームワーク（Hono 等）は使わず、素の `fetch` ハンドラで書く

## 1. リポジトリ構成・ツールチェーン

```
kadobo/
  package.json              # npm workspaces: shared, worker, gas。root scripts: test / typecheck / build
  tsconfig.base.json
  .gitignore                # node_modules, dist, .wrangler, .dev.vars, .clasprc.json, gas/.clasp.json は「テンプレートを別名で」管理
  README.md                 # セットアップ・デプロイ・運用手順（§10）
  docs/                     # 要件定義・本書
  shared/                   # @kadobo/shared —— Worker/GAS 双方で動く純粋 TypeScript（DOM/Node API 非依存）
    src/protocol.ts         #   封筒・ペイロード・レスポンスの型と定数
    src/ids.ts              #   冪等キー生成、ULID（乱数源は注入）
    src/time.ts             #   action_ts → ms、JST 変換、業務日計算
    test/
  worker/                   # Cloudflare Worker（TypeScript, wrangler v4）
    wrangler.jsonc          #   D1 binding=DB, crons=["*/5 * * * *", "17 3 * * *"], compatibility_date=2026-08-01 以降
    migrations/0001_journal.sql
    src/index.ts            #   fetch / scheduled のエントリ
    src/slack/verify.ts     #   署名検証
    src/slack/parse.ts      #   payload の型付きパース（block_actions / view_submission / slash command）
    src/slack/api.ts        #   chat.update / views.open / views.update / chat.postMessage / response_url 投稿
    src/journal.ts          #   D1 受付ジャーナル
    src/gas.ts              #   封筒署名・GAS POST・レスポンス判定
    src/handlers/*.ts       #   command / block_actions / view_submission / internal_status
    src/cron.ts             #   再送・N 回失敗通知・30 日削除
    test/                   #   Cloudflare 推奨の Vitest 統合（D1 マイグレーションをテスト前に適用）
  gas/                      # Google Apps Script（TypeScript → esbuild で単一 Code.js）
    .clasp.json.example     #   scriptId は空。実値は .clasp.json（git 管理外）
    appsscript.json         #   timeZone=Asia/Tokyo, runtimeVersion=V8, webapp: executeAs=USER_DEPLOYING, access=ANYONE_ANONYMOUS
    src/core/               #   純粋ロジック（state.ts, aggregate.ts, correction.ts, envelope.ts, card.ts=Block Kit 生成）
    src/adapters/           #   sheets.ts, slack.ts, cache.ts, lock.ts, props.ts, calendar.ts, random.ts
    src/app/                #   ユースケース（stamp.ts, correction.ts, command.ts, triggers.ts）— core を呼び、adapters で I/O
    src/entry.ts            #   doPost / トリガー関数 / setup を globalThis に公開
    build.mjs               #   esbuild: IIFE でバンドル → dist/Code.js。末尾に `function doPost(e){return __kadobo.doPost(e)}` 等のトップレベル宣言を必ず出力
    test/                   #   Vitest（Node）。adapters はインタフェースで差し替え
```

- Node 24／npm workspaces。TypeScript `strict: true`。テストは Vitest
- Worker のテスト方式は Context7 で Cloudflare の最新ドキュメントを確認して選ぶ（`@cloudflare/vitest-pool-workers` または新しい test harness）。**D1 マイグレーションを実際に適用して**テストすること
- GAS ビルド成果物 `dist/Code.js` はエントリポイント（`doPost`, `setupSpreadsheet`, `trigMorningCard`, `trigEveningCheck`, `trigMonthly`, `installTriggers`）を**トップレベルの `function` 宣言**として含むこと（GAS エディタとトリガー設定から見えるようにするため）
- `npm test`（root）で全ワークスペースのテストが通ること。`npm run typecheck` で `tsc --noEmit` が全パッケージ通ること

## 2. Slack 側の識別子（固定）

### 2.1 スラッシュコマンド

| コマンド | 引数 | 動作 |
|---|---|---|
| `/kado` | なし | 当日カードを再表示（無ければ投稿。あれば削除して再投稿） |
| `/kado status` | | 今週・今月の累計を ephemeral 表示（`response_url`） |
| `/keihi` | 任意 | MVP では ephemeral「経費機能は自動化フェーズで提供予定（暫定運用: 紙原本保管＋Drive 手動保存）」を返し GAS へ転送しない |

### 2.2 稼働カードの Block Kit 構造（GAS が生成、Worker は `status` ブロックのみ差し替える）

| `block_id` | 種別 | 内容 |
|---|---|---|
| `header` | section | `📋 稼働記録 2026-09-01（月）` ＋ 現在状態（未稼働／稼働中／休憩中／確定） |
| `warning` | section | 任意。前日が稼働中／休憩中のまま等の警告文 |
| `sessions` | section | 当日の各セッション `#1 09:02 – 12:00（休憩 0:30）`、進行中は `#2 13:00 –` |
| `total` | section | `本日累計 2h 28m`（要修正がある日は `⚠️ 要修正` を併記） |
| `actions` | actions | 状態で有効なボタンのみ（§2.3） |
| `status` | context | 直近イベントの処理状態 `⏳ 開始 09:02 記録中…` ／ `⚠️ 記録待ち（自動再試行中）` ／ `⚠️ 記録に失敗しました（DM をご確認ください）` ／ `✅ 開始 09:02 記録済み` |

`⏳ …記録中…` を表示している間は `actions` ブロックを外す（処理中の二度押し防止）。ボタンは GAS のカード再描画、または Worker の `⚠️` 表示（押下時の blocks を復元する）で戻る。

### 2.3 ボタン `action_id`（`actions` ブロック内）

| `action_id` | 表示 | `value` | 表示される状態 |
|---|---|---|---|
| `kado_start` | 開始 ／ 再開（確定時） | `business_date` | 未稼働、確定 |
| `kado_break_start` | 休憩 | `business_date` | 稼働中 |
| `kado_break_end` | 再開 | `business_date` | 休憩中 |
| `kado_end` | 終了 | `business_date` | 稼働中、休憩中 |
| `kado_correct` | ✏️ 修正 | 修正対象の `business_date`（前日警告のボタンは前日の日付） | 稼働中、休憩中、確定、警告時 |

`business_date` は `YYYY-MM-DD`（JST）。GAS は `value` の日付ではなく**永続状態**で遷移を検証する（`value` は表示・修正対象の指定にのみ使う）。

### 2.4 修正モーダル

- Worker が `views.open` で開くローディングビュー: `callback_id: kado_correction`, `title: 稼働記録の修正`, `private_metadata: JSON({channel_id, message_ts, business_date})`, 本文は section `⏳ 読み込み中…`（submit ボタン無し）
- GAS が `views.update` で差し替える本ビュー（同じ `callback_id`／`private_metadata`）:

| `block_id` | element `action_id` | 種別 | 内容 |
|---|---|---|---|
| `target` | `target_select` | static_select | 当該業務日のイベント一覧（`開始 09:02` 等、`value = event_id`）＋ 末尾に「終了イベントを追加（押し忘れ）」（`value = add_end`）。`add_end` は状態が稼働中／休憩中の時のみ表示 |
| `date` | `date_pick` | datepicker | 初期値 = `business_date` |
| `time` | `time_pick` | timepicker | 初期値 = 対象イベントの現在時刻（選択前は空） |
| `reason` | `reason_input` | plain_text_input | 理由（必須、200 文字以内） |

- Worker の `view_submission` 同期バリデーション: `target`・`date`・`time`・`reason` が空なら `response_action: errors`。全て揃っていれば `response_action: clear` を返し、ジャーナル→GAS 転送
- GAS の業務検証（`LOCKED` 月・遷移不能・イベント不存在）は非同期で DM 通知する

## 3. Worker ↔ GAS プロトコル

### 3.1 封筒（Worker → GAS、GAS → Worker `/internal/status` の双方向で同一形式）

```json
{ "v": 1, "ts": 1756260000, "nonce": "<32 hex>", "payload": "<JSON 文字列>", "sig": "<hex>" }
```

- `ts`: 送信時刻（UNIX 秒、整数）。`nonce`: 16 バイト乱数の hex
- **`payload` は文字列**（送信側が `JSON.stringify` した結果をそのまま入れる）。受信側は署名検証後に `JSON.parse` する。正規化の問題を避けるため、オブジェクトで入れない
- `sig = hex( HMAC-SHA256( secret, `${ts}.${nonce}.${payload}` ) )`
- 受信側の検証: (1) `v === 1`、(2) `|now − ts| ≤ 300`、(3) `nonce` 未使用（GAS: `CacheService` にキー `nonce:<nonce>` を TTL 600 秒で put、既存なら拒否。Worker: D1 `nonces` テーブル、TTL 10 分で削除）、(4) 署名を**定時間比較**。順序は (1)(2)(4)(3)（署名が正しい要求だけ nonce を消費する）
- HMAC の実装は Worker=WebCrypto、GAS=`Utilities.computeHmacSha256Signature(bytes, keyBytes)`。`shared/test/vectors/envelope.json` に Worker 実装で生成したテストベクタ（secret はダミー）を置き、GAS core のテストで同じベクタを検証する（**相互運用の契約テスト**）

### 3.2 ペイロード種別（Worker → GAS）

```ts
type GasRequest =
  | { kind: 'stamp'; idempotency_key: string; user_id: string; channel_id: string; message_ts: string;
      action_id: 'kado_start'|'kado_break_start'|'kado_break_end'|'kado_end';
      occurred_at_ms: number;   // Slack action_ts を ms に変換（§4.1）
      received_at_ms: number;   // Worker 受信時刻
      source: 'button'|'retry'; response_url?: string }
  | { kind: 'open_correction'; idempotency_key; user_id; channel_id; message_ts; view_id: string;
      business_date: string; received_at_ms; source: 'button' }
  | { kind: 'correction_submit'; idempotency_key; user_id; view_id; channel_id; message_ts; business_date;
      target: string /* event_id | 'add_end' */; new_date: string /* YYYY-MM-DD */; new_time: string /* HH:mm */;
      reason: string; received_at_ms; source: 'modal'|'retry' }
  | { kind: 'command'; idempotency_key; user_id; channel_id; text: ''|'status';
      response_url: string; received_at_ms; source: 'command'|'retry' }
```

`source` は再送時に Worker が `'retry'` へ書き換える（GAS はそのまま生ログ `source` 列へ）。

### 3.3 レスポンス（GAS → Worker）

GAS は常に HTTP 200 で JSON を返す（GAS はステータスコードを制御できない）:

```ts
type GasResponse =
  | { ok: true; applied: boolean; reason?: 'DUPLICATE'|'INVALID_TRANSITION'|'LOCKED_MONTH'|'NOT_FOUND'|string }
  | { ok: false; error: string; retryable: boolean }
```

Worker の判定:

| 結果 | ジャーナル `status` | 追加動作 |
|---|---|---|
| HTTP≠200／本文が JSON でない／`ok` 無し／タイムアウト（25 s）／ネットワーク例外 | `pending` のまま、`attempts++`、`last_error` | **カードは触らない**（⏳ のまま）。本人へ ephemeral「記録の反映を確認できませんでした（自動で再試行します）」 |
| `ok:true`（`applied` 問わず） | `done` | なし（カード確定表示は GAS が行う） |
| `ok:false, retryable:true`（`LOCK_TIMEOUT` 等の**適用前エラー**） | `pending` | カード `status` を `⚠️ 記録待ち（自動再試行中）` に（`actions` も復元） |
| `ok:false, retryable:true`（上記以外＝ GAS の総括 catch 由来） | `pending` | **カードは触らない**（⏳ のまま）＋ ephemeral |
| `ok:false, retryable:false` | `rejected` | 本人へ DM（処理 ID・エラー）＋ カード `status` を `⚠️ 記録に失敗しました（DM をご確認ください）` に（`actions` も復元） |

**カードを上書きしてよい条件**（Codex 指摘の「timeout 時の上書き競合」対策）: Worker が持っているのは*押下時点の古い* `blocks` なので、GAS がすでにカードを描き替えていた場合に `chat.update` すると正しい表示を巻き戻してしまう。上書きしてよいのは「GAS がカードに触れていないと確定できる」次の場合だけ:

- `rejected`（GAS が `retryable:false` で明示的に未適用を宣言。かつ Cron 再送されない終局状態なので、戻さないとボタンが消えたままになる）
- `pending` かつエラーコードが `shared` の `GAS_PRE_APPLY_ERRORS`（`UNAUTHORIZED` / `BAD_REQUEST` / `MALFORMED_BODY` / `LOCK_TIMEOUT`＝ユースケース本体に入る前に返るもの）
- `forwarding_enabled='0'` で GAS へ送っていない場合

それ以外（タイムアウト・ネットワーク断・HTTP エラー・GAS の総括 catch）は適用有無が不明なため、カードは ⏳ のまま残して Cron 再送（最大 5 分）で GAS に正しく描き直させる。

- GAS Web アプリは認可エラー等で **HTML を 200 で返す**ことがあるため、必ず JSON パースと `ok` の存在を確認する
- GAS の `/exec` は 302 リダイレクトを返す。Worker の `fetch` は `redirect: 'follow'`（既定）で追従する
- `open_correction` は再送しない（ローディングモーダルは陳腐化する）。初回失敗時は `rejected` とし、Worker が `views.update` でモーダルに「接続できませんでした。閉じてもう一度お試しください」を表示する

### 3.4 Worker の `/internal/status`（GAS 22 時台トリガーが呼ぶ）

- `POST /internal/status`、本文は §3.1 の封筒、`payload = JSON({kind:'status'})`
- 応答: `{ ok:true, pending: n, rejected_24h: n, oldest_pending_at_ms: number|null }`

## 4. 時刻・冪等性・ID

### 4.1 時刻

- Slack の `action_ts`（例 `"1756260000.123456"`）→ `occurred_at_ms`: 文字列を `.` で分割し `秒*1000 + 小数部先頭 3 桁`。浮動小数で計算しない
- `view_submission`・スラッシュコマンドには `action_ts` が無い → `received_at_ms` を採用
- JST 変換は `new Date(ms + 9*3600*1000)` の `getUTC*` で行う（DST 無し。`Intl` に依存しない）。`business_date` は `YYYY-MM-DD`
- 生ログには `occurred_at`（ms, UTC epoch）と `occurred_at_jst`（`YYYY-MM-DD HH:mm:ss`）を両方書く

### 4.2 冪等キー

| 種別 | キー |
|---|---|
| ボタン（stamp / open_correction） | `${user_id}:${message_ts}:${action_id}:${action_ts}` |
| モーダル送信 | `${view_id}:${sha256hex(JSON.stringify(view.state.values)).slice(0,16)}` |
| コマンド | `${user_id}:${trigger_id}` |

- Worker: D1 `journal.idempotency_key UNIQUE`。`INSERT … ON CONFLICT(idempotency_key) DO NOTHING` とし `meta.changes === 0` なら重複→ACK のみ
- GAS: `stamp`／`correction_submit` は**生ログの `idempotency_key` 列**で重複判定する（`TextFinder` 完全一致）。重複なら `{ok:true, applied:false, reason:'DUPLICATE'}` を返し、**カードは再描画する**（前回の Slack 更新失敗を修復するため）。`command`／`open_correction` は本質的に冪等なので判定不要
- GAS の書込処理は `LockService.getScriptLock()`（待機 **10 秒** = `shared` の `GAS_LOCK_WAIT_MS`）で直列化する。Worker 側タイムアウト（`GAS_TIMEOUT_MS` = 25 秒）より十分短くしてあるのが要点で、同値だとロック待ちのリクエストが処理へ進む前に Worker が打ち切られ、「適用済みか未適用か不明」な結果しか残らない。短くしておけば `{ok:false, error:'LOCK_TIMEOUT', retryable:true}` として「確実に未適用」と分かる形で素早く返る
- 重複（`DUPLICATE`）分岐でも**日次・月次の再計算をやり直す**。再送の原因には「生ログ追記までは成功し、その後の再計算で落ちた」ケースが含まれるため、再描画だけで `ok` を返すと集計が欠落したまま D1 が `done` になり復旧しない

### 4.3 ID

- `event_id`: ULID。実装は `shared/src/ids.ts`（乱数源を注入: Worker=`crypto.getRandomValues`、GAS=`Utilities.getUuid()` から得たバイト列）
- ジャーナル `id`: ULID

## 5. D1 スキーマ（`worker/migrations/0001_journal.sql`）

```sql
CREATE TABLE journal (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL,             -- stamp | open_correction | correction_submit | command
  payload          TEXT NOT NULL,             -- GasRequest の JSON（送信するものと同一）
  status           TEXT NOT NULL CHECK (status IN ('pending','done','rejected')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  notified_at      INTEGER,                   -- N 回失敗メンションを送った時刻(ms)
  created_at       INTEGER NOT NULL,          -- ms
  updated_at       INTEGER NOT NULL,
  done_at          INTEGER
);
CREATE INDEX journal_status_created ON journal(status, created_at);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings(key, value) VALUES ('forwarding_enabled', '1');

CREATE TABLE nonces (nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
```

- `forwarding_enabled = '0'` は**停止フラグ**（GAS デプロイ更新中など）。`'0'` の間も Worker は署名検証・ジャーナル記録・ACK・⚠️表示は行い、GAS 転送と Cron 再送だけ止める。切替は `wrangler d1 execute DB --command "UPDATE settings SET value='0' WHERE key='forwarding_enabled'"`
- 削除: `status IN ('done','rejected') AND updated_at < now − 30 日` を日次 Cron で削除。`pending` は削除しない。`nonces` は `seen_at < now − 10 分` を削除

## 6. Worker の処理フロー

### 6.1 共通（`fetch`）

1. `POST` 以外・未知パス → 404。`/slack/interactivity`、`/slack/commands`、`/internal/status` の 3 パス
2. **raw body を文字列で読む**（`request.text()`）。署名検証は raw body に対して行い、検証前にパース・デコードしない
3. 署名検証（`X-Slack-Request-Timestamp` が ±300 秒、`v0=hex(HMAC-SHA256(signing_secret, "v0:" + ts + ":" + body))` を定時間比較）。失敗は 401 + `console.warn`（body・署名は出さない）
4. `application/x-www-form-urlencoded` をパース。interactivity は `payload` フィールドの JSON、commands は各フィールド
5. 種別ごとのハンドラへ

### 6.2 `block_actions`（stamp 系 4 ボタン）

1. 冪等キー生成 → D1 に `pending` で INSERT（重複なら ACK して終了）
2. **即 ACK**（200、空ボディ）
3. `ctx.waitUntil()` 内で順に:
   - `chat.update`: `payload.message.blocks` から `block_id === 'status'` と `block_id === 'actions'` を除去し、末尾に context `⏳ {ラベル} {HH:mm JST} 記録中…` を追加（`text` は元のフォールバック）。`actions` を外すのは処理中の二度押し防止
   - `forwarding_enabled` を確認 → GAS へ POST（§3）→ §3.3 の表に従い D1 更新。失敗時のカード表示は §3.3 の「カードを上書きしてよい条件」に従う（上書きしてよい場合のみ押下時の blocks を復元して `status` を `⚠️` にする。不明な場合はカードを触らず ephemeral のみ）

### 6.3 `block_actions`（`kado_correct`）

1. 即 ACK
2. `waitUntil`: `views.open(trigger_id, ローディングビュー)` → 返った `view.id` を含む `open_correction` をジャーナル INSERT → GAS へ POST → 失敗なら `rejected` にして `views.update` でエラー表示

### 6.4 `view_submission`（`callback_id: kado_correction`）

1. `state.values` から `target`・`date`・`time`・`reason` を取り出し検証。不足は `{response_action:'errors', errors:{<block_id>: <日本語メッセージ>}}` を**同期で**返す
2. OK なら冪等キー生成 → D1 INSERT → `{response_action:'clear'}` を返す
3. `waitUntil`: GAS へ POST（§3）。失敗は `pending` のまま Cron 再送

### 6.5 スラッシュコマンド

1. `/keihi` → 200 `{response_type:'ephemeral', text:…}` で終了（転送しない）
2. `/kado …` → 引数を `''|'status'` に正規化（それ以外は ephemeral で使い方を返す）→ D1 INSERT → 200 `{response_type:'ephemeral', text:'⏳ 処理中…'}` → `waitUntil` で GAS へ POST

### 6.6 `scheduled`

| cron | 処理 |
|---|---|
| `*/5 * * * *` | `forwarding_enabled` を確認 → `status='pending'` を `created_at` 昇順に最大 50 件取得 → `source` を `'retry'` にして GAS へ順に POST（直列。GAS の Lock 競合を避ける）→ §3.3 に従い更新。`attempts` が 6 になった時点、以後 72 回ごと（≒6 時間）に、`payload.channel_id` へ `<@user_id>` メンション（`https://slack.com/archives/<channel>/p<ts の "." 抜き>` のリンク付き）を投稿し `notified_at` 更新 |
| `17 3 * * *` | §5 の 30 日削除・nonce 削除 |

### 6.7 Worker の環境

- Secrets: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `GAS_SHARED_SECRET`, `GAS_URL`
- Bindings: `DB`（D1）
- ローカル: `.dev.vars`（git 管理外）。`wrangler.jsonc` に `database_id` のプレースホルダーと作成コマンドをコメントで記載

## 7. GAS の設計

### 7.1 スプレッドシート（6 シート）

シート名は要件定義どおり日本語。`setupSpreadsheet()` が不足シートとヘッダー行を作り、`生ログ`・`日次集計`・`内部` に警告付き保護をかける。

**生ログ**（追記専用）— 列順固定:
`event_id | idempotency_key | business_date | event_type | occurred_at | occurred_at_jst | received_at | processed_at | source | session_no | memo | correction_of | old_value | new_value | reason`

- `event_type ∈ START | BREAK_START | BREAK_END | END | CORRECTION`
- `CORRECTION` 行は `correction_of`=対象 `event_id`、`old_value`/`new_value`=`occurred_at`(ms)、`reason` 必須。`occurred_at` は訂正操作自体の時刻（`received_at_ms`）、`business_date` は対象イベントの業務日
- 押し忘れの「終了イベントを追加」は `event_type=END, source=modal, memo="手入力（押し忘れ）"`、`occurred_at`=入力された日時

**日次集計**（GAS 再計算、業務日 1 行）:
`business_date | weekday | session_count | first_start_jst | last_end_jst | break_seconds | worked_seconds | worked_minutes | status | correction_count | note | updated_at`
- `status ∈ OK | 要修正 | 進行中`。`要修正`・`進行中` の行は `worked_*` を空にする
- `worked_minutes = floor(worked_seconds / 60)`（暫定丸め。§7.3）

**単価マスタ**（人手）:
`client | unit_price | tax_category(課税|不課税) | tax_inclusive(true|false) | tax_display(区分記載|内税|なし) | rounding(切捨|四捨五入|切上) | withholding(なし|10.21%) | valid_from | valid_to`
- 業務日時点で有効な行（`valid_from ≤ d ≤ valid_to`、`valid_to` 空は無期限）を参照。該当無し・複数該当はエラーとして月次行 `note` に記載

**月次請求**（GAS ＋ 人手）:
`client | month(YYYY-MM) | worked_minutes | hours(2dp) | unit_price | amount | tax_amount | withholding_amount | net_amount | state | mf_invoice_id | locked_at | note | updated_at`
- `state` の初期値 `OPEN`。MVP では `OPEN` と `LOCKED`（人手でセルを変更）のみ意味を持つ。`LOCKED` 以降の月への `CORRECTION` は `{ok:true, applied:false, reason:'LOCKED_MONTH'}` で拒否し DM 通知

**経費台帳**（MVP はシート作成のみ、書込なし）:
`証憑ID | 証憑区分 | 日付 | 金額 | 取引先 | カテゴリ | メモ | Driveリンク | ファイルハッシュ | 元MIME | サイズ | 入力日時 | 処理状態 | MF仕訳ID`

**内部**（汎用 key-value、GAS のみ）:
`kind | key | value | updated_at`

| `kind` | `key` | `value` |
|---|---|---|
| `card` | `${channel_id}:${business_date}` | `message_ts` |
| `setting` | `client_default` 等 | 文字列 |
| `holiday` | `YYYY-MM-DD` | ラベル（任意休業日。人手で追記可） |

> nonce は `CacheService` のみで管理する（要件定義 §5.2 の「＋内部シート」は、5 分の受付窓に対して 10 分の Cache TTL で十分なため MVP では省略。§9 に記録）

### 7.2 状態機械（`gas/src/core/state.ts`、純関数）

```ts
type State = 'IDLE' | 'WORKING' | 'ON_BREAK' | 'CLOSED';   // 未稼働 / 稼働中 / 休憩中 / 確定
type EventType = 'START' | 'BREAK_START' | 'BREAK_END' | 'END';
transition(state, eventType): State | null   // null = 不正遷移
```

| 現在 | START | BREAK_START | BREAK_END | END |
|---|---|---|---|---|
| IDLE | WORKING | ✗ | ✗ | ✗ |
| WORKING | ✗ | ON_BREAK | ✗ | CLOSED |
| ON_BREAK | ✗ | ✗ | WORKING | CLOSED |
| CLOSED | WORKING（session_no+1） | ✗ | ✗ | ✗ |

- 現在状態は「**対象業務日のイベント（訂正適用後）を `occurred_at` 昇順に再生**」して求める。永続状態＝生ログのみ。カードやボタンの `value` は信用しない
- **新イベントの業務日**: 直近の業務日（当日または前日）の再生結果が `WORKING`/`ON_BREAK` なら、その業務日に帰属（跨日）。それ以外は `occurred_at` の JST 日付
- `ON_BREAK` で `END`: 生ログには実際の押下時刻を記録し、集計上の**実効終了時刻＝直前 `BREAK_START` の時刻**とする（開いている休憩は END で閉じる扱い＝結果的に休憩時間は稼働に含まれない）。カードには実効終了時刻を表示
- 不正遷移: 記録せず `{ok:true, applied:false, reason:'INVALID_TRANSITION'}`。`response_url` があり 30 分以内なら ephemeral「すでに稼働中です」等を返し、カードを再描画

### 7.3 集計（`gas/src/core/aggregate.ts`、純関数）— **テストで固定する暫定ルール**

1. 業務日のイベントに訂正を適用（`CORRECTION` は対象 `event_id` の `occurred_at` を `new_value` に置換。複数ある場合は `CORRECTION` の `occurred_at` が最新のものが有効）
2. `occurred_at` 昇順に再生し、`START`〜`END` をセッションに、`BREAK_START`〜`BREAK_END` を休憩に対応付ける
3. セッション秒 = (実効終了 − 開始) − Σ休憩秒。開いた休憩は実効終了で閉じる
4. ペアリング不能（`END` の無い `START` が過去日に残る、`BREAK_END` 単独、`END` 単独、順序矛盾）→ `status='要修正'`、秒は算出しない。当日でまだ `WORKING`/`ON_BREAK` なら `進行中`
5. 日: `worked_seconds = Σセッション秒`、`worked_minutes = floor(worked_seconds/60)`
6. 月: `worked_minutes = Σ日 worked_minutes`、`hours = round(worked_minutes/60, 2)`（`Math.round(x*100)/100`）、`amount = 単価マスタ.rounding(hours × unit_price)`、`tax_amount`・`withholding_amount` は `tax_category`/`withholding` に従う（不課税・なしなら 0）、`net_amount = amount + tax_amount − withholding_amount`

テストベクタ（必ず含める）:
- 09:02:30 開始 → 12:00:10 終了 → 秒 10660 → 177 分（切り捨て）
- 09:00 開始 → 12:00 休憩 → 12:30 再開 → 18:00 終了 → 8h30m
- 09:00 開始 → 12:00 休憩 → 12:40 終了（休憩中に終了）→ 3h00m（実効終了 12:00）
- 同日 2 セッション 09:00–12:00、13:00–15:30 → 5h30m、`session_count=2`
- 跨日 22:00 開始 → 翌 01:30 終了 → 開始日に 3h30m、翌日は 0
- `CORRECTION` で 12:00 終了 → 12:30 に変更 → 変更後の値で集計、元行は不変
- 2 回目の `CORRECTION` が有効（最新勝ち）
- `END` 無し `START`（過去日）→ 要修正、当日なら進行中
- 月: 日次 177 分 ＋ 510 分 = 687 分 → 11.45h

### 7.4 封筒検証（`gas/src/core/envelope.ts`）

- `verifyEnvelope(body, { secret, nowSec, hmacHex: (key, msg) => hex, nonceSeen: (n) => boolean, markNonce: (n) => void })` の形で I/O を注入
- 定時間比較は文字列長比較＋全文字 XOR 累積で実装（早期 return しない）
- `shared/test/vectors/envelope.json` のベクタを検証するテストを含める

### 7.5 `doPost` と ユースケース

```
doPost(e)
  ├─ 封筒検証（失敗 → {ok:false, error:'UNAUTHORIZED', retryable:false}）
  ├─ payload を GasRequest として型検証（失敗 → retryable:false）
  ├─ LockService 取得（20 s。取れなければ {ok:false, error:'LOCK_TIMEOUT', retryable:true}）
  └─ kind ごとに:
       stamp:              重複判定 → 業務日決定 → 遷移検証 → 生ログ追記 → 日次・月次再計算 → カード再描画（chat.update）→ 応答
       open_correction:    業務日のイベント読込 → 本モーダル生成 → views.update → 応答
       correction_submit:  重複判定 → 対象検証（存在／LOCKED 月）→ CORRECTION（または END）追記 → 再計算 → カード再描画 → 応答
       command:            '' → 当日カード再表示（内部 card キーが無ければ postMessage、あれば削除して再投稿）／'status' → 今週・今月累計を response_url へ ephemeral
```

- 例外は捕捉して `{ok:false, error: message, retryable: true}`（Sheets の一時エラー等）。**ただし** 生ログ追記後の Slack 更新失敗は `{ok:true, applied:true}` を返す（記録は成功している。表示は次回再描画で修復）
- 生ログ追記→再計算→Slack 更新の順。追記が成功した時点で「記録済み」

### 7.6 カード描画（`gas/src/core/card.ts`、純関数）

`renderCard({ business_date, state, sessions, totalSeconds, status, lastEvent, warning })` → Block Kit `blocks[]`（§2.2）。曜日は JST。`status` ブロックの文言は §2.2 の 3 種。

### 7.7 時間トリガー（`installTriggers()` が作成。既存トリガーは削除してから作る）

| 関数 | 時刻 | 処理 |
|---|---|---|
| `trigMorningCard` | 毎日 07 時台 | JST の曜日が土日、Google 祝日カレンダー（`CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com')`）の終日イベント、内部 `holiday` のいずれかに該当すれば投稿しない。前日の再生結果が `WORKING`/`ON_BREAK` なら `warning` ブロック＋前日向け `kado_correct` を付けて投稿 |
| `trigEveningCheck` | 毎日 22 時台 | 当日が `WORKING`/`ON_BREAK` → チャンネルへメンション＋`kado_correct`（当日）ボタン。Worker `/internal/status` の `pending > 0` → 通知。過去 7 日の日次に `要修正` → 一覧を通知 |
| `trigMonthly` | 毎月 1 日 06 時台 | 前月の日次を再計算し、月次請求行を更新（`state` は変更しない）。要修正一覧と月合計をチャンネルへ投稿 |

### 7.8 Script Properties

`SLACK_BOT_TOKEN`, `GAS_SHARED_SECRET`, `WORKER_STATUS_URL`, `SPREADSHEET_ID`, `SLACK_CHANNEL_ID`, `SLACK_USER_ID`, `CLIENT_DEFAULT`（既定 `A社`）

### 7.9 Slack API アダプタ（GAS）

`UrlFetchApp` で `chat.postMessage` / `chat.update` / `views.update` / `conversations.open`＋`chat.postMessage`（DM）/ `response_url` への POST。`muteHttpExceptions: true`、`ok:false` は例外化。トークンはログに出さない。

## 8. 作業パッケージと受入条件

| WP | 内容 | 受入条件 |
|---|---|---|
| **WP0** 足場 | §1 のリポジトリ構成、workspaces、tsconfig、Vitest、wrangler.jsonc（D1・crons）、migrations、clasp 設定、esbuild ビルド、`.gitignore`、README 骨子。`shared` の実装（protocol 型・冪等キー・ULID・時刻）とテスト。各パッケージにスモークテスト | `npm install && npm test && npm run typecheck && npm run build` が通る。`gas/dist/Code.js` にトップレベル関数宣言がある |
| **WP1** Worker | §3・§4・§5・§6 の全実装とテスト | 署名（正／不正／古い ts）、3 種パース、D1 冪等 INSERT、GAS 応答→status マッピング（HTML 200・タイムアウト・retryable 両方）、Cron 再送・6 回通知・30 日削除、停止フラグ、`view_submission` の errors 応答、`/keihi` の定型応答、`/internal/status`。テストベクタ `shared/test/vectors/envelope.json` を生成 |
| **WP2** GAS core | §7.2〜7.4・7.6 の純関数とテスト | 遷移表の全セル、業務日・跨日、§7.3 のテストベクタ全件、訂正の最新勝ち、封筒検証（窓・nonce 再利用・署名不一致・定時間比較・契約ベクタ）、カード描画のスナップショット |
| **WP3** GAS app | §7.1・7.5・7.7〜7.9 のアダプタ・ユースケース・エントリ・`setupSpreadsheet`・`installTriggers` | アダプタをフェイクに差し替えたユースケーステスト（stamp 正常／重複／不正遷移／Slack 更新失敗時の応答、correction_submit、command 3 種、trigEveningCheck の 3 通知）。`npm run build` で `dist/Code.js` 生成 |
| **WP4** 統合・手順 | README（Slack アプリ manifest、Worker/GAS デプロイ、Secrets、初期セットアップ、停止フラグ、障害対応）、§8.1 受入試験チェックリスト（要件定義）を手順書化 | 監督者が手順どおりに読んで欠落が無いこと |

## 9. 要件定義 v1.1 からの差分・補足（実装上の決定）

| # | 項目 | 決定 | 理由 |
|---|---|---|---|
| 1 | GAS の処理済みキー | 内部シートの別リストではなく、生ログの `idempotency_key` 列で判定 | 二重帳簿を避け、追記の原子性を単純化 |
| 2 | nonce の永続化 | `CacheService` のみ（内部シートへは書かない） | 受付窓 5 分 < Cache TTL 10 分で十分。シート書込を減らす |
| 3 | 休憩中の終了 | 生ログは実押下時刻、集計・表示は直前 `BREAK_START` を実効終了とする | 生ログの真実性を保ちつつ要件の結果を満たす |
| 4 | 押し忘れの終了入力 | 修正モーダルの「終了イベントを追加」で `END`（source=modal）を追記 | 専用モーダルを増やさない |
| 5 | `open_correction` の再送 | 行わない（初回失敗で `rejected`＋モーダルにエラー表示） | 陳腐化した `view_id` への再送は無意味 |
| 6 | 停止フラグ | D1 `settings.forwarding_enabled` | 再デプロイ不要で切替可、Cron からも参照可 |
| 7 | 修正モーダル | `date` を持たせ、跨日の修正を明示的に指定可能にする | 時刻のみでは跨日が曖昧 |
| 8 | `/keihi` | Worker が定型 ephemeral のみ返す | MVP スコープ外（暫定運用） |

## 10. README に含める手順（WP4 で作成）

1. Slack アプリ作成（manifest JSON を同梱: slash commands 2 つ、interactivity URL、scopes `commands chat:write files:read im:write`）、Bot をプライベートチャンネルに招待、`SLACK_USER_ID`／`SLACK_CHANNEL_ID` の取得方法
2. Cloudflare: `wrangler login`、`wrangler d1 create kadobo-journal` → `database_id` 設定、`wrangler d1 migrations apply`、`wrangler secret put` ×4、`wrangler deploy`、Request URL 設定
3. GAS: スプレッドシート作成 → `SPREADSHEET_ID`、`clasp login`、`clasp create`（or 既存 scriptId）、`npm run build && clasp push`、Web アプリとしてデプロイ（自分として実行／全員（匿名））、Script Properties 設定、`setupSpreadsheet`・`installTriggers` を 1 回実行、GAS URL を Worker Secret へ
4. 動作確認: `/kado` → カード投稿 → 開始／休憩／再開／終了 → 生ログ・日次を確認
5. 受入試験（要件定義 §8.1）の手順: 連打・古いカード・GAS 停止（`forwarding_enabled=0` で疑似）→ 復旧 → Cron 再送で `action_ts` どおり記録・✅ 表示、休憩中終了、2 セッション、修正モーダル、不正署名／古い ts／偽封筒
6. 運用: GAS 再デプロイ手順（停止フラグ→デプロイ→解除）、失敗通知への対処、月次締め（MVP は手動転記）
