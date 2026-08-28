# kadobo — 稼働記録・経費管理システム（MVP）

個人事業主（本人）が Slack のボタン操作だけで、業務委託の**稼働時間を請求根拠として正確に記録**するための自己管理ツール。
経費のレシート・台帳管理も将来的に同じ仕組みに統合する（MVP では暫定運用）。月次の請求書作成はマネーフォワード（MF）連携で半自動化する計画（自動化フェーズ）。

本システムは委託元が指定・管理する勤怠システムではなく、**受託者自身が所有・運用する自己記録ツール**である。Slack ワークスペース・データはすべて本人が所有し、委託元へは月次の確定レポートのみ共有する。運用者は本人のみで、Slack は本人所有ワークスペースの本人だけが参加するプライベートチャンネルで使う（要件定義 §1）。

詳細な設計は [`docs/実装設計_MVP.md`](docs/実装設計_MVP.md)、要件は
[`docs/稼働記録・経費管理システム_要件定義_v1.1.md`](docs/稼働記録・経費管理システム_要件定義_v1.1.md) を参照。

**記録の「正」は Google スプレッドシート（生ログ）、法定帳簿の「正」はマネーフォワード（MF）。** Cloudflare D1 は Slack↔GAS 間の受付ジャーナル（at-least-once 配送の担保）であり、記録そのものの正ではない（保持 30 日で削除）。

## アーキテクチャ概要

```
Slack（本人所有ワークスペース／プライベートチャンネル #稼働記録）
  │ ボタン押下・スラッシュコマンド・モーダル送信
  │ Request URL: /slack/interactivity, /slack/commands
  ▼
Cloudflare Worker  ……署名検証・D1ジャーナル・即時ACK・chat.update(⏳)・Cron再送
  │ Worker→GAS: HTTP POST（本文はHMAC署名付き封筒、タイムアウト20s）
  │ GAS→Worker: POST /internal/status（同じ封筒形式）
  ▼
Cloudflare D1（受付ジャーナル、30日保持。記録の正ではない）
  │
  ▼
GAS Webアプリ（doPost）……状態遷移検証・冪等性・生ログ追記・集計・カード確定表示
  ├─▶ Google スプレッドシート（生ログ／日次集計／単価マスタ／月次請求／経費台帳／内部）— 記録の正
  ├─▶ Google Drive（証憑ファイル。MVPは手動保存が中心）
  ├─▶ Slack Web API（chat.postMessage / chat.update / views.update / DM通知）
  └─▶ マネーフォワード クラウド請求書 API（自動化フェーズ）— 法定帳簿の正
```

役割分担の詳細は実装設計 §0・§3、要件定義 §3 を参照。

## リポジトリ構成

```
kadobo/
  package.json                # npm workspaces: shared, worker, gas。root scripts: test / typecheck / build
  tsconfig.base.json           # 共通 tsconfig（strict: true）
  shared/                      # @kadobo/shared — Worker/GAS 双方で動く純粋 TypeScript（DOM/Node API 非依存）
    src/protocol.ts            #   封筒・GasRequest/GasResponse の型と定数（ENVELOPE_VERSION 等）
    src/ids.ts                 #   冪等キー生成・ULID
    src/time.ts                #   action_ts → ms、JST 変換、業務日計算
    test/vectors/envelope.json #   Worker↔GAS の HMAC 契約テストベクタ（デプロイ時の実地確認に使用。後述）
  worker/                      # Cloudflare Worker（TypeScript, wrangler ^4）
    wrangler.jsonc              #   D1 binding=DB、Cron Triggers、compatibility_date
    migrations/0001_journal.sql #   D1 スキーマ（journal / settings / nonces）
    src/index.ts                 #   fetch（/slack/interactivity, /slack/commands, /internal/status）/ scheduled のエントリ
    src/handlers/                #   command.ts, stamp.ts, correct.ts, view_submission.ts, status.ts
    src/cron.ts                  #   pending 再送・N 回失敗通知・30 日削除
    test/                        #   Vitest。D1 マイグレーションを適用してテスト
  gas/                         # Google Apps Script（TypeScript → esbuild で単一 Code.js）
    appsscript.json              #   timeZone=Asia/Tokyo、webapp executeAs/access、oauthScopes
    .clasp.json.example          #   `.clasp.json` を作る際のひな形（git 管理外。scriptId は空）
    build.mjs                    #   esbuild ビルド → dist/Code.js（GASのトップレベル関数宣言つき）
    src/core/                    #   純粋ロジック（状態機械・集計・封筒検証・カード生成）
    src/adapters/                #   sheets.ts, slack.ts, cache.ts, lock.ts, props.ts, triggers.ts, hmac.ts 等
    src/app/                     #   ユースケース（stamp.ts, correction.ts, command.ts, triggers.ts, dispatch.ts）
    src/entry.ts                  #   doPost / setupSpreadsheet / installTriggers / trig* を globalThis に公開
    test/                         #   Vitest（Node）。adapters はフェイクに差し替えてテスト
  docs/
    実装設計_MVP.md
    稼働記録・経費管理システム_要件定義_v1.1.md
    受入試験チェックリスト.md
    未決事項・デプロイ前確認.md
```

## コマンド

ルートから全ワークスペースに対して実行できる：

| コマンド | 内容 |
|---|---|
| `npm install` | 依存関係のインストール（npm workspaces） |
| `npm test` | 全ワークスペースの Vitest を実行（shared/worker/gas 合計 271 件） |
| `npm run typecheck` | 全ワークスペースで `tsc --noEmit` |
| `npm run build` | `gas`: esbuild で `gas/dist/Code.js` を生成。`worker`: `wrangler deploy --dry-run --outdir dist` でバンドルを検証 |

個別ワークスペースに対しては `npm run <script> --workspace=<shared|worker|gas>` で実行できる。
`worker` には `npm run types --workspace=worker`（`wrangler types` で D1 等のバインディング型を生成）、
`gas` には `npm run push --workspace=gas`（`clasp push`）もある。

## 前提条件

- Node.js 24 以上（`package.json` の `engines.node`）
- Cloudflare アカウント（Workers Free プランで可。D1・Cron Triggers を使用）
- Google アカウント（**2 段階認証を有効化**。GAS・スプレッドシート・Drive を本人単独で運用する）
- 本人が所有する Slack ワークスペース。**配布しないシングルワークスペースアプリ**として作成する（要件定義 §3.2）
- （任意・自動化フェーズ）マネーフォワード クラウド請求書のアカウント・API 利用可否は §7 要確認事項を参照

---

## 1. Slack アプリ設定

### 1.1 App Manifest からアプリを作成する

`https://api.slack.com/apps` → **Create New App** → **From an app manifest** → 対象ワークスペースを選択 →
以下の YAML を貼り付けて作成する（JSON でも同義）。

> **注意**: `slash_commands[].url` と `settings.interactivity.request_url` の `<WORKER_DOMAIN>` は、
> Worker をデプロイして URL（`*.workers.dev` またはカスタムドメイン）が確定するまでプレースホルダーのままでよい。
> マニフェスト作成時は仮の値（例 `https://example.invalid`）を入れておき、**§2 の Worker デプロイ完了後に
> 「Slack アプリ管理画面 → Slash Commands / Interactivity & Shortcuts」で実際の URL に更新する。**

```yaml
_metadata:
  major_version: 1
  minor_version: 1
display_information:
  name: kadobo
  description: 稼働記録・経費管理（本人専用の自己記録ツール）
features:
  bot_user:
    display_name: kadobo
    always_online: true
  slash_commands:
    - command: /kado
      url: "https://<WORKER_DOMAIN>/slack/commands"
      description: 稼働カードの投稿・再描画・週次/月次累計の確認
      usage_hint: "[status]"
      should_escape: false
    - command: /keihi
      url: "https://<WORKER_DOMAIN>/slack/commands"
      description: 経費入力（MVPでは暫定応答のみ。GASへは転送されない）
      should_escape: false
oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - files:read
      - im:write
settings:
  interactivity:
    is_enabled: true
    request_url: "https://<WORKER_DOMAIN>/slack/interactivity"
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

スコープ・スラッシュコマンド名は実コード（`worker/src/handlers/command.ts`、`worker/src/index.ts`）と一致させてある。

### 1.2 ワークスペースへインストール

「OAuth & Permissions」→ **Install to Workspace** を実行し、Bot をワークスペースに追加する。

### 1.3 プライベートチャンネルへ招待

Slack 上でプライベートチャンネル `#稼働記録` を作成し、`/invite @kadobo`（またはチャンネル詳細 → インテグレーション → アプリを追加）で Bot を招待する。

### 1.4 必要な識別子の取得

| 値 | 取得場所 | 用途 |
|---|---|---|
| Signing Secret | アプリ管理画面 → **Basic Information** → App Credentials → Signing Secret | Worker Secret `SLACK_SIGNING_SECRET` |
| Bot User OAuth Token（`xoxb-` で始まる） | アプリ管理画面 → **OAuth & Permissions** → Bot User OAuth Token（インストール後に発行される） | Worker Secret `SLACK_BOT_TOKEN`／GAS Script Property `SLACK_BOT_TOKEN` |
| チャンネル ID（`#稼働記録`） | Slack アプリでチャンネル名をクリック → 一番下「チャンネル ID」をコピー | GAS Script Property `SLACK_CHANNEL_ID` |
| 自分のユーザー ID | 自分のプロフィールを開く → 「⋯」その他 → **メンバー ID をコピー** | GAS Script Property `SLACK_USER_ID` |

これらの値はどこにもコミットしない（後述の Secrets／Script Properties に設定するのみ）。

---

## 2. Cloudflare（Worker）デプロイ

```sh
npm install
npx wrangler login
```

### 2.1 D1 データベース作成

```sh
npx wrangler d1 create kadobo-journal
```

出力される `database_id`（UUID）を `worker/wrangler.jsonc` の `d1_databases[0].database_id` の
プレースホルダー `REPLACE_WITH_WRANGLER_D1_CREATE_OUTPUT` と置き換える。

### 2.2 マイグレーション適用

```sh
# ローカル確認（Miniflare 上のローカル D1。npm test でも自動適用される）
npx wrangler d1 migrations apply DB --local

# 本番（Cloudflare 上の実 D1。--remote を明示しないと反映されない点に注意）
npx wrangler d1 migrations apply DB --remote
```

`DB` は `wrangler.jsonc` の `binding` 名（`database_name: kadobo-journal` でも同様に解決される）。
適用されるスキーマは `worker/migrations/0001_journal.sql`（`journal` / `settings`（初期値 `forwarding_enabled=1`）/ `nonces` の 3 テーブル）。

### 2.3 Secrets 設定

```sh
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put GAS_SHARED_SECRET
npx wrangler secret put GAS_URL
```

| Secret | 意味 | 入手元 |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Slack リクエスト署名（`X-Slack-Signature`）の検証鍵 | §1.4 の Signing Secret |
| `SLACK_BOT_TOKEN` | `chat.update` 等 Slack Web API 呼び出し用トークン | §1.4 の Bot User OAuth Token（`xoxb-...`） |
| `GAS_SHARED_SECRET` | Worker↔GAS 封筒（HMAC）の共有鍵 | 自分でランダム生成する（例 `openssl rand -hex 32`）。**この値は §4 の GAS Script Property `GAS_SHARED_SECRET` と完全に同一の値にすること**（§4.4 参照） |
| `GAS_URL` | GAS Web アプリの `/exec` URL | GAS をデプロイして初めて確定する。**この時点ではまだ判明していないため、一旦ダミー値（例 `https://script.google.com/pending`）を入れておいてよい**。§3 の GAS デプロイ完了後に本物の URL で `wrangler secret put GAS_URL` を再実行して上書きする（**再デプロイ不要**。Secrets の更新は次回リクエストから即時反映される） |

### 2.4 デプロイ

```sh
npx wrangler deploy
```

出力される `https://<worker名>.<サブドメイン>.workers.dev`（またはカスタムドメインを設定した場合はそのドメイン）を控える。

### 2.5 Slack の Request URL を確定させる

Slack アプリ管理画面に戻り、以下の 2 箇所を §2.4 で確定した URL に更新する。

- **Slash Commands** → `/kado`・`/keihi` の Request URL → `https://<WORKER_DOMAIN>/slack/commands`
- **Interactivity & Shortcuts** → Request URL → `https://<WORKER_DOMAIN>/slack/interactivity`

（実コード上、Worker が受け付けるパスはこの 2 つと `/internal/status` の 3 つのみ。他は 404。`worker/src/index.ts` 参照）

---

## 3. GAS デプロイ

### 3.1 スプレッドシート作成

Google ドライブで新規スプレッドシートを作成し、URL の `https://docs.google.com/spreadsheets/d/<ここ>/edit` の
部分を `SPREADSHEET_ID` として控える。シート自体の中身（6 シート）は後述の `setupSpreadsheet` が自動生成するので、
この時点では空のままでよい。

### 3.2 clasp のセットアップ

前提: Google アカウント設定 `https://script.google.com/home/usersettings` で **「Google Apps Script API」をオン**にしておく（オフだと `clasp login` 後の操作が権限エラーになる）。

```sh
npx clasp login
```

ブラウザで OAuth 認可が開くので、GAS を実行させたい Google アカウント（本人のアカウント）で許可する。

スクリプトプロジェクトを新規作成する場合（`gas/` ディレクトリで実行）:

```sh
cd gas
npx clasp create-script --title "kadobo" --rootDir dist
```

これで `gas/.clasp.json`（`scriptId` と `rootDir: "dist"` を含む）が自動生成される。
既存のスクリプトプロジェクトを使う場合は、`gas/.clasp.json.example` を `gas/.clasp.json` としてコピーし、
`scriptId`（Apps Script エディタの「プロジェクトの設定」歯車アイコンから確認できる）を手で埋める。
（`.clasp.json` は `.gitignore` 対象。テンプレートの `.clasp.json.example` のみ管理する。）

### 3.3 ビルド・push

```sh
npm run build --workspace=gas   # gas/dist/Code.js, gas/dist/appsscript.json を生成
npx clasp push
```

`clasp push` は `.clasp.json` の `rootDir`（`dist`）配下、つまりビルド済みの `Code.js`・`appsscript.json` を
アップロードする。`gas/dist/Code.js` の末尾には `doPost`・`setupSpreadsheet`・`installTriggers`・
`trigMorningCard`・`trigEveningCheck`・`trigMonthly` のトップレベル `function` 宣言があり、GAS エディタ・
トリガー設定画面から選択できる。

### 3.4 Web アプリとしてデプロイ

Apps Script エディタ（`npx clasp open` で開ける）で **デプロイ → 新しいデプロイ** → 種類「ウェブアプリ」を選択:

- 実行するユーザー: **自分**
- アクセスできるユーザー: **全員（匿名を含む）**

（`gas/appsscript.json` の `webapp.executeAs=USER_DEPLOYING` / `webapp.access=ANYONE_ANONYMOUS` に対応。GAS は
HTTP ヘッダーを読めないため、公開エンドポイントであることを前提に、後述の HMAC 封筒認証で守る。要件定義 §5.2）

デプロイ後に発行される `/exec` で終わる URL を控える（これが GAS の Web アプリ URL）。

### 3.5 Script Properties 設定

Apps Script エディタ → **プロジェクトの設定** → **スクリプト プロパティ** で以下を設定する。

| プロパティ名 | 意味 | 値の入手元 |
|---|---|---|
| `SPREADSHEET_ID` | 記録先スプレッドシートの ID | §3.1 |
| `SLACK_BOT_TOKEN` | Slack Web API 呼び出し用トークン | §1.4（Worker の `SLACK_BOT_TOKEN` と同じ値） |
| `GAS_SHARED_SECRET` | Worker↔GAS 封筒の共有鍵 | §2.3 の `GAS_SHARED_SECRET` と**同一の値** |
| `WORKER_STATUS_URL` | Worker の `/internal/status` フルURL | `https://<WORKER_DOMAIN>/internal/status`（§2.4） |
| `SLACK_CHANNEL_ID` | `#稼働記録` のチャンネル ID | §1.4 |
| `SLACK_USER_ID` | 通知メンション対象の自分のユーザー ID | §1.4 |
| `CLIENT_DEFAULT` | 単価マスタ・月次請求の既定クライアント名 | 任意の文字列（例 `A社`）。未設定時のコード上の既定値も `A社` |

（`gas/src/adapters/props.ts` 経由で `PropertiesService.getScriptProperties().getProperty(key)` として参照される。
参照箇所は `gas/src/app/dispatch.ts`・`gas/src/app/monthly.ts`・`gas/src/app/correction.ts`・
`gas/src/app/triggers.ts`・`gas/src/adapters/slack.ts`・`gas/src/adapters/workerStatus.ts`・`gas/src/entry.ts`）

### 3.6 初期化関数を1回ずつ実行

Apps Script エディタの関数選択プルダウンから、それぞれ**1回だけ**実行する（初回はスコープ承認ダイアログが出る）。

1. `setupSpreadsheet` — 不足しているシート（生ログ／日次集計／単価マスタ／月次請求／経費台帳／内部）とヘッダー行を作成し、生ログ・日次集計・内部シートに警告付き保護をかける（冪等なので再実行しても壊れない）
2. `installTriggers` — 時間トリガーを（既存の同名トリガーを削除してから）作り直す:
   - `trigMorningCard`: 毎日 07 時台
   - `trigEveningCheck`: 毎日 22 時台
   - `trigMonthly`: 毎月 1 日 06 時台

（実行には `https://www.googleapis.com/auth/spreadsheets`・`.../drive`・`.../script.external_request`・
`.../calendar.readonly`・`.../script.scriptapp` の承認が求められる。`gas/appsscript.json` の `oauthScopes` 参照）

### 3.7 GAS URL を Worker Secret へ反映

§3.4 で控えた `/exec` URL を、§2.3 で仮値のまま設定していた Worker の Secret に本物の値で上書きする。

```sh
npx wrangler secret put GAS_URL
```

---

## 4. 共有シークレットの整合

- **`GAS_SHARED_SECRET`**（Worker Secret）と **`GAS_SHARED_SECRET`**（GAS Script Property）は、Worker→GAS の
  封筒 HMAC 署名と GAS→Worker `/internal/status` の封筒 HMAC 署名の両方で使われる**同一の共有鍵**である。
  値が一致していないと、Worker からの打刻はすべて GAS 側で `UNAUTHORIZED` として拒否され、GAS の
  22 時台トリガーからの状態確認も Worker 側で 401 になる。**必ず同一の値**を設定すること（実装設計 §3.1・§5.2）。
- **`WORKER_STATUS_URL`**（GAS Script Property）は Worker の `/internal/status` エンドポイントの**フル URL**
  （`https://<WORKER_DOMAIN>/internal/status`）を指す。GAS の `trigEveningCheck` がこの URL に封筒付き POST を
  送り、D1 の pending 件数を確認する。

---

## 5. 停止フラグ運用

D1 の `settings` テーブル（`key='forwarding_enabled'`）で GAS への転送を止められる。フラグが `'0'` の間も
Worker は Slack 署名検証・D1 ジャーナル記録・即時 ACK・カードへの `⚠️ 記録待ち` 表示は行い続け、**GAS への転送と
Cron 再送だけを止める**（実装設計 §5）。GAS の再デプロイ中に打刻が失われるのを防ぐために使う。

停止:

```sh
npx wrangler d1 execute DB --remote --command "UPDATE settings SET value='0' WHERE key='forwarding_enabled'"
```

再開:

```sh
npx wrangler d1 execute DB --remote --command "UPDATE settings SET value='1' WHERE key='forwarding_enabled'"
```

### GAS 再デプロイ手順（コードを更新するとき）

1. 停止フラグを `0` にする（上記コマンド）
2. `npm run build --workspace=gas && npx clasp push`
3. Apps Script エディタで **デプロイ → デプロイを管理** → 既存の Web アプリデプロイを選択し、鉛筆アイコンから
   「新バージョン」を選んで更新（`/exec` URL は変わらない）
4. 停止フラグを `1` に戻す

停止中に受け付けた打刻は D1 に `pending` のまま残っているため、再開後の Cron（5 分毎）で自動的に GAS へ
再送され、`action_ts` の時刻どおりに記録される（ユーザー操作不要）。

---

## 6. 動作確認（スモーク）

1. Slack で `/kado` を実行 → `#稼働記録` に当日の稼働カードが投稿される（`未稼働` 状態、`[開始]` ボタンのみ）
2. `[開始]` を押す → カードが一瞬 `⏳ 開始 HH:mm 記録中…` → 数秒で `✅ 開始 HH:mm 記録済み` に変わり、状態が
   `稼働中`（`[休憩][終了][✏️修正]`）になる
3. `[休憩]` → `休憩中`（`[再開][終了][✏️修正]`）。`[再開]` → `稼働中` に戻る
4. `[終了]` → `確定`（`[再開][✏️修正]`）。カードの `sessions` ブロックにセッション時刻、`total` ブロックに
   本日累計が表示される
5. スプレッドシートの **生ログ** シートに `START`/`BREAK_START`/`BREAK_END`/`END` の行が追記されていること、
   **日次集計** シートに当日の行（`status=OK`、`worked_minutes` が妥当な値）が反映されていることを確認する

---

## 7. 運用

### 失敗通知への対処

- **DM 通知**（`⚠️ 記録に失敗しました（処理ID: ... / エラー: ...）`）: `ok:false, retryable:false` として
  拒否された打刻。処理 ID を控え、必要なら操作をやり直す（自動では再送されない）
- **チャンネルへのメンション通知**（`⚠️ 記録待ちの処理が繰り返し失敗しています`）: Cron 再送が 6 回
  （約 30 分、5 分間隔）連続で `pending` のまま失敗した場合、以後 72 回ごとに再通知。GAS 側の障害
  （デプロイ切替中・クォータ超過等）を疑い、Apps Script の実行ログを確認する
- **GAS 22 時台トリガーの通知**: 当日が稼働中／休憩中のまま、Worker の pending 残り、過去 7 日の「要修正」
  の 3 種を独立に通知する（最終セーフティネット）

### 月次締め（MVP は手動転記）

MVP 期間中は要件定義 §4.4.2 の 3〜4（MF での未送付請求書作成・PDF 添付）を**手動**で行う。GAS の
`trigMonthly`（毎月 1 日 06 時台）が前月の日次集計を再計算して月次請求シートの `worked_minutes`／`hours`／
`amount` 等を更新し、要修正一覧と月合計をチャンネルへ通知する。本人が単価マスタ・月次請求シートの内容を
確認し、MF クラウド請求書の画面で請求書を作成・送付する。

### バックアップ

現状バックアップは**手動**（スプレッドシートを「ファイル → コピーを作成」または xlsx エクスポートして
別 Drive フォルダに保存する運用を、少なくとも月次で行う）。エクスポートの自動化・復元手順の年次リハーサルは
自動化・仕上げフェーズで対応する（要件定義 §5.5、`docs/未決事項・デプロイ前確認.md` 参照）。

---

## 関連ドキュメント

- [`docs/実装設計_MVP.md`](docs/実装設計_MVP.md) — 実装契約（プロトコル・スキーマ・作業パッケージ）
- [`docs/稼働記録・経費管理システム_要件定義_v1.1.md`](docs/稼働記録・経費管理システム_要件定義_v1.1.md) — 要件定義
- [`docs/受入試験チェックリスト.md`](docs/受入試験チェックリスト.md) — MVP 受入試験の実行手順
- [`docs/未決事項・デプロイ前確認.md`](docs/未決事項・デプロイ前確認.md) — 契約前・本番前に確定すべき事項
