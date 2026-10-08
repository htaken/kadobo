# 実装設計 MF 連携フェーズ（請求書・経費仕訳）

対象: 要件定義 v1.1 **§4.2.4 月次請求**・**§4.4 請求（MF 連携）**・**§4.3.3 の「法定帳簿の正は MF」**、
フェーズ計画 §8「自動化」のうち **MF 連携部分**。

`docs/実装設計_MVP.md`（以下 **MVP 設計**）と `docs/実装設計_経費フェーズ.md`（以下 **経費設計**）の構成・規約・
プロトコルをそのまま踏襲し、**差分だけ**を記す。一次資料の原文と出典は `docs/未決事項・デプロイ前確認.md`
（以下 **未決事項**）§6.1〜§6.4・§6.8（請求書 API）、**§6.14（会計 API）** に集約してある。

- 作成日: 2026-09-27
- **期限: 初回の月次締め＝ 10 月分を 2026-11-01 に締める**（契約開始 2026-10-01。未決事項 §1）。
  間に合わない場合は runbook 02 の**手動転記で回す**（§11.3）

> **v2（2026-09-27）— Codex レビュー反映版。** v1 に対する独立レビュー（`reviews/codex_review_MF連携.md`）で
> **「このまま実装の契約として確定するのは不可」**と判定され、指摘をすべて取り込んだ。v1 から判断が変わった箇所には 🔄 を付けてある。
>
> | # | v1 の誤り | 対応 |
> |---|---|---|
> | B1 | 月次行の書込みが直列化されておらず、ロックなしの `trigMonthly` が**締め状態を古い値で書き戻せた**（`upsertMonthlyBill` は行全体を上書きする） | §0・§5.2: 月次行・経費行は**列を指定して書く**。集計は状態列に触れない |
> | B2 | 登録処理中（`RECEIVED`/`FILE_SAVED`）の経費を**永久に同期対象外**にしていた | §6.2・§6.3: 対象判定を毎回やり直す。永久除外は開業前の日付だけ |
> | B3 | 明細から仕訳した直後に落ちると、明細が一覧から消えて**回収できなかった** | §6.5: 明細 ID を**先に保存**してから仕訳し、再開時は回収を最優先する |
> | B4 | 訂正で旧仕訳を消した後も、旧行が明細を**使用中のまま**だった | §6.5・§6.7: 使用中の判定を状態で行い、`REVERSED` は明細を手放す |
> | B5 | 支払方法と連携サービスの対応を見ずに照合していた。日付優先の規則で**明細の取り合い**を許していた | §6.5: カード用・口座用の連携サービスを分け、**一対一のときだけ**確定する |
> | B6 | 「検索 0 件なら再作成」は、応答が失われたときの**二重作成を防げない** | §4.4・§5.5・§6.4: 結果不明を `UNKNOWN` として保存し、**自動では作り直さない** |
> | B7 | 手動で請求した月・手入力の仕訳 ID を、自動化の開始後に**作り直す**おそれがあった | §5.3・§6.3: 締めた時点で作成方法（自動／手動）を固定する。手入力の ID を最優先で取り込む |
> | M1〜M2 | 複数キーの保存は原子的でない。トークン更新を打刻と同じロックの中で行っていた | §4.2: トークンを **1 キーの JSON** にまとめる。更新は**ユーザーロック**で行う |
> | M3〜M5 | 月次の状態機械に `ERROR` が無い。前月しか評価しない。締めた月への打刻の遅延到着を扱っていない | §5.1〜§5.3・§5.8 |
> | M6〜M8 | 明細 API の 366 日制限、仕訳日、按分、**免税事業者は税区分を登録できない** | §3.2・§6.4・§6.5・§2.4 |
> | M9〜M10 | 全体を止めるフラグが無い、実行時間の見積りに根拠が無い、`validateRequest.ts` の変更漏れ、端数の出ないスパイク値 | §7・§9・§10・§11 |

---

## 0. 実装体制と原則

- MVP 設計 §0・経費設計 §0 と同じ。コードは Agent（sonnet）に委譲し、**本書が契約**。WP 単位でレビューする
- ヘキサゴナル構成を維持する（`core` 純関数／`app` ユースケース／`adapters` GAS グローバル）。
  **MF API の認証・再試行・エラー分類も `app` 層に置き、HTTP だけをポートにする**（§4.1）
- **MF API の呼び出しは、必ず `ports.lock.withLock()`（スクリプトロック）の外で行う。**
  - 理由 1: MF API は 1 回 1〜3 秒かかる。ロック内で呼ぶと本番稼働中の打刻を `LOCK_TIMEOUT` に巻き込む（経費設計 v2 #2 と同じ誤り）
  - 理由 2: `LockAdapter.withLock` は `finally` で `releaseLock()` するため**入れ子にできない**
- 🔄 **シートの読み書きは「短いスクリプトロックの中で読み直してから書く」。書くのは自分が担当する列だけにする**（B1・M5）
  - 月次請求: 集計（`recomputeMonthly`）が書くのは**数値列・`note`・`updated_at` だけ**。状態・請求書の列は締め処理と MF 同期だけが書く
  - 経費台帳: MF 同期が書くのは **§6.1 のシステム列と `MF仕訳ID`・`MF明細ID` だけ**。人が同時に編集した業務列を上書きしない
  - そのため `SheetsPort` に**列指定の更新**を追加する（§8）。既存の `updateExpense`（行全体を書き戻す）は MF 同期からは使わない
- **外部に副作用を残す操作（請求書作成・仕訳作成）は、実行前に既存を検索して再利用する**。さらに🔄 **送信が成功したか分からない場合は `UNKNOWN` として保存し、自動では作り直さない**（B6）。
  MF の作成 API には冪等キーが無く、検索結果にすぐ反映される保証も無い（未決事項 §6.14）
- **各機能は Script Property のフラグで個別に有効化する。既定は無効（fail closed）。全体を止めるフラグも置く**（§9）

---

## 1. スコープと段階

| 段 | 内容 | 認証 | 期限 |
|---|---|---|---|
| **① 請求書** | 月次締め状態機械、締め確認カード、未送付請求書の作成と金額照合、送付・入金の追跡 | OAuth 2.0（請求書 API は API キー非対応） | **2026-10-31**（11/1 の締めに間に合わせる） |
| **② 現金・立替の経費** | `/keihi` に支払方法を追加。「現金・立替」の経費を `経費／事業主借` で仕訳登録 | API キー（会計 API） | 11 月中 |
| **③ 連携カード・口座の経費** | 未仕訳の連携明細と経費台帳を照合し、明細から仕訳を作成。未登録の支出を週次で報告 | API キー（会計 API） | ② の後 |

### 含まない（将来）

- **A社からの入金明細と請求書の自動照合（`SENT → PAID` を口座明細から判定）**。当面は MF 画面での消込（入金ステータス）を読むだけ（§5.7）
- 証憑ファイルの MF へのアップロード（**採用しない**。§2.2）
- 家事按分（MF の家事按分機能で年末に行う。§2.4）
- 🔄 **開業日（2026-10-01）より前の支出の仕訳**（開業費か、固定資産等かを**人が分類して** MF に登録する。§6.2）
- 🔄 カード代金の引落しなど、`MF明細ルール` で「無視」にした明細の仕訳（MF 側で行う。§6.6）。**NISA の積立（カード・口座とも）は kadobo が私用として仕訳する**

---

## 2. 設計判断（2026-09-27 に決定）

### 2.1 認証方式を API ごとに分ける

| API | 方式 | 理由 |
|---|---|---|
| 請求書 API v3 | **OAuth 2.0**（認可コードフロー、`CLIENT_SECRET_BASIC`） | API キーに**非対応**（OpenAPI の `securitySchemes` が `AccessToken` のみ） |
| 会計 API v3 | **API キー**（`/auth/exchange` で JWT に交換） | 2026-09-24 から全エンドポイント対応。**キー自体に期限が無く、リフレッシュトークンのローテーションも無い** |

- 両 API はベース URL・レート制限・権限モデルがもともと別で、クライアントは最初から 2 つに分かれる。認証を揃えても共通化できる部分はほとんど無い
- 両方を OAuth に揃えると、**毎時動く経費同期がローテーションの連鎖に依存する**。保存に 1 回失敗すると請求書と経費が同時に止まる。分けておけば経費側はこの失敗の影響を受けない
- 呼び出し側からは「アクセストークンを返す」同じ形に見える（§4）。請求書 API が将来 API キーに対応したら、請求書側の中身だけ差し替える

### 2.2 証憑は MF にアップロードしない

- パーソナルミニプランのクラウドBox は**累計 1,000 件まで**、アップロードした証憑は**削除できない**、1 件 **5MB まで**（未決事項 §6.14）。
  月 30 件なら約 2 年半で上限に達し、保存期間 7 年に届かない
- 相互関連性は仕訳側に書き込んで確保する:

| 仕訳の項目 | 入れる値 | 目的 |
|---|---|---|
| `remark`（摘要、200 字） | `{証憑ID} {取引先}`（例 `R-20261005-001 ○○商店`） | MF の仕訳帳で見え、検索できる |
| `memo`（200 字） | 経費台帳の `Driveリンク` | 仕訳から証憑を開ける（Drive は非公開なので開けるのは本人のみ） |
| `tags` | `[証憑ID]` | 二重登録防止の検索キー（§6.4） |

- 電帳法上の保存の正本は引き続き Drive。**事務処理規程は変更しない**
- 🔄 **カードの利用明細（月次の PDF 等）も電子取引として保存が必要**（一問一答 問5 へ。未決事項 §6.14）。
  これは `/keihi` では登録しない（**登録すると個々の支出と二重に仕訳される**）。Drive の `経費証憑/電子取引/カード明細/YYYY/MM/` に**手で保存する**（runbook に追加。§11.4）

### 2.3 支払方法で仕訳の作り方を分ける

`/keihi` に**支払方法**を追加する（§10.2）。

| 値 | 表示 | 仕訳 | 作り方 |
|---|---|---|---|
| `linked_card` | 連携カード | `経費 ／ （カードの負債科目。MF の連携設定に従う）` | **明細から仕訳**（`POST /transactions/journalize`）③ |
| `linked_bank` | 連携口座から直接（振込・引落） | `経費 ／ 普通預金` | **明細から仕訳** ③ |
| `cash` | 現金・その他（立替） | `経費 ／ 事業主借` | **仕訳を直接作成**（`POST /journals`）② |

- 連携カード・口座の支払いを `POST /journals` で作ると、MF に取り込まれた同じ明細と**二重計上**になる。
  明細から仕訳を作れば明細は「仕訳済み」になり、**1 つの明細から仕訳は 1 つしかできない**
- 連携するのは**個人名義の口座と、それに紐づくカード**で、実質的に事業専用として使う。
  ただし **NISA の積立は同じ口座からの引落しと、連携カードでの決済（クレカ積立）の両方で出る**（利用者の方針。変更しない）→ §6.6 の明細ルールで**私用として分ける**

### 2.4 家事按分は kadobo でやらない 🔄

- MF の家事按分は**勘定科目（補助科目）ごとの合計**に割合を掛ける（[MF 公式「家事按分」](https://biz.moneyforward.com/support/tax-return/guide/financial-report/fr06.html)）。
  行ごとに違う割合は再現できない
- したがって、**kadobo が自動で仕訳するのは `事業使用割合` が 100 の行だけ**にする。100 未満の行は `NEEDS_REVIEW` にし、
  人が MF で（補助科目を分けるなどして）仕訳して `MF仕訳ID` を記入する（§6.3）
- 按分の割合そのものは年末に MF の家事按分機能で設定する

---

## 3. 外部 API の契約（要点）

詳細と原文は未決事項 §6.2・§6.4・§6.14。**ここに書いた値以外を前提にしないこと。**

### 3.1 請求書 API v3

- ベース: `https://invoice.moneyforward.com/api/v3`。トークン: `https://api.biz.moneyforward.com/token`
- レート制限: 数値非公開・エンドポイントごと。429 は `Retry-After`（秒）
- 使うエンドポイント:

| 用途 | エンドポイント |
|---|---|
| 請求書作成 | `POST /invoice_template_billings`（必須 `department_id`・`billing_date`） |
| 既存検索（冪等） | `GET /billings?document_number={billing_number}`（**全ページを見る**） |
| 状態取得 | `GET /billings/{id}`（`email_status`・`posting_status`・`payment_status`・金額） |
| 疎通・維持 | `GET /office` |

- 応答の金額（`subtotal_price`・`excise_price`・`total_price`・`deduct_price`）は**文字列**。整数に直して比較する
- 🔄 ステータスは仕様書の中で表記が揺れている（`enum` は日本語ラベル、`description` はコード値。`payment_status` は `"2"` のような**文字列のコード**）。
  `core/invoice.ts` の `normalizeBillingStatus` で**日本語ラベル・コード文字列の両方を正規化**してから判定する（§5.7）

### 3.2 会計 API v3

- ベース: `https://api-accounting.moneyforward.com/api/v3`
- 🔄 API キー認証時は **`GET /accessible_offices` 以外**の全リクエストに `office_code` クエリが必須
- JWT: `POST https://api.biz.moneyforward.com/auth/exchange`（`Authorization: Bearer <APIキー>`）→ `access_token`・`expires_in: 3600`。交換は 100 回/分
- レート制限: **アクセストークンごとに 3 回/秒**
- 使うエンドポイント: `GET /accounts`・`GET /journals`・`POST /journals`・`DELETE /journals/{id}`・`GET /transactions`・`POST /transactions/journalize`・`GET /connected_accounts`・`GET /accessible_offices`
- `POST /journals`・`POST /transactions/journalize` の 201 応答は `{ journal: { id, transaction_id, tags, ... } }`
- 🔄 `GET /transactions` は **`start_date` と `end_date` の差が 366 日以内**。長く照合できない行が残ったときのため、期間を分割して呼ぶ（§6.5）
- 🔄 `journalize` の `transaction_date` は省略すると**明細の日付**になる。kadobo は**必ず経費台帳の `日付`（証憑の取引年月日）を指定する**（§6.5）
- 🔬 **会計 API は ID（`account_id`・`tax_id`・仕訳 ID 等）をパーセントエンコード済みの文字列で返す**（2026-10-08 実測。OpenAPI の例示値も `…%3D%3D`）。本文にはそのまま入れ、**パスに入れるときに `encodeURIComponent` を重ねない**
- 🔄 **免税事業者に設定した事業者では、仕訳に税区分を登録できない**（[MF 公式](https://biz.moneyforward.com/support/account/guide/office02/of02.html)「「免税事業者」では、「消費税」機能が利用不可となり、仕訳に税区分を登録できません」）。
  kadobo は `tax_id`・`invoice_kind` を**送らない**。送った場合の挙動は S-M5 で確認する

---

## 4. 認証とクライアント（`app` 層）

### 4.1 新しいポート

```ts
/** UrlFetchApp の薄いラッパ。muteHttpExceptions: true。例外は通信失敗・タイムアウト時のみ。 */
export interface HttpPort {
  fetch(req: {
    method: "get" | "post" | "put" | "delete";
    url: string;
    headers?: Record<string, string>;
    /** JSON は呼び出し側で文字列化する。form は `application/x-www-form-urlencoded` の文字列。 */
    payload?: string;
    contentType?: string;
  }): { status: number; headers: Record<string, string>; body: string }; // headers のキーは小文字化
}

/** 書き込み可能な Script Properties（トークン保存用）。PropsPort は読み取り専用のまま残す。 */
export interface SecretStorePort {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** 期限付きキャッシュ（CacheService）。nonce 用の CachePort とは別にする。 */
export interface TtlCachePort {
  get(key: string): string | null;
  put(key: string, value: string, ttlSec: number): void;
  remove(key: string): void;
}

/** 🔄 トークン更新専用のロック（LockService.getUserLock()）。スクリプトロックとは別物。 */
export interface AuthLockPort {
  withAuthLock<T>(fn: () => T): T; // 取得できなければ MfTransientError
}
```

- `ClockPort` に `sleep(ms: number): void` を追加する（`Utilities.sleep`。フェイクでは時計を進めるだけ）
- 🔄 **`AuthLockPort` をユーザーロックにする理由**: Web アプリ（`実行: 自分`）もトリガーも同じ所有者として動くので、
  ユーザーロックで**トークン更新どうし**は直列になる。一方でスクリプトロック（打刻が使う）とは別のロックなので、
  トークン更新の HTTP が長引いても**打刻を待たせない**（M2）。2 つのロックが干渉しないことは S-M6 で実機確認する
- ユースケースに注入するのは下記のクライアント（`app/mf/*.ts`）。テストでは `HttpPort` をフェイクにする

### 4.2 請求書 API のクライアント（OAuth）: `MfInvoiceClient`

🔄 **保存場所**: Script Property **`MF_INVOICE_TOKENS` の 1 キー**に JSON で持つ（M1）。
`PropertiesService.setProperties` で複数キーを書いても原子的とは保証されない（[Google 公式](https://developers.google.com/apps-script/reference/properties/properties)に記載が無い）が、
**1 キーの書込みなら新旧が混ざらない**。

```json
{ "access_token": "…", "refresh_token": "…", "refreshed_at": 1790000000000, "generation": 12 }
```

**呼び出し**（`request(method, path, body?)`）:

1. `MF_INVOICE_TOKENS` を読み、`access_token` と `generation` を覚えて `Authorization: Bearer` を付けて呼ぶ
2. **401** → `refresh(usedGeneration)` → 新しいトークンで**1 回だけ**再試行する。再試行でも 401 なら `MfAuthError`
3. **429** → `Retry-After` が 10 秒以下なら `sleep` して 1 回だけ再試行する。超えるとき、または再試行も 429 なら `MfTransientError`
4. **5xx・通信失敗・タイムアウト** → `MfTransientError`。🔄 ただし**作成系（POST）では `MfOutcomeUnknownError`**（§4.4）
5. **その他の 4xx** → `MfApiError(status, body)`（再試行しない）

**`refresh(usedGeneration)`**（**401 を受けたときだけ実行する**。寿命をハードコードした先読み更新はしない。要件定義 §4.4.1）:

```
withAuthLock:                               # ユーザーロック（スクリプトロックではない）
  t = MF_INVOICE_TOKENS を読む
  if t.generation !== usedGeneration:       # 別の実行がすでに更新した
    return t.access_token
  POST /token  grant_type=refresh_token&refresh_token=<t.refresh_token>
               Authorization: Basic base64(client_id:client_secret)
  200 → next = { access, refresh, refreshed_at: now, generation: t.generation + 1 }
        set(MF_INVOICE_TOKENS, JSON(next))
        読み直して一致を確認する。一致しなければもう 1 回 set して確認する
        それでも一致しない → MfReauthRequiredError（取得した新トークンは保存できず失われている）
        return next.access
  400 invalid_grant → MfReauthRequiredError
  429/5xx/通信失敗 → MfTransientError
```

- ⚠️ **トークンエンドポイントが更新を処理したのに応答が失われた場合、古いリフレッシュトークンはもう使えない**。
  これは防げないので、次の更新で `invalid_grant` になったときに再認可に倒す（§4.4）。**トークンの値はログ・Slack・例外メッセージに出さない**

🔄 **週次の疎通（keepalive）**: リフレッシュトークンの寿命は非公開で、使うのが月数回なので**使わない間に失効していても気づけない**。
`trigWeeklyOrphanCheck`（毎週月曜）の末尾で **`GET /office` を通常の呼び出しとして 1 回呼ぶ**。
アクセストークンは 1 時間で切れる（実測）ので、1 週間ぶりの呼び出しは 401 → 通常どおり更新される。
**更新は 401 を受けたときだけ、という方針のまま**、リフレッシュトークンが毎週入れ替わる。**利用者の操作は不要**。トリガーも増やさない。
ただし、週 1 回の更新で失効を防げるという保証は無い（寿命が非公開のため）。目的は**失効に数週間前に気づくこと**。

### 4.3 会計 API のクライアント（API キー）: `MfAccountingClient`

- `MF_ACCOUNTING_API_KEY`（`mf_api_prd_…`）・`MF_OFFICE_CODE`（`XXXX-XXXX`）を読む
- JWT は `TtlCachePort` のキー `mf_acc_jwt` に **3000 秒**で保存する（`expires_in` 3600 より短く）。無ければ `/auth/exchange` で取得する
- **401** → キャッシュを消して交換し直し、**1 回だけ**再試行する。**403** → `MfApiError`（権限不足。§9 の設定で直す）
- **3 回/秒の制限**: 同じ実行の中では直前のリクエストから **350ms** 空ける（`sleep`）。
  別の実行（毎時同期と手動の疎通確認など）が同時に使う場合までは制御しない。**429 からの復旧で吸収する**
- 429・5xx・作成系の扱いは §4.2 と同じ
- `GET /accessible_offices` 以外のリクエストに `office_code` を付ける

### 4.4 エラーの種類と通知 🔄

| 例外 | 意味 | 扱い |
|---|---|---|
| `MfReauthRequiredError` | リフレッシュトークン失効・トークン保存失敗 | Slack の DM で**再認可**を依頼する（24 時間に 1 回まで。内部シート `mf_notice/reauth`）。§11.5 の手順で復旧する |
| `MfAuthError` | 更新後も 401 | 同上（設定不備の可能性も含めて通知） |
| `MfTransientError` | 429・5xx・通信失敗（**作成系以外**） | 状態を変えず、次のトリガーで再試行する。**同じ対象で 6 回連続したら「一時障害が続いています」と通知**（内部シート `mf_fail/<対象>` に回数。再認可の通知とは文言を分ける） |
| **`MfOutcomeUnknownError`** | **作成系 POST** が 5xx・通信失敗・タイムアウト（**MF 側で作られたかどうか分からない**） | 対象を **`UNKNOWN`** にする。以後の実行は**検索による回収だけ**を行い、**自動では作り直さない**（§5.5・§6.4） |
| `MfApiError` | 400 等の業務エラー（作られていないことが確実） | 対象を `ERROR` にして通知する（本文の `errors[].code/message` を短く添える。トークンは含めない） |
| `ConfigMissingError` | 必須プロパティ未設定 | 既存と同じ（経費設計 §5.9）。通知して止める |

- **429 を受けた POST は「作られていない」とみなしてよい**（レート制限で拒否された）。`MfTransientError` として扱う

### 4.5 初回認可はローカルスクリプトで行う

- `scripts/mf-oauth-authorize.mjs`（Node、依存なし）: 環境変数 `MF_CLIENT_ID`・`MF_CLIENT_SECRET` を読む
  - 🔄 **`127.0.0.1:8765` だけで待ち受ける**（外部に開かない）。**`state`（乱数）と PKCE（S256）を付けて**認可 URL を表示する
  - コールバックでは `state` の一致を確認し、`error` パラメータが付いていれば内容を表示して終了する。**5 分で待受を打ち切る**
  - トークンを取得したら、**`MF_INVOICE_TOKENS` にそのまま貼れる JSON 1 行**（`generation: 1`・`refreshed_at` 付き）を**標準出力に 1 度だけ**表示して終わる
- 利用者はその JSON を Script Property `MF_INVOICE_TOKENS` に貼り、**直後に GAS の `mfInvoicePing()`（手動実行用。`GET /office`）を実行して疎通を確認する**
- MF のアプリポータルで、連携アプリのリダイレクト URI に `http://127.0.0.1:8765/callback` を登録しておく
- scope は `mfc/invoice/data.write` のみ（会計は API キーなので含めない）
- スクリプトはシークレットをファイルに書かない。リポジトリに入れてよい

---

## 5. ① 請求書

### 5.1 月次締めの状態機械（`core/monthClose.ts`、純関数）🔄

**締めの状態**（`月次請求.state`）と、**請求書作成の進み具合**（新しい列 `invoice_state`）を分ける（M3）。
MF の呼び出しが失敗しても、**締めの状態は凍結されたまま**になる。

**締めの状態 `state`** — 要件定義 §4.2.4 の `APPROVED` は**削除する**（送付判断は MF 画面で人が行い、kadobo が観測できるのは送付の結果だけのため）:

```
OPEN ⇄ REVIEWING ──[締める]──▶ LOCKED ──(請求書ができた)──▶ MF_CREATED ──(送付済み)──▶ SENT ──(入金済み)──▶ PAID
                                 │                              └────────────(入金済み)────────────────────┘
                                 └─(手動請求の月)── LOCKED のまま。送付・入金はシートを手で進める
VOID: 人手のみ（シート編集。§11.6）
```

**請求書の進み具合 `invoice_state`**（`LOCKED` 以降だけ意味を持つ）:

| 値 | 意味 |
|---|---|
| `MANUAL` | 締めた時点で `MF_INVOICE_ENABLED` が無効だった。**kadobo は作らない**（B7。後で有効にしても作らない） |
| `PENDING` | 作成待ち |
| `UNKNOWN` | 作成の POST の結果が分からない（§4.4）。**回収だけ行い、作り直さない** |
| `CREATED` | 作成済み・金額一致 |
| `MISMATCH` | 作成済みだが金額が一致しない。**解消するまで毎日 1 回警告する** |
| `ERROR` | 業務エラー（作られていない） |

| 関数 | 仕様 |
|---|---|
| `isMonthFrozen(state)` | `LOCKED`・`MF_CREATED`・`SENT`・`PAID`・`VOID` なら `true` |
| `nextStateOnEvaluate(state, hasBlockers)` | `OPEN` かつ `!hasBlockers` → `REVIEWING`。`REVIEWING` かつ `hasBlockers` → `OPEN`。それ以外は変えない |
| `nextStateOnBillingStatus(state, b)` | `MF_CREATED` かつ送付済み → `SENT`。`MF_CREATED`/`SENT` かつ入金済み → `PAID`（送付を経ずに入金済みになった場合も `PAID`） |

**既存コードの修正（必須）**: 現在 `LOCKED` だけを見ている 2 か所を `isMonthFrozen` に置き換える。
置き換えないと、**請求書を作成した後（`MF_CREATED`）の月に訂正が通り、請求書とシートの金額がずれる**。

- `gas/src/app/monthly.ts` `recomputeMonthly`（凍結月は書かない）
- `gas/src/app/correction.ts`（凍結月の `CORRECTION` は `{ok:true, applied:false, reason:'LOCKED_MONTH'}`）

`hasBlockers` は「対象月の日次集計に `要修正` か `進行中` がある」、または「`recomputeMonthly` が単価エラーを `note` に書いた」。

**月次請求シートの追加列**（既存 14 列の**後ろ**に足す。`setupSpreadsheet` で追記）:

| 列 | 内容 | 書く人 |
|---|---|---|
| `invoice_state` | 上表 | 締め処理・MF 同期 |
| `invoice_error` | 最後のエラー・不一致の要約 | 同上 |
| `invoice_attempted_at` | 最後に作成を試みた時刻（epoch ms） | 同上 |
| `close_card_ts` | 締め確認カードの `message_ts` | 締め処理 |

### 5.2 締め確認カード（`app/monthClose.ts` `evaluateMonthClose(client, month)`）🔄

- **呼ぶ場所**: `trigMonthly`（毎月 1 日。既存の集計投稿の後）と `trigMfSync`（毎時。§7）
- 🔄 **対象月**: `MF_BILLING_START_MONTH`（`2026-10`）以降、**当月より前**で、`state` が `OPEN`・`REVIEWING` の**すべての月**（M4。締め忘れが翌々月まで続いても拾う）。
  `MF_BILLING_START_MONTH` より前（9 月＝契約前）は何もしない
- 🔄 **ロック**: 1 か月分の「再集計 → 状態の判定 → 書込み」を**1 回の短いスクリプトロック**の中で行う（B1）。
  **既存の `trigMonthly` の再集計もロックの中に入れる**（今はロックなしで動いている）。Slack への投稿はロックの外で行う
- 手順（ロック内）: `recomputeMonthly`（数値列のみ）→ `nextStateOnEvaluate` → `state` 列だけを書く
- 手順（ロック外）: `REVIEWING` になったら、`close_card_ts` が空ならカードを投稿し、ロック内で `close_card_ts` を書く。
  **空でなければ既存のカードを最新の金額で描き直す**（`OPEN` に戻ってから `REVIEWING` に戻った場合も同じカードを使う）。
  `OPEN` に戻ったときも既存のカードを「要修正があります」に描き直す
- カードの投稿は**通常 1 か月に 1 回**。投稿後・`close_card_ts` の保存前に落ちると 2 枚目が出ることがある（許容する。古い方のボタンは §5.3 で弾かれる）

**カード（`core/card.ts` に `renderMonthCloseCard` を追加）**:

```
📅 2026年10月分の締め確認（A社）
稼働 160.25 時間 × 1,800 円
報酬額 288,450 円 ／ 消費税相当額 28,845 円 ／ 源泉徴収 0 円
請求額（差引入金予定額）317,295 円
支払期日 2026-11-30（月）
[締めて請求書を作成]   ← action_id: kado_month_close
                           value: {"client":"A社","month":"2026-10","net_amount":317295}
```

- `MF_INVOICE_ENABLED` が無効のときはボタン文言を **[締める（請求書は手動で作成）]** にする（§11.3）

### 5.3 `[締める]` の処理（新ペイロード `month_close`）🔄

**プロトコル（`shared/src/protocol.ts` に追加）**:

```ts
| {
    kind: "month_close";
    idempotency_key: string;   // buttonIdempotencyKey（action_id = kado_month_close）
    user_id: string;
    channel_id: string;
    message_ts: string;        // 押されたカード
    client: string;
    month: string;             // YYYY-MM
    /** カードに表示していた差引入金予定額（古いカードからの押下を検出する）。 */
    shown_net_amount: number;
    received_at_ms: number;
    source: "button" | "retry";
  }
```

**GAS `handleMonthClose`**（`dispatch` は他の種別と同じく `withLock` で包む。🔄 **MF はここでは呼ばない**。M9）:

1. 月次行を読む
2. 凍結済み（`LOCKED` 以降）→ `{applied:false, reason:'DUPLICATE'}`。カードを現在の状態で描き直す
3. `OPEN` → `{applied:false, reason:'NOT_READY'}`
4. 🔄 **`message_ts !== close_card_ts`**（古いカード・作り直し前のカード）→ `{applied:false, reason:'STALE_CARD'}`
5. `REVIEWING` → `recomputeMonthly` して `hasBlockers` と金額を再確認する
   - blockers あり → `state = OPEN`。カードを「要修正があります」に描き直す
   - `net_amount !== shown_net_amount` → 状態は変えず、新しい金額でカードを描き直して「金額が変わりました。確認してから押し直してください」
   - 問題なし → `state = LOCKED`・`locked_at`・`invoice_state` を書く（`MF_INVOICE_ENABLED` が有効なら `PENDING`、無効なら **`MANUAL`**）
6. `invoice_state = PENDING` なら、**1 分後に 1 回だけ動く時間トリガー `trigMfSyncSoon` を作る**（§7）。カードを「🔒 締めました。請求書を作成しています…」に描き直す

- 請求書の作成はトリガー側（§5.5）に寄せる。**締めボタンの処理は数秒で終わり、Worker の 25 秒タイムアウトとは無関係**になる
- Worker 側は ACK して GAS に転送するだけ。カードの更新は GAS が行う（§10.1）

### 5.4 請求書の組み立て（`core/invoice.ts`、純関数）

`buildInvoiceRequest(bill: MonthlyBillRow, unit: UnitPriceRow, daily: DailySummaryRow[], cfg)`:

| 項目 | 値 |
|---|---|
| `department_id` | `MF_DEPARTMENT_ID`（**10/1 に A社の取引先・部署を MF で登録してから設定する**） |
| `billing_number` | `KD-{YYYYMM}`（例 `KD-202610`。30 字以内）。**単一取引先を前提にした冪等キー**。取引先が増えたら §13 で見直す |
| `billing_date` / `sales_date` | 対象月の末日 |
| `due_date` | 翌月末。土日・祝日・§5.6 の休日なら**前の営業日**（契約の「休日は前営業日」） |
| `title` | `{M}月分 業務委託料` |
| `items[0]` | `name: "{YYYY}年{M}月分 業務委託料"`、`detail: "稼働 {hours} 時間"`、`unit: "時間"`、`quantity: hours`、`price: unit_price`、`excise`: `tax_category` が `課税` → `ten_percent`／`不課税` → `untaxable`、`is_deduct_withholding_tax: withholding === "10.21%"` |
| `note` | 日別明細（下記）。**2000 字を超えたら末尾を切り、「（以下省略。日別明細は別添）」を付ける** |
| `memo` | `kadobo client={client} month={month}`（MF の社内メモ。先方には出ない） |

- 入力はすべて**締めた時点で凍結されている**（月次行は `isMonthFrozen` で書かれず、日次集計はその月の訂正が拒否される。§5.8 の遅延打刻も月次行には反映しない）。
  単価は `selectUnitPrice(unitRows, "<月>-01")` で引き直すが、単価マスタは改定を新しい行で追加する運用なので過去月の値は変わらない

**日別明細（`note`）の形式**: `日次集計` の `OK` 行を日付順に並べる。1 行 `MM/DD(曜) H:MM`、末尾に `合計 {hours} 時間（{minutes} 分）`。
23 営業日で約 350 字。

### 5.5 作成と照合（`app/invoice.ts` `ensureInvoiceCreated`）🔄

対象: `state = LOCKED` かつ `invoice_state ∈ {PENDING, UNKNOWN}` のすべての月。

```
lease("mf_invoice/<client>:<month>", 10分) を取れなければ → 何もしない（別の実行が作成中）
1. mf_invoice_id があれば → GET /billings/{id} → 照合（3 へ）
2. GET /billings?document_number=KD-YYYYMM を全ページ取得し、billing_number が完全一致するものを数える
     1 件 → その id を保存して照合（3 へ）
     2 件以上 → invoice_state = ERROR（人が MF で重複を消す）
     0 件 かつ invoice_state = PENDING → invoice_attempted_at を保存してから POST /invoice_template_billings
          201 → id を保存して照合（3 へ）
          MfOutcomeUnknownError → invoice_state = UNKNOWN。Slack「MF で作成されたか確認できません。自動では作り直しません」
          MfApiError → invoice_state = ERROR
          MfTransientError（429） → PENDING のまま（次回再試行）
     0 件 かつ invoice_state = UNKNOWN → 何もしない（次回また検索する）。
          invoice_attempted_at から 24 時間たっても見つからなければ、1 回だけ Slack で依頼する:
          「MF に請求書が無ければ、月次請求シートの invoice_state を PENDING に戻してください（作り直します）。
            あれば mf_invoice_id に ID を書いてください」
3. 照合（compareAmounts。純関数）:
     subtotal_price === amount、excise_price === tax_amount、
     total_price === amount + tax_amount、
     deduct_price（無ければ 0）=== withholding_amount、
     total_price − deduct_price === net_amount
   一致 → state = MF_CREATED、invoice_state = CREATED。Slack「✅ 請求書を作成しました（未送付）。MF で確認して送付してください」＋ MF 画面の URL
   不一致 → state = MF_CREATED、invoice_state = MISMATCH、invoice_error に差額。Slack「⚠️ 金額が一致しません。送付しないでください」
lease は結果をシートに書き終えてから解放する
```

- **lease**（新規・内部シート `lease/<key>` に期限 ms）: 取得・解放は短いスクリプトロック内で行う。期限切れは奪ってよい
- シートへの書込みはすべて**短いスクリプトロック内で行を読み直してから、請求書関連の列だけ**を書く（§0）
- `MISMATCH` の月は `trigMfSync` が**毎日 1 回**（内部シート `mf_notice/mismatch/<月>`）警告を出し続ける。解消は §11.6 の作り直し
- 金額不一致の原因として想定しているのは、**MF 側の端数処理設定（`config.rounding`）と単価マスタの食い違い**と、**数量の小数の扱い**（S-M1 で確認する）
- 作成直後の請求書は未送付（送付 API が存在しない。未決事項 §6.2）

### 5.6 支払期日の休日判定 🔄

`CalendarPort.isHoliday` は既存（`ja.japanese#holiday`）。**年末年始（12/31〜1/3）は祝日カレンダーに無い**ため、
`MF_EXTRA_HOLIDAYS`（`MM-DD` のカンマ区切り、既定 `12-31,01-02,01-03`）も休日とみなす。
**実際に効くのは 11 月分（支払日 12/31）**で、12/31 が休日なら前の営業日（12/30。土日なら更に前）にする。

### 5.7 送付・入金の追跡（`trigMfSync` 内）

- 対象: `state ∈ {MF_CREATED, SENT}` の月次行（通常 0〜1 件）。`GET /billings/{id}` を 1 回呼ぶ
- `normalizeBillingStatus` で正規化してから判定する（§3.1）:
  - **送付済み**: `email_status` が `sent`・`already_read`・`送付済み`・`受領済み` のいずれか、または `posting_status` が `sent`・`郵送済み`
  - **入金済み**: `payment_status` が `"2"`・`入金済み`（MF 画面で消込したとき）
- `nextStateOnBillingStatus` で遷移したら `state` 列だけを書き、Slack に 1 行通知する
- メール・郵送以外（PDF を別手段で送る等）で送った場合と、`MANUAL` の月は、シートの `state` を手で進める（runbook に記載）

### 5.8 締めた月への打刻の遅延到着 🔄（M5）

GAS の障害で打刻が pending に溜まり、**締めた後に Cron 再送で届く**ことがありうる（月末の夜の打刻が 1 日の朝の締めより後に届く等）。

- `handleStamp` は**生ログへの追記はこれまでどおり行う**（生ログは稼働の事実そのもので、捨てない）
- 日次集計も再計算する。月次行は `isMonthFrozen` で書かれない
- 🔄 追記した業務日の月が凍結済みなら、**DM で通知する**: 「締め済みの {月} への打刻が遅れて届きました。差異は翌月調整として扱ってください」（要件定義 §4.2.4「差異は翌月調整として別途記録」）。
  内部シート `late_stamp/<event_id>` に記録する（翌月調整の一覧）

---

## 6. ②③ 経費の仕訳連携

### 6.1 経費台帳の列を追加する（25〜31 列目、既存 24 列の**後ろ**に足す）

既存の列番号を変えないため、**末尾に追加**する。`migrateExpenseLedger` を V2 → V3 に拡張する（既存と同じ方式でヘッダー一致を判定して追記）。

| # | 見出し | TS 名 | 種別 | 内容 |
|---|---|---|---|---|
| 25 | 支払方法 | `payment_method` | 業務列 | `linked_card`・`linked_bank`・`cash`。**空＝旧行（支払方法なし）** |
| 26 | MF明細ID | `mf_transaction_id` | 業務列 | ③ で使う明細 ID。**`NEEDS_REVIEW` のときは人が記入できる** |
| 27 | MF連携状態 | `mf_sync_state` | システム列 | §6.3 |
| 28 | MF連携エラー | `mf_sync_error` | システム列 | 最後のエラー要約（トークン・URL を含めない） |
| 29 | MF連携更新日時 | `mf_sync_updated_at` | システム列 | epoch ms |
| 30 | MF連携試行日時 | `mf_sync_attempted_at` | システム列 | 🔄 作成系 POST を送った時刻（`UNKNOWN` の判定に使う） |
| 31 | MF連携入力 | `mf_sync_input` | システム列 | 🔄 仕訳を作ったときの入力の要約（`金額|日付|カテゴリ|支払方法|明細ID`）。**作った後に人が業務列を直したことを検出する**（M5） |

- 既存の `MF仕訳ID`（14 列目）は、**kadobo が仕訳を作ったら自動で書く**。人が MF で仕訳した場合は従来どおり手で書いてよい（§6.3）
- システム列の保護は既存と同じ扱い（警告付き保護・既定非表示）
- 🔄 **MF 同期が書くのは列 14・26〜31 だけ**。`SheetsPort.updateExpenseColumns(receiptId, patch)`（指定列だけを書く）を追加して使う

### 6.2 同期の対象 🔄（B2）

**毎回の実行で判定し直す**（判定結果を「対象外」として保存しない）。次をすべて満たす行が「仕訳を作ってよい行」:

- `処理状態 === COMPLETED`（`RECEIVED`・`FILE_SAVED` は**まだ登録中なので待つ**。状態は空のまま）
- `日付 >= MF_SYNC_START_DATE`（`2026-10-01`＝開業日）
- `支払方法` が空でない（後から人が記入すれば、次の実行で対象になる）
- `事業使用割合 === 100`（§2.4。100 未満は `NEEDS_REVIEW`）

**永久に対象外として `NOT_TARGET` を書くのは、`日付 < MF_SYNC_START_DATE` の行だけ**。
この行は開業前の支出で、開業費か固定資産等かを**人が分類して** MF に登録する（開業日前の支出がすべて開業費になるわけではない）。

### 6.3 行ごとの同期状態（`core/journalSync.ts`、純関数で遷移を定義）🔄

| 状態 | 意味 | 次に起きること |
|---|---|---|
| （空） | 未着手 | §6.2 を満たせば `cash` → `PENDING`、`linked_*` → `WAITING_TRANSACTION`。割合が 100 未満なら `NEEDS_REVIEW` |
| `NOT_TARGET` | 開業前の支出 | なし（人が MF で処理） |
| `PENDING` | 現金・立替の仕訳待ち | §6.4 |
| `CREATING` | `POST /journals` を送った（応答待ち・結果未保存） | §6.4 の回収 |
| `WAITING_TRANSACTION` | 連携明細の取込み待ち | §6.5 |
| `JOURNALIZING` | 明細 ID を確保し、`journalize` を送った | §6.5 の回収 |
| `UNKNOWN` | 作成の結果が分からないまま 24 時間回収できなかった | 人の確認待ち（§6.4） |
| `NEEDS_REVIEW` | 人の判断待ち | 人が `MF明細ID` を記入 → 検証してその明細で仕訳。人が MF で仕訳して `MF仕訳ID` を記入 → `SYNCED` |
| `SYNCED` | 仕訳済み（`MF仕訳ID` あり） | `処理状態` が `CORRECTED`/`VOID` になったら §6.7。業務列が `mf_sync_input` と食い違ったら通知して `NEEDS_REVIEW` |
| `REVERSING` | 訂正・取消に伴い仕訳を削除中 | §6.7 |
| `REVERSED` | 仕訳を削除済み。**明細は手放した** | なし |
| `ERROR` | 業務エラー（400 等。作られていない） | 人が原因を直して `MF連携状態` を空に戻すと再評価される |

**1 回の実行で処理する順番**（M5・B2・B3・B7）:

1. **回収**: `CREATING`・`JOURNALIZING`・`REVERSING` の行を先に片づける
2. **取消**: `CORRECTED`/`VOID` になった行のうち、仕訳がある（`SYNCED`）か作りかけ（1 で回収できたもの）の行を §6.7 で削除する
3. **手入力の取り込み（B7）**: 状態が空・`PENDING`・`WAITING_TRANSACTION`・`NEEDS_REVIEW` で **`MF仕訳ID` が入っている行**は、kadobo は作らずに `SYNCED` にする（`GET /journals/{id}` で存在だけ確かめる）
4. **変更の検出**: `SYNCED` の行で、業務列から作った要約が `mf_sync_input` と違えば通知して `NEEDS_REVIEW`
5. **新規**: §6.2 を満たす行を §6.4・§6.5 で処理する

### 6.4 ② 現金・立替（`POST /journals`）🔄

```
PENDING:
  1. 冪等確認: GET /journals?start_date=日付&end_date=日付 の全ページから tags に証憑ID を含む仕訳を探す
     あり → その id を採用して SYNCED
  2. なし → ロック内で state = CREATING、mf_sync_attempted_at、mf_sync_input を書く
  3. POST /journals
     { journal: {
         transaction_date: 日付, journal_type: "journal_entry",
         branches: [{
           debitor:  { account_id: 経費科目, value: 金額 },
           creditor: { account_id: 事業主借, value: 金額 },
           remark: "{証憑ID} {取引先}"(200字で切る) }],
         memo: Driveリンク（200字を超えるなら省略）,
         tags: [証憑ID] } }
     201 → MF仕訳ID を書いて SYNCED
     MfApiError・429 → PENDING に戻す（ERROR は MfApiError のとき）
     MfOutcomeUnknownError → CREATING のまま（次回の回収へ）

CREATING（回収）:
  1 と同じ検索。あり → SYNCED
  なし かつ 試行から 24 時間未満 → 何もしない（次回また検索する）
  なし かつ 24 時間以上 → UNKNOWN。Slack で 1 回だけ依頼する:
     「MF に仕訳が無ければ MF連携状態 を空に戻してください（作り直します）。あれば MF仕訳ID に ID を書いてください」
```

- 🔄 **応答が得られた 400 と 429 は「作られていない」ので作り直してよい**。作り直さないのは結果が分からないときだけ
- 🔄 `tax_id`・`invoice_kind` は**送らない**（§3.2。免税事業者は税区分を登録できない）
- 週次で、**同じ証憑 ID のタグを持つ仕訳が 2 件以上**あれば報告する（二重作成の事後検知。§6.6）

**科目の対応（`core/journalSync.ts` の定数）**:

| カテゴリ | 借方科目名 |
|---|---|
| 通信費・消耗品費・旅費交通費・新聞図書費・会議費・支払手数料 | 同名 |
| その他 | **雑費** |
| （貸方・現金立替） | **事業主借** |

- 名前から ID への解決は `GET /accounts`（`available: true` かつ名前完全一致）で行い、`TtlCachePort` に 6 時間保存する。**見つからなければ `ConfigMissingError` 相当で止める**（勝手に別科目へ寄せない）

### 6.5 ③ 連携明細との照合（`POST /transactions/journalize`）🔄

**連携サービスを支払方法ごとに分ける**（B5）:

| 支払方法 | 候補にする連携サービス |
|---|---|
| `linked_card` | `MF_CARD_ACCOUNT_IDS`（カンマ区切りの `connected_account_id`） |
| `linked_bank` | `MF_BANK_ACCOUNT_IDS` |

**明細の取得**: `GET /transactions`
- 期間: 待ち行の日付の最小値 − 3 日〜今日。**366 日を超えるなら分割して呼ぶ**
- `side=EXPENSE`、`journalizing_statuses=none`（未仕訳）、`connected_account_id` ごとに呼ぶ、`per_page=500` で全ページ

**照合（`core/journalSync.ts` `matchTransactions(rows, txs)`、純関数）**:

- 🔄 照合は**待ち行すべて**（バッチの 20 行に限らない）と、取得した明細すべてで行う。API を呼ぶ件数だけをバッチで制限する
- 行 r の候補: 支払方法に対応する連携サービスの明細で、`value === 金額` かつ `date ∈ [日付 − MATCH_DAYS_BEFORE, 日付 + MATCH_DAYS_AFTER]` かつ**使用中でない**明細
  - **使用中の明細** = いずれかの行の `MF明細ID` にあり、その行の状態が `JOURNALIZING`・`SYNCED`・`REVERSING`・`NEEDS_REVIEW` のもの（**`REVERSED`・`ERROR` の行は明細を手放している**。B4）
  - 初期値 `MATCH_DAYS_BEFORE = 2`、`MATCH_DAYS_AFTER = 10`（S-M4 で調整）
- 🔄 **自動で確定するのは一対一のときだけ**: 行 r の候補がちょうど {t} で、かつ明細 t を候補にしている待ち行が r だけのとき。
  v1 にあった「日付が一致するものを優先する」規則は**削除した**（取り合いを許すため）
- それ以外（候補が複数、明細の取り合い）→ `NEEDS_REVIEW`。Slack に候補（明細 ID・日付・内容・金額）を並べ、
  「正しい明細 ID を経費台帳の `MF明細ID` 列に書いてください」と案内する（ボタンは作らない。低頻度のため）
- 候補 0 件のまま日付から 14 日たった行は、**1 回だけ**通知する（「支払方法の誤り・金額違い・外貨換算の可能性」）
- 🔄 **訂正で作り直した行**（`訂正元証憑ID` がある行）は、訂正元の行が `REVERSED`（または仕訳を作っていない）になるまで待たせる（旧仕訳が明細を手放すのを待つ）

**仕訳の作成**（B3）:

```
WAITING_TRANSACTION で候補 t が確定:
  1. ロック内で MF明細ID = t.id、state = JOURNALIZING、mf_sync_attempted_at、mf_sync_input を書く   ← 先に保存する
  2. POST /transactions/journalize
     { transaction_id: t.id, transaction_date: 経費台帳の日付, account_id: 経費科目,
       remark: "{証憑ID} {取引先}", memo: Driveリンク, tags: [証憑ID] }
     201 → MF仕訳ID を書いて SYNCED
     MfApiError → 明細 t の状態を確認してから決める（下の回収と同じ）
     MfOutcomeUnknownError → JOURNALIZING のまま（次回の回収へ）

JOURNALIZING（回収。毎回の実行の最初に行う）:
  GET /journals?start_date=日付−1&end_date=日付+1&transaction_ids=<MF明細ID>
    あり → MF仕訳ID を書いて SYNCED
    なし → GET /transactions で明細 t がまだ未仕訳か確かめる
      未仕訳 → journalize をもう一度送ってよい（1 つの明細から仕訳は 1 つしかできないので、二重にならない）
      仕訳済みなのに kadobo の検索で見つからない → NEEDS_REVIEW（人が MF で確認）
```

- 人が記入した `MF明細ID`（`NEEDS_REVIEW` から）も、**支払方法に対応する連携サービスの明細で、金額が一致し、使用中でない**ことを確かめてから `JOURNALIZING` に進める。
  一致しなければ `NEEDS_REVIEW` のまま `MF連携エラー` に理由を書く

### 6.6 明細ルール（NISA・カード引落し）と週次の報告 🔄

連携カード・連携口座には、**証憑を伴わない支出**が必ず混ざる:

| 明細 | 出どころ | 正しい仕訳 |
|---|---|---|
| **NISA のクレカ積立** | **連携カード** | `事業主貸 ／ 未払金（カード）` |
| **NISA の口座からの積立** | 連携口座 | `事業主貸 ／ 普通預金` |
| **カード代金の引落し** | 連携口座 | `未払金 ／ 普通預金`（中身の支出はカード側で仕訳済み） |

- NISA はカードからも出るので、**カード明細の段階で私用と分けないと、経費の照合候補に混ざり、未登録支出の報告にも毎月出てしまう**
- カード代金の引落しには **NISA の積立分も含まれる**。カード側で NISA を `事業主貸 ／ 未払金` にしておけば、引落しは合計額のまま `未払金 ／ 普通預金` で合う（引落しを分解する必要はない）

**明細ルールのシート（新設 `MF明細ルール`、人が編集する）**:

| 列 | 例（NISA・カード） | 例（NISA・口座） | 例（カード引落し） | 意味 |
|---|---|---|---|---|
| ルール名 | NISA クレカ積立 | NISA 口座積立 | カード代金引落し | 通知・摘要に使う |
| 対象 | `card` | `bank` | `bank` | `card`＝`MF_CARD_ACCOUNT_IDS`、`bank`＝`MF_BANK_ACCOUNT_IDS`、`any` |
| 内容に含む文字列 | （S-M4 で確認した表記） | 同左 | 同左 | 明細の `content` の部分一致。**必須**（空のルールは無効として無視し、週次で報告する） |
| 金額 | `50000` | （空） | （空） | 空なら金額を問わない。**積立額が決まっているなら入れる**（誤判定を減らす） |
| 処理 | `私用として仕訳` | `私用として仕訳` | `無視` | 下表 |
| 勘定科目 | `事業主貸` | `事業主貸` | （空） | 「私用として仕訳」のときの相手科目 |
| 有効 | `TRUE` | `TRUE` | `TRUE` | `FALSE` なら使わない |

| 処理 | kadobo がすること |
|---|---|
| **私用として仕訳** | `POST /transactions/journalize`（`account_id` = 勘定科目、`remark` = `私用: {ルール名}`、`tags` = `["kadobo-rule"]`、`transaction_date` は明細の日付）。**経費の照合より前に行う**。1 つの明細から仕訳は 1 つしかできないので、応答が失われても次回「未仕訳のまま」なら送り直すだけでよい（§6.5 の回収と同じ理屈。専用の状態列は持たない） |
| **無視** | 照合の候補・未登録支出の報告から外すだけ。仕訳は MF 側で人が行うか、MF の自動仕訳ルールに任せる |

- **判定の順番**（`core/journalSync.ts` `classifyTransaction`、純関数）: 取得した未仕訳明細それぞれについて、有効なルールを**シートの上から順に**見て、最初に当たったものを使う。
  どのルールにも当たらない明細だけが経費の照合（§6.5）に進む
- 🔄 **安全策**: 私用として仕訳しようとした明細が、**同時に経費台帳のどれかの行の候補にもなっている**（同じ支払方法・金額・日付の範囲）ときは、仕訳せずに Slack で知らせる
  （「NISA ルールに当たりましたが、経費 R-… と金額が同じです。どちらか確認してください」）。ルールの文字列が店名にも当たってしまう誤設定を防ぐ
- 私用として仕訳した明細は、週次の報告に「私用として処理した明細: n 件（合計 x 円）」として出す（毎月の積立が止まった・増えたに気づける）
- 実行のフラグは `MF_MATCH_ENABLED`（§9）。同期の 1 回あたりの上限（§6.8）にはルールによる仕訳も数える
- 🔄 **WP-M5 の本番有効化の条件**: 1 か月分の明細で、**カード・口座それぞれの残高と帳簿残高が合う**ことを確かめる（NISA がカード側・口座側のどちらから出ても、帳簿上で私用として落ちていること）

**週次の報告**（`trigWeeklyOrphanCheck` に追加。毎週月曜）:

- **未登録の支出**: 未仕訳・`EXPENSE`・`date >= MF_SYNC_START_DATE`・**7 日以上前**・使用中でない・**明細ルールに当たらない**明細を列挙する。
  「`/keihi` で証憑を登録するか、私用なら MF で `事業主貸` として仕訳してください」と案内する。
  口座を事業専用に近い形で使うので、ここに出るのは基本的に**証憑の出し忘れ**になる
- **二重作成の疑い**: 同じ証憑 ID のタグを持つ仕訳が 2 件以上
- **人の判断待ち**: `NEEDS_REVIEW`・`UNKNOWN` の行の件数
- 🔄 **私用として処理した明細**: ルールごとの件数と合計
- 🔄 **無効なルール**: 「内容に含む文字列」が空の行、「私用として仕訳」なのに勘定科目が引けない行

### 6.7 訂正・取消の反映

経費設計 §5.7 のとおり、訂正・取消はシート上で `処理状態` を `CORRECTED`/`VOID` に変えて行う。
§6.3 の手順 2 で、**仕訳がある行**（`SYNCED`、または回収で仕訳が見つかった `CREATING`/`JOURNALIZING`）を見つけたら:

1. ロック内で `REVERSING` にする
2. `DELETE /journals/{MF仕訳ID}` を呼ぶ（404 は削除済みとして成功扱い）
3. `REVERSED` にし、Slack に 1 行通知する。**この時点で明細を手放す**（§6.5 の使用中の判定から外れる）
4. 訂正後の新しい行は通常どおり同期される。明細から作った仕訳を消すと明細は未仕訳に戻る見込みで（**S-M5 で確認**）、新しい行がその明細と照合できる

- **削除は自動で行う**（利用者は 1 人で、訂正の操作そのものが削除の意思表示のため）。MF 側の訂正削除履歴は MF が持つ
- 仕訳が無い行（状態が空・`PENDING`・`WAITING_TRANSACTION`・`NEEDS_REVIEW`）の取消は、状態を `REVERSED` にするだけ

### 6.8 同期の実行単位 🔄（M9）

- `trigMfSync` 1 回で API を呼ぶ行は **20 行まで**（`MF_SYNC_BATCH`）。照合の計算は全行で行う（§6.5）
- 🔄 **実行時間の上限**: 実行開始から **4 分**たったら、新しい行に手を付けずに終える（GAS の 1 実行 6 分の内側）。
  行ごとに結果を書いてから次の行へ進むので、途中で終わっても次の実行が続きから処理する
- GAS のトリガー実行時間は個人アカウントで 1 日 90 分まで（[Google 公式](https://developers.google.com/apps-script/guides/services/quotas)）。
  毎時の同期が通常 30 秒以内なら 1 日 12 分程度で収まる（WP-M4 の本番投入後 1 週間、実測を記録する）
- **シートの読み書きは短いスクリプトロック、MF の呼び出しはロックの外**:
  1. ロックあり: 対象行を読んで一覧を作る
  2. ロックなし: MF を呼ぶ
  3. ロックあり: **行を読み直し**、`証憑ID` で特定して §6.1 の列だけを書く
- 同時実行の防止: lease `mf_sync` を 10 分で取る（§5.5 と同じ仕組み）

---

## 7. トリガー 🔄

| 関数 | 時刻 | 処理 |
|---|---|---|
| `trigMonthly`（既存） | 毎月 1 日 06 時台 | 既存の集計を**ロックの中に入れる**（§5.2）。その後 `evaluateMonthClose` |
| **`trigMfSync`（新規）** | **毎時** | ① `evaluateMonthClose`（§5.2）→ ② `ensureInvoiceCreated`（§5.5）→ ③ 送付・入金の追跡（§5.7）→ ④ `MISMATCH` の毎日の警告 → ⑤ 経費同期（§6） |
| **`trigMfSyncSoon`（新規）** | 締めボタンから **1 分後に 1 回** | 最初に**自分と同名の時間トリガーをすべて削除**してから `trigMfSync` と同じ処理を行う |
| `trigWeeklyOrphanCheck`（既存） | 毎週月曜 07 時台 | 既存処理の後に §6.6 の週次報告、§4.2 の週次の疎通 |

- `installTriggers` の `TRIGGER_FUNCTION_NAMES` に `trigMfSync`（`everyHours(1)`）と `trigMfSyncSoon`（作り直しの際に消すため）を足す
- `trigMfSyncSoon` は締めボタンで作る（`ScriptApp.newTrigger("trigMfSyncSoon").timeBased().after(60 * 1000)`）。
  作る前に同名のトリガーが残っていれば作らない（1 個まで。GAS のトリガー数上限 20 を消費し続けないため）
- 各処理は独立に try/catch し、1 つの失敗で他を止めない（`trigEveningCheck` と同じ方針）
- 手動実行用のエントリとして `mfInvoicePing()`（`GET /office`）と `mfAccountingPing()`（`GET /accessible_offices` と `GET /accounts` の件数）を `entry.ts` に追加する

---

## 8. ポートとファイル構成（追加分）

```
gas/src/
  adapters/http.ts            HttpPort（UrlFetchApp）
  adapters/secretStore.ts     SecretStorePort（ScriptProperties）
  adapters/ttlCache.ts        TtlCachePort（CacheService、プレフィックス mf:）
  adapters/authLock.ts        AuthLockPort（LockService.getUserLock()）
  app/mf/errors.ts            MfReauthRequiredError / MfAuthError / MfTransientError / MfOutcomeUnknownError / MfApiError
  app/mf/invoiceClient.ts     MfInvoiceClient（§4.2）
  app/mf/accountingClient.ts  MfAccountingClient（§4.3）
  app/mf/lease.ts             lease の取得・解放（内部シート）
  app/mf/flags.ts             §9 のフラグの判定（全体停止を含む）
  app/monthClose.ts           evaluateMonthClose / handleMonthClose
  app/invoice.ts              ensureInvoiceCreated / trackBillingStatus
  app/journalSync.ts          syncExpenses / weeklyMfReport
  core/monthClose.ts          状態機械（§5.1）
  core/invoice.ts             buildInvoiceRequest / dueDateOf / renderDailyNote / compareAmounts / normalizeBillingStatus
  core/journalSync.ts         状態遷移・対象判定・科目対応・matchTransactions・除外判定・入力要約
scripts/mf-oauth-authorize.mjs
```

- `AppPorts` に `http`・`secrets`・`ttlCache`・`authLock`・`scheduler` を追加する。`ClockPort` に `sleep` を追加する
  - `scheduler: SchedulerPort` = `{ scheduleOnce(handler: "trigMfSyncSoon", afterMs: number): void; hasPending(handler): boolean; clear(handler): void }`（`ScriptApp` の時間トリガー。§7）
- `SheetsPort` に追加:
  - 🔄 `updateMonthlyBillColumns(client, month, patch)`（指定列だけを書く）。**`recomputeMonthly` もこれを使って数値列・`note`・`updated_at` だけを書く**（`upsertMonthlyBill` は行が無いときの新規作成だけに使う）
  - 🔄 `updateExpenseColumns(receiptId, patch)`（指定列だけを書く）
  - `listMonthlyBills(): MonthlyBillRow[]`、`getInternalRows(kind): {key,value}[]`（遅延打刻の読み出し）
  - 🔄 `getMfTransactionRules(): MfTransactionRule[]`（`MF明細ルール` シートを上から順に返す。`setupSpreadsheet` がシートとヘッダーを作る）
  - `MonthlyBillRow` に §5.1 の 4 列、`ExpenseLedgerRow` に §6.1 の 7 列を足す
- クライアントは `AppPorts` から組み立てる関数（`makeMfInvoiceClient(ports)` 等）で作る。ポートには入れない

---

## 9. Script Properties（追加）🔄

**フラグ**（既定はすべて無効）:

| キー | 止めるもの |
|---|---|
| **`MF_ENABLED`** | **MF への呼び出しすべて**（請求書・会計・週次の疎通・週次報告・取消）。障害時はまずこれを `false` にする |
| `MF_INVOICE_ENABLED` | 請求書の作成・追跡・週次の疎通。**締めた時点で無効なら、その月は `MANUAL`**（§5.1） |
| `MF_JOURNAL_ENABLED` | ② 現金・立替の新規作成 |
| `MF_MATCH_ENABLED` | ③ 明細との照合・新規作成・**明細ルールによる私用仕訳**・未登録支出の報告 |

- 回収（`CREATING`/`JOURNALIZING`/`REVERSING`/`UNKNOWN`）と取消（§6.7）は、`MF_ENABLED` が有効なら**②③のフラグにかかわらず**行う（作りかけを放置しないため）
- `app/mf/flags.ts` にこの表をそのまま実装し、**すべてのフラグが無効なら HTTP が 1 件も出ない**ことを受入試験にする

**設定値**:

| キー | 例 | 用途 | 未設定時 |
|---|---|---|---|
| `MF_BILLING_START_MONTH` | `2026-10` | 締め確認を出す最初の月 | 締め確認を出さない |
| `MF_CLIENT_ID` / `MF_CLIENT_SECRET` | | OAuth（`CLIENT_SECRET_BASIC`） | `ConfigMissingError` |
| `MF_INVOICE_TOKENS` | JSON（§4.2） | GAS が更新する | `MfReauthRequiredError` |
| `MF_DEPARTMENT_ID` | | 請求先部署（10/1 に登録） | `ConfigMissingError` |
| `MF_EXTRA_HOLIDAYS` | `12-31,01-02,01-03` | §5.6 | 既定値を使う |
| `MF_ACCOUNTING_API_KEY` | `mf_api_prd_…` | §4.3 | `ConfigMissingError` |
| `MF_OFFICE_CODE` | `XXXX-XXXX` | §4.3（`mfAccountingPing` が `GET /accessible_offices` で表示する） | `ConfigMissingError` |
| `MF_SYNC_START_DATE` | `2026-10-01` | §6.2 | 同期しない |
| `MF_CARD_ACCOUNT_IDS` / `MF_BANK_ACCOUNT_IDS` | `id1,id2` | §6.5 | その支払方法は照合しない |

- API キーは**必要最小限の権限**で発行する: 会計の「仕訳（編集）」「会計帳簿（閲覧）」「連携サービスから入力（閲覧・編集）」「データ連携（閲覧）」「勘定科目（閲覧）」
- トークン・API キーはログ・Slack・シートに出さない（既存の Slack トークンと同じ扱い）

---

## 10. Worker・shared の変更

### 10.1 締めボタン

- `shared/src/protocol.ts`: `GasRequest` に `month_close`（§5.3）
- 🔄 **`gas/src/app/validateRequest.ts` に `case "month_close"` を追加する**（M10）。
  漏れると本番の押下が `BAD_REQUEST` になる（経費フェーズで `expense_submit` が同じ漏れを起こした。同ファイル冒頭の注記）
- `gas/src/app/dispatch.ts` の `routeRequest` に `month_close` を追加する（`withLock` で包む。§5.3）
- `worker/src/slack/parse.ts`: `action_id` に `kado_month_close` を追加する
- `worker/src/index.ts`: `block_actions` の分岐に追加する。`value` を JSON として防御的にパースし（`client`・`month`・`net_amount`）、
  `month_close` を組み立てて D1 ジャーナルへ記録し、ACK して GAS に転送する（`kado_correct` と同じ流れ）
- `worker/src/journal.ts`: `kind` の union に `month_close` を追加する
- Cron 再送: 他の種別と同じ（`source` を `retry` に書き換える）。`channel_id`・`message_ts` を持つので既存の再送失敗通知がそのまま使える
- **Worker はカードを書き換えない**（⏳ 表示もしない）。カードの更新は GAS が行う

### 10.2 `/keihi` の支払方法

- `shared/src/expense.ts`: `PAYMENT_METHODS = ["linked_card", "linked_bank", "cash"] as const`、表示名、`isPaymentMethod`
- 経費モーダル（経費設計 §2.2）に行を追加する: `block_id: payment_method` / `action_id: payment_method_select` / `static_select` / **必須** / 初期選択なし。
  **証憑区分の直後**に置く
- `view_submission` の同期バリデーションに「支払方法を選択してください」を追加する
- `expense_submit` に `payment_method?: PaymentMethod` を追加する。**任意項目にする**（GAS を先にデプロイしたとき、旧 Worker からの pending 再送が来ても受け付けられるように）。
  GAS（`validateRequest.ts` を含む）は欠けていれば空で台帳に書く（その行は後から人が記入すれば対象になる。§6.2）

### 10.3 デプロイ順

shared を変えるので**両側**をデプロイする（runbook 02）。**GAS → Worker の順**:

1. GAS: `payment_method` を任意で受け付け、`month_close` を処理できる版。`setupSpreadsheet` で経費台帳 V3・月次請求の追加列を作り、`installTriggers` を実行
2. Worker: 締めボタンと支払方法をモーダルに出す版
3. Script Properties のフラグを段階ごとに有効にする

---

## 11. 先行スパイク・リリース・運用

### 11.1 実装前のスパイク（実物の MF で確認する）🔄

| # | 内容 | 前提 | 決めること |
|---|---|---|---|
| **S-M1** | テスト用の請求書を作る。**`quantity: 160.01`、`price: 1800`、`ten_percent`**（報酬 288,018 円、消費税 28,801.8 円で**端数が出る**）。応答の `subtotal_price`・`excise_price`・`total_price`・`config.rounding`・`config.rounding_consumption_tax` が単価マスタの計算（切捨）と一致するか確かめる。MF 画面で「消費税相当額」の見え方を目視する。確認後に削除する | 10/1 の取引先・部署の登録 | MF 側の端数処理の設定、小数数量の可否 |
| **S-M2** | `GET /billings?document_number=` が完全一致か部分一致か。作成直後に検索して**すぐ見つかるか** | S-M1 の請求書 | §5.5 の回収の前提 |
| **S-M3** | API キーの発行 → `/auth/exchange` → `GET /accessible_offices`（`office_code`）→ `GET /accounts`（§6.4 の 8 科目が名前完全一致で引けるか） | なし（すぐできる） | ✅ **2026-10-08 完了**（`mfAccountingPing` で実施。未決事項 §6.14 の実測表）。8 科目とも 1 件ずつ引ける。既定 `tax_id` は `available: false`（免税設定）なので送らない方針で確定 |
| **S-M4** | カードと口座を MF に連携 → `GET /connected_accounts` → `GET /transactions`。**カード明細の `date` が利用日か計上日か**、`content` の表記（店名・**NISA のクレカ積立と口座積立**・カード引落し） | 利用者による連携 | `MATCH_DAYS_*`、明細ルールの文字列と金額、`MF_CARD_ACCOUNT_IDS`/`MF_BANK_ACCOUNT_IDS` |
| **S-M5** | テスト仕訳を `POST /journals` で作る（**`tax_id` なしで作れるか、免税事業者の設定で金額が税込のまま入るか**、tags・remark・memo が保存されるか）→ 作成直後に `GET /journals` で見つかるか → `DELETE`。連携明細 1 件を `journalize` → `DELETE` して**明細が未仕訳に戻るか** | S-M3・S-M4 | §6.4・§6.7 の前提 |
| **S-M6** 🔄 | GAS で、ユーザーロックを持ったまま別の実行がスクリプトロックを取れるか（2 つのロックが干渉しないか） | なし | §4.1 の `AuthLockPort` |

- S-M1・S-M5 で作ったものは**必ず削除する**（S-M5 は会計帳簿に残ると決算に影響する）
- 結果は未決事項 §6 に追記する

### 11.2 作業パッケージと受入条件 🔄

| WP | 内容 | 受入条件 |
|---|---|---|
| **WP-M1** 基盤 | §4 のポート・アダプタ・クライアント・エラー・lease・フラグ、`scripts/mf-oauth-authorize.mjs`、`mfInvoicePing`/`mfAccountingPing` | フェイク HTTP で: 401 → 更新 → 再試行、**別の実行が更新済み（generation が違う）なら更新しない**、同時に 2 つの 401、`invalid_grant` → `MfReauthRequiredError`、**保存後の読み直しが一致しない → 再保存 → それでも駄目なら `MfReauthRequiredError`**、429 の `Retry-After` ≤10 秒で 1 回待ち >10 秒で `MfTransientError`、**作成系 POST の 5xx・タイムアウト → `MfOutcomeUnknownError`**、会計の 350ms 間隔、JWT のキャッシュと 401 での再交換、`/accessible_offices` に `office_code` を付けない、**トークン・API キーがログ・例外メッセージに出ない**、**全フラグ無効で HTTP 0 件** |
| **WP-M2** 締め | §5.1〜§5.3・§5.8（状態機械、`isMonthFrozen` への置換、列指定の更新、`trigMonthly` のロック化、`evaluateMonthClose`、カード、`month_close`、`validateRequest`、Worker の締めボタン、遅延打刻の通知） | 状態遷移表の全セル、`MF_BILLING_START_MONTH` より前は何もしない、**締め忘れた過去月も評価する**、**集計が状態列を書かない（締めと集計が交互に動いても `LOCKED` が戻らない）**、古いカード（金額変更・`close_card_ts` 不一致）からの押下で締めない、要修正があれば `OPEN` に戻る、`MF_CREATED` 後の月に訂正が通らない（**回帰テスト**）、無効時は `MANUAL`、**署名付きの `month_close` が Worker → GAS の実際の検証を通る**（契約テストベクタに追加）、**旧 Worker の `expense_submit`（`payment_method` なし）の再送を受け付ける** |
| **WP-M3** 請求書 | §5.4〜§5.7（組み立て、支払期日、日別明細、`ensureInvoiceCreated`、照合、追跡、`trigMfSync`/`trigMfSyncSoon`） | 支払期日（11 月分の 12/31、土日・祝日）、`note` の 2000 字切り詰め、**ID 保存前に落ちた場合に検索で回収して二重作成しない**、**POST の結果不明で `UNKNOWN` になり作り直さない**、`UNKNOWN` の 24 時間後の依頼、lease 取得中は作らない、`MANUAL` の月を作らない、金額不一致（源泉 0 を含む）、ステータスの両表記（`"2"` を含む）、`SENT`/`PAID` の遷移、`trigMfSyncSoon` が自分を消す |
| **WP-M4** ② 現金 | §6.1〜§6.4・§6.7・§6.8、`/keihi` の支払方法（Worker・shared・GAS） | 台帳 V3 への移行（既存 24 列の値が動かない）、**登録中（`FILE_SAVED`）の行を待って後で同期する**、支払方法を後から記入した行が対象になる、割合 100 未満は `NEEDS_REVIEW`、科目解決の失敗で止まる、tags による回収、**「作成成功 → 応答喪失」「作成成功 → シート保存失敗」「その間に取消」の 3 経路**、手入力の `MF仕訳ID` を取り込み作らない、作成後の業務列の変更を検出、**同期が業務列を書かない**、4 分で打ち切って続きから再開、ロック外で MF を呼ぶ（フェイクの LockPort で検証） |
| **WP-M5** ③ 照合 | §6.5・§6.6 | `matchTransactions` の表駆動テスト（候補 0／1／複数、**支払方法と連携サービスの対応**、**取り合い（2 行が同じ明細を候補にする）**、**バッチ外の行との取り合い**、**明細ルール（card/bank/any の対象、金額条件、上から順に最初の一致、空文字列のルールを無視、私用ルールと経費候補が重なったら仕訳しない）**、使用中・手放した明細）、ルールによる私用仕訳の回収（未仕訳のままなら送り直す）、`JOURNALIZING` の回収（見つかる／未仕訳のまま／仕訳済みなのに見つからない）、訂正行が旧行の `REVERSED` を待つ、人が記入した明細 ID の検証、14 日の未照合通知が 1 回だけ、366 日の分割、週次報告の 3 種 |

- 各 WP の後に Codex レビュー（`codex exec` を独立実行して突き合わせ）を通す
- **WP-M1〜M3 は 10/31 までに本番へ**。WP-M4・M5 はスパイク S-M3〜S-M5 の結果を待ってから着手する

### 11.3 11/1 に間に合わなかった場合（ドライラン）

- `MF_INVOICE_ENABLED` を無効のままにすれば、締め確認カードと `[締める]` だけが動き、**MF は呼ばない**。その月は `MANUAL` になる。
  請求書は runbook 02 の手順で手動転記する（MVP と同じ）
- WP-M2 だけ先に本番へ出しておけば、11/1 の締めは確実に回る。WP-M3 は 12/1（11 月分）から有効にしてもよい。
  **有効にした後も、`MANUAL` の月は作り直さない**（§5.1）

### 11.4 カード利用明細の保存（runbook に追加）

毎月、カード会社の利用明細（PDF 等）をダウンロードし、Drive の `経費証憑/電子取引/カード明細/YYYY/MM/` に保存する。
**`/keihi` では登録しない**（§2.2）。
**MF の連携明細では代えられない**（連携の解除・退会で明細が削除される。未決事項 §6.14 の追加調査）。

### 11.5 再認可の手順（runbook 02 に追加）🔄

1. Slack に「MF の再認可が必要です」が届く
2. `MF_INVOICE_ENABLED` を `false` にする（再認可の途中で更新が走らないようにする）
3. ローカルで `MF_CLIENT_ID=… MF_CLIENT_SECRET=… node scripts/mf-oauth-authorize.mjs` を実行し、ブラウザで承認する
4. 表示された JSON 1 行を Script Property `MF_INVOICE_TOKENS` に貼る（`refreshed_at`・`generation` も入っている）
5. GAS エディタで `mfInvoicePing` を実行して疎通を確認し、`MF_INVOICE_ENABLED` を `true` に戻す

### 11.6 請求書を作り直す場合（runbook 02 に追加）🔄

1. `MF_INVOICE_ENABLED` を `false` にする
2. MF 側で請求書を削除する
3. 月次請求シートで `mf_invoice_id` を空に、`invoice_state` を空に、`state` を `REVIEWING` に、`close_card_ts` を空にする
4. `MF_INVOICE_ENABLED` を `true` に戻す。次の `trigMfSync` で新しい締め確認カードが出る（古いカードのボタンは §5.3 で弾かれる）

### 11.7 ロールバック

- **`MF_ENABLED` を `false` にすれば、MF の呼び出しはすべて止まる**。コードを戻す必要は無い
- 経費台帳・月次請求の追加列は残してよい（旧コードは既存の列までしか読まない）

---

## 12. 要件定義 v1.1 からの差分（実装上の決定）

| # | 項目 | 決定 | 理由 |
|---|---|---|---|
| M1 | 状態機械の `APPROVED` | **削除**。請求書作成の進み具合は別の列（`invoice_state`）で持つ | 送付判断は MF 画面で人が行い、kadobo は結果（送付済み）しか観測できない。MF の失敗で締めが戻らないようにする |
| M2 | 日別明細の PDF 添付（§4.4.2-4） | **`note` にテキストで埋め込む**。PDF は作らない | API に添付口が無い。`note` 2000 字に 1 か月分が収まる |
| M3 | OAuth ライブラリ（§4.4.1「GAS 用 OAuth2 ライブラリ」） | **使わない**。初回認可はローカルスクリプト、更新は自前実装 | 更新ロジックはどちらでも自前で書く。ライブラリは期限ベースの先読み更新で 401 駆動の方針と合わず、フェイクでのテストもしにくい |
| M4 | 経費の `MF仕訳ID`（§4.3.2「月次で人手記入」） | **kadobo が書く**（人の記入も引き続き可） | 会計 API（2026-03-26 提供開始）で仕訳を作れるようになった |
| M5 | 月次合算仕訳の可否（§7 #10 の残り） | **論点から外れる**。1 経費 1 仕訳で登録する | 合算しないので、可否を確かめる必要が無くなった |
| M6 | 会計 API の認証 | **API キー** | §2.1 |
| M7 | 証憑の MF アップロード | **しない** | §2.2 |
| M8 | 🔄 トークンの原子的保存（§4.4.1「LockService 下で原子的に Script Properties へ保存」） | **1 キーの JSON**。更新の直列化は**ユーザーロック** | 複数キーの書込みは原子的と保証されない。スクリプトロックで HTTP を待つと打刻を巻き込む |

---

## 13. 未決事項

| # | 内容 | 期限 |
|---|---|---|
| U1 | A社の取引先・部署の登録（`MF_DEPARTMENT_ID`） | **2026-10-01**（利用者） |
| U2 | カード・口座の MF 連携（`MF_CARD_ACCOUNT_IDS`・`MF_BANK_ACCOUNT_IDS`） | WP-M5 着手前（利用者） |
| U3 | スパイク S-M1〜S-M6 の実施 | S-M3・S-M6 はすぐ、S-M1・S-M2 は 10/1 以降、S-M4・S-M5 は U2 の後 |
| U4 | 取引先が増えた場合の `billing_number` の形式 | 取引先が 2 社目になったとき |
| U5 | 請求書 → 会計の標準連携（売掛金の仕訳）の設定手順（要件定義 §7 #3 の残り） | 11/1 の前（利用者が MF 画面で設定） |
| U6 | 🔄 `MF明細ルール` への NISA（カード・口座）とカード引落しの登録と、1 か月分の残高照合（カード・口座それぞれ） | WP-M5 の本番有効化の前（利用者） |
