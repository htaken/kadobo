# Codex レビュー: MF 連携 WP-M1〜M4 コード（2026-10-08）

対象: `de5ab19..a02052e`（45 ファイル、約 5,900 行）
実行: `codex exec --skip-git-repo-check -s read-only -m gpt-6.1-sol -c model_reasoning_effort=medium` / codex-cli 0.160.1 / tokens 159,351

---

## 1. 総評

**このままの本番デプロイは推奨しません。Blocker が2件あります。**

既存打刻・旧 Worker の経費再送との互換は概ね維持されています。一方、月次更新が実際には行全体を書き戻す問題と、同期中の業務列変更を再検証せず誤った仕訳を作る問題を確認しました。

対象は `de5ab19..a02052e`。静的レビューに加え、既存コード・フェイクをメモリ上で動かして故障経路を確認しました。**1083件のテスト成功は提示情報であり、一式は再実行していません。ファイル変更はありません。**

## 2. Blocker（デプロイ前に必ず直す）

### B1. 月次の「列指定更新」が18列全体を書き戻している

**箇所:** [gas/src/adapters/sheets.ts:952](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:952)

- **事実:** `updateMonthlyBillColumns` は既存行と patch をマージし、960行目で18列全体を `setFormattedRow` に渡しています。数値だけの再集計でも、`state`・`invoice_state`・MF ID・カード ts を書き戻します。設計 §0・§8、WP-M2 の受入条件に反します。
- **再現:** 実アダプタ＋シートフェイクで、読み取り後に人手編集相当の `LOCKED/PENDING` を挿入すると、数値更新が `REVIEWING/空` に戻しました。書き込み範囲は `[2,1,1,18]` でした。
- **影響:** 人の締め状態・請求書IDの編集が失われ、締め解除や再作成につながり得ます。スクリプトロックは人のシート編集を直列化しません。
- **修正案:** 月次列の対応表を設け、patch に含まれるセルだけを書いてください。
- **テストの穴:** [gas/test/adapters/sheets.test.ts:1037](/Users/takenouchiharuhi/projects/kadobo/gas/test/adapters/sheets.test.ts:1037) は最終値だけを確認しています。「触れていない」を検証するには、実際の書き込み範囲と、読み取り後の編集を検査する必要があります。

### B2. POST前の再読込で、同期対象条件・入力の一致を確認していない

**箇所:** [gas/src/app/journalSync.ts:568](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:568)、[同:591](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:591)、[同:604](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:604)

- **事実:** 科目解決・タグ検索は旧スナップショットで行います。その後の guard は `PENDING/COMPLETED/IDなし` だけです。支払方法・割合・金額・日付・カテゴリの一致を確認せず、本文は再読込した行、借方科目と入力要約は旧行から組み立てます。
- **再現:** タグ検索中に「消耗品費・cash・100%」を「通信費・linked_card・50%」へ変更しても、**消耗品費／事業主借の仕訳を作成し、SYNCED にしました**。
- **影響:** 家事按分で自動作成しない方針や、連携カードを現金仕訳にしない方針を破ります。次回の変更検出が働いても、誤仕訳は既にMFに存在します。
- **修正案:** 再読込時に対象条件を再評価し、科目解決・検索に使った入力と一致する場合だけ `CREATING` へ進めてください。変わっていれば、その実行のPOSTを中止して再評価します。本文・科目・保存する入力要約は同じスナップショットから生成してください。

## 3. Major

### M1. 日付を変更すると、作成済み仕訳の回収・取消ができない

**箇所:** [gas/src/app/journalSync.ts:319](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:319)

- **事実:** 回収検索は現在の `row.date` に限定され、作成時の `mf_sync_input` に残る日付を使いません。
- **再現:** 10/5の仕訳作成後に応答を失い、台帳の日付を10/6へ変更して取消すると、仕訳はMFに残り、台帳は `UNKNOWN` になりました。
- **修正案:** 作成時の日付を不変の回収キーとして使用してください。現在日付と異なる場合は作成時日付で回収し、変更検出・取消へ進めます。保存情報が欠落した場合の検索範囲も定義してください。

### M2. セル単位の途中書き込み失敗で、CREATING が無期限に残る

**箇所:** [gas/src/adapters/sheets.ts:1047](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:1047)、[gas/src/app/journalSync.ts:593](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:593)、[同:331](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:331)

- **事実:** アダプタはセルごとに書きます。作成前の patch は状態を先に書き、その後に試行時刻・入力要約を書きます。
- **再現:** 状態だけ保存した後に失敗させると、POSTされていないのに `CREATING/試行時刻なし` が残りました。2日後も `UNKNOWN` へ進まず、通知も出ません。
- **修正案:** 必要情報を先に保存し、状態を最後に確定してください。可能な範囲で書き込みをまとめ、メタデータが欠けた `CREATING` の復旧・通知も実装してください。
- **テストの穴:** [gas/test/app/fakes.ts:166](/Users/takenouchiharuhi/projects/kadobo/gas/test/app/fakes.ts:166) の故障注入は全更新前に失敗する方式で、実アダプタの途中成功を再現しません。

### M3. 未解決の先頭20行が、後続の回収・取消・新規作成を塞ぐ

**箇所:** [gas/src/app/journalSync.ts:384](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:384)

- **事実:** 毎回先頭から `CREATING/UNKNOWN` を走査し、同じ共通予算を消費します。継続カーソルはありません。
- **再現:** 未解決の `UNKNOWN` 20件＋新規1件で3回同期しても、新規行は `PENDING` のままで、作成件数は0でした。後続の `REVERSING` も同様に到達できません。
- **修正案:** 継続カーソルまたは公平な巡回順を保存し、回収・取消・新規に予算を配分してください。
- **テストの穴:** [gas/test/app/journalSync.test.ts:890](/Users/takenouchiharuhi/projects/kadobo/gas/test/app/journalSync.test.ts:890) は成功行が対象から抜ける場合だけを検証しています。

### M4. 4分の予算が、トリガー全体を保護していない

**箇所:** [gas/src/app/triggers.ts:204](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/triggers.ts:204)、[gas/src/app/journalSync.ts:685](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:685)、[同:224](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:224)

- **事実:** 経費の計時は、締め評価・請求書作成・追跡が終わった後に始まります。請求書処理には共通期限がなく、仕訳検索の最大50ページの途中にも時間確認がありません。
- **リスク:** 前段で時間を使った実行や、ページ取得・再試行が長引く実行では、6分を超えて強制終了し得ます。これは実機での超過再現ではなく、制御範囲からの判断です。
- **修正案:** トリガー開始時の絶対期限を全処理へ渡し、行・ページ・再試行開始前に確認してください。90分/日の予算についても、障害時を含む実測が必要です。

### M5. 請求書の連続障害通知が発火しない

**箇所:** [gas/src/app/triggers.ts:183](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/triggers.ts:183)、[同:211](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/triggers.ts:211)

- **事実:** 3ステップが同じ `invoice` カウンタを共有し、それぞれ成功扱いでリセットします。HTTPを呼ばない `warnMismatchDaily` の正常終了でもリセットされます。
- **再現:** 請求書検索を6回連続500にしても、最終カウンタは0、障害DMは0件でした。
- **修正案:** 実行全体の結果を集約して1回だけ通知判定するか、ステップ別カウンタにしてください。未実行・対象なしをAPI成功として扱わないことも必要です。

### M6. トークン保存が例外を投げる経路は、再認可エラーにならない

**箇所:** [gas/src/app/mf/invoiceClient.ts:161](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/mf/invoiceClient.ts:161)

- **事実:** 読み直し不一致には対処していますが、保存・検証読込自体の例外は捕捉していません。
- **再現:** 更新成功後の保存失敗は、汎用 `Error` のまま伝播しました。`notifyMfFailure` の再認可通知対象になりません。
- **影響:** ローテーション済みの新トークンを失った際、その実行で再認可が必要だと通知できません。
- **修正案:** 更新後の保存・検証を囲み、回復不能なら固定メッセージの `MfReauthRequiredError` に変換してください。例外を投げるストアのテストを追加します。

### M7. 請求書のUNKNOWN回収まで個別フラグで停止する

**箇所:** [gas/src/app/invoice.ts:474](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/invoice.ts:474)

- **事実:** `MF_INVOICE_ENABLED=false` なら、`UNKNOWN` の検索回収も行いません。`MF_ENABLED=true` のままでもHTTPは0件でした。
- **契約との相違:** §9は、回収を個別フラグにかかわらず継続すると規定しています。
- **修正案:** 新規作成の許可と回収の許可を分けてください。全体フラグだけが有効な場合は検索・既存IDの回収だけを行い、POSTは行わない構成にします。

## 4. Minor

### OAuthのエラー応答をstate検証より先に受理している

**箇所:** [scripts/mf-oauth-authorize.mjs:131](/Users/takenouchiharuhi/projects/kadobo/scripts/mf-oauth-authorize.mjs:131)

`error` があると state を確認せず終了し、`error_description` をHTMLへ直接埋め込みます。成功経路のstate検証・PKCEは実装されていますが、エラー経路には適用されません。

**修正案:** エラー経路でも先にstateを確認し、HTMLへ出す値をエスケープしてください。92行目のトークン交換エラーも、応答本文全体ではなく許可した項目だけを表示する方が秘密情報非出力の契約を守りやすくなります。現状の秘密漏えいを実機で確認した指摘ではありません。

## 5. 良い点

- `payment_method` はGAS側で任意になっており、旧 Worker のpending再送を受け付ける構成です。
- 経費の重いI/Oをdispatchの外側ロックに戻しておらず、MF呼び出しもスクリプトロック外です。確認した自動処理で、新たな入れ子ロックは見つかりませんでした。
- `isMonthFrozen` を集計・訂正で共有し、`MF_CREATED/SENT/PAID` 後の訂正を防いでいます。
- 移行は既存列の位置を維持し、既存システム列の保護・非表示も維持する構成です。
- 会計IDの1回エンコード、存在しないIDの400判定、`tax_id/invoice_kind` 省略は訂正後の実測記録と一致しています。フェイクに、この点で実機と逆の前提は見つかりませんでした。
- 作成POSTの通信失敗・5xxを結果不明として扱い、検索回収へ回す基本方針は適切です。

## 6. 確認できなかった点

- 実GASでのユーザーロックとスクリプトロックの独立性、更新中の並行実行、保存障害時の実挙動。
- 本番データ量での `trigMonthly` のロック保持時間、MF同期の6分制限・90分/日の余裕。
- 本番シートの移行前ヘッダー・追加予定列の利用状況・既存保護範囲。
- MF画面URL、Slackカード、実際の送付・入金操作後の追跡表示。
- `journalize` と削除後の連携明細の挙動。これは未実施スパイクかつWP-M5の範囲として扱い、今回の未実装不具合には数えていません。
- 同梱OpenAPI写しと現在のサービスとの差異。今回の仕様照合は、同梱定義と提示された実測記録を基準にしています。
