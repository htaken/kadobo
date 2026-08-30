## 対応状況（2026-08-28 追記）

本文の指摘はすべてコード側で解消済み。

**「推奨コード修正」の 3 点**（先行対応済み）

| 指摘 | 対応 |
|---|---|
| `preferredMessageTs` を追加し stamp/correction で `req.message_ts` を使う | `gas/src/app/cardHelpers.ts` の `redrawCardForBusinessDate(..., {preferredMessageTs})`。stamp/correction/重複/不正遷移の全経路で `req.message_ts` を渡す |
| 更新成功後に内部 card ts を自己修復 | `pushCard()`: `chat.update` 成功時に `storedTs !== target` なら内部シートを上書き |
| 保存 ts が `message_not_found` なら再投稿 | `pushCard()`: `message_not_found`/`cant_update_message` で `chat.postMessage` にフォールバックし内部 ts を張り替え |

**「その他の潜在不具合」**

| 指摘 | 対応 |
|---|---|
| 生ログ追記後に再計算が失敗すると、再送時に再計算されない | `handleStamp` / `handleCorrectionSubmit` の重複（`DUPLICATE`）分岐で `recomputeDailyAndMonthly()` を必ず呼ぶようにした。回帰テスト: 「生ログ追記後・再計算前に落ちた再送でも、重複分岐で日次・月次を計算し直す」 |
| Worker の 20 秒 timeout と GAS の 20 秒 Lock 待機が同値 | `GAS_LOCK_WAIT_MS = 10000`（新設、`shared/src/protocol.ts`）を `LockAdapter` が使う。`GAS_TIMEOUT_MS` は 20000 → 25000。差が 10 秒以上あることを `shared/test/protocol.test.ts` で固定 |
| timeout 時に Worker が古い blocks で GAS の成功描画を上書きし得る | Worker は「GAS がカードに触れていないと確定できる」場合のみ上書きする（`isCardSafeToOverwrite()`）。判定は `rejected`（終局・未適用宣言）と `isGasPreApplyError()`（`UNAUTHORIZED`/`BAD_REQUEST`/`MALFORMED_BODY`/`LOCK_TIMEOUT`）のみ。timeout・ネットワーク断・HTTP エラー・GAS の総括 catch はカードを ⏳ のまま残し、本人へ ephemeral で知らせて Cron 再送に任せる |
| ⏳ 表示中も actions が残り再押下できる | `withStatusBlock(..., {removeActions:true})` で ⏳ 中は `actions` を除去。ボタンは GAS の再描画、または上書き可判定が真のときの ⚠️ 表示（押下時 blocks を復元）で戻る |
| 進行中カードが「本日累計 ⚠️ 要修正」と表示される | 先行対応済み。`daily.status` を `ok`/`in_progress`/`needs_fix` に写像し、進行中は `本日累計 Xh Ym（計測中）` |

---

## 結論

最有力の根本原因は、**対策前に数値化・桁落ちした「内部」シートのカード ts が、対策適用後も修復されず残っていること**です。そこに、**GAS が `chat.update` 失敗を握りつぶして `ok:true` を返す設計**が重なり、D1 は `done` なのにカードだけ⏳のままになります。報告された症状とコードの挙動が完全に一致します。

具体的には次の流れです。

1. Worker は Slack payload 内の正確な `message.ts` を使うため、⏳への更新に成功する。
2. GAS は Workerから正確な `message_ts` を受け取っているが、それを使わない。
3. GAS は「内部」シートのカード ts を読み、桁落ちした古い値で `chat.update` する。
4. Slack は `message_not_found` を返す。
5. GAS はその例外を握りつぶし、最終的に `{ok:true, applied:true}` を返す。
6. Worker は `ok:true` を無条件に D1 `done` に変換し、以後再試行しない。

`setupSpreadsheet()` の text 書式適用は、今後の書き込みを守るだけです。**すでに数値化されて失われた末尾桁は復元しません**。

### 直ちに必要な復旧

「内部」シートの対象行を確認してください。

- `kind = card`
- `key = <channel_id>:<business_date>`
- `value = Slack message ts`

D1 の当該 journal の `payload.message_ts` と `value` を文字列として完全一致比較します。

- 例: D1 は `1787820585.021000`
- 内部シートが `1787820585.021`

なら確定です。

復旧方法は次のどちらかです。

- 内部シートの `value` セルをプレーンテキスト書式にして、D1 の `message_ts` を完全な文字列で上書きし、`/kado refresh`。
- 対象の `card` 行全体を削除して `/kado` を再実行し、新しいカードを投稿・登録する。値だけ空にすると `"" !== null` のため空 ts で更新し続けるので、行全体の削除が必要です。

## 実行経路の根拠

### 1. Worker の⏳更新は正確な ts を使っている

Worker は Slack payload の `message.ts` をそのまま GAS request に格納しています。

- [`worker/src/handlers/stamp.ts:47`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:47)
- [`worker/src/handlers/stamp.ts:55`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:55)

⏳更新も同じ payload の ts を直接使用しています。

- [`worker/src/handlers/stamp.ts:98`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:98)
- [`worker/src/handlers/stamp.ts:100`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:100)

この更新が実機で成功しているため、少なくとも以下は正しいと判断できます。

- 押されたカードの channel/ts
- Worker の Slack token
- payload 由来の元 blocks
- Worker→Slack の `chat.update`

その後に、同じ処理内で順番に GAS を呼んでいます。通常の単一リクエスト内では GAS 更新が⏳更新より先に走る競合はありません。

- [`worker/src/handlers/stamp.ts:109`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:109)
- [`worker/src/handlers/stamp.ts:115`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:115)

### 2. GAS の状態再計算自体は START から WORKING を生成する

GAS は重複判定、業務日解決、当日の生ログ再生、遷移検証を行い、START を追記します。

- [`gas/src/app/stamp.ts:35`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:35)
- [`gas/src/app/stamp.ts:47`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:47)
- [`gas/src/app/stamp.ts:55`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:55)
- [`gas/src/app/stamp.ts:90`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:90)

状態機械では `IDLE + START = WORKING` です。

- [`gas/src/core/state.ts:36`](/Users/takenouchiharuhi/projects/kadobo/gas/src/core/state.ts:36)
- [`gas/src/core/state.ts:77`](/Users/takenouchiharuhi/projects/kadobo/gas/src/core/state.ts:77)

カード生成も WORKING なら `[休憩][終了][✏️修正]` を確実に生成します。

- [`gas/src/core/card.ts:78`](/Users/takenouchiharuhi/projects/kadobo/gas/src/core/card.ts:78)
- [`gas/src/core/card.ts:82`](/Users/takenouchiharuhi/projects/kadobo/gas/src/core/card.ts:82)

したがって、START が生ログにありながら表示が⏳のままという症状は、通常の状態誤判定だけでは説明できません。状態が誤って IDLE になったとしても、`chat.update` が成功すれば少なくとも⏳は✅などに置き換わります。**⏳が完全に残るのは、GAS の更新が反映されなかった証拠です。**

### 3. GAS は正確な `req.message_ts` を捨て、内部シートの ts を使う

GAS request は `message_ts` を型検証までしています。

- [`gas/src/app/validateRequest.ts:33`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/validateRequest.ts:33)
- [`gas/src/app/validateRequest.ts:38`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/validateRequest.ts:38)

しかし `handleStamp()` からカード再描画を呼ぶ際、この値を渡していません。

- [`gas/src/app/stamp.ts:92`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:92)

実際の更新先は内部シートから取得します。

- [`gas/src/app/cardHelpers.ts:71`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/cardHelpers.ts:71)
- [`gas/src/app/cardHelpers.ts:78`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/cardHelpers.ts:78)
- [`gas/src/app/cardHelpers.ts:81`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/cardHelpers.ts:81)

つまり正確な「いま押されたカードの ts」が Worker から届いているのに、GAS は壊れ得るキャッシュ値を優先しています。

### 4. text 書式の後付けは既存の桁落ちを修復しない

`setupSpreadsheet()` は既存行に `setNumberFormat("@")` を適用するだけです。

- [`gas/src/adapters/sheets.ts:156`](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:156)
- [`gas/src/adapters/sheets.ts:185`](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:185)

一方、読み取りはセルの現在値を単に `String()` 化します。

- [`gas/src/adapters/sheets.ts:208`](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:208)
- [`gas/src/adapters/sheets.ts:541`](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:541)

すでに `1787820585.021000` が数値 `1787820585.021` になっていれば、元の末尾ゼロは情報として失われています。

リポジトリ内の回帰テスト自身も、実機でこの変換から `message_not_found` になったことを明記しています。

- [`gas/test/adapters/sheets.test.ts:4`](/Users/takenouchiharuhi/projects/kadobo/gas/test/adapters/sheets.test.ts:4)
- [`gas/test/adapters/sheets.test.ts:77`](/Users/takenouchiharuhi/projects/kadobo/gas/test/adapters/sheets.test.ts:77)

現在のテストは「修正後に新しく書いた ts が保存できる」ことしか検証しておらず、既存の破損 ts の移行・自己修復はテストしていません。

- [`gas/test/adapters/sheets.test.ts:90`](/Users/takenouchiharuhi/projects/kadobo/gas/test/adapters/sheets.test.ts:90)
- [`gas/test/adapters/sheets.test.ts:118`](/Users/takenouchiharuhi/projects/kadobo/gas/test/adapters/sheets.test.ts:118)

### 5. Slack エラーが `ok:true` に変換される

Slack adapter 自体は `ok:false` を正しく例外化します。

- [`gas/src/adapters/slack.ts:27`](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/slack.ts:27)
- [`gas/src/adapters/slack.ts:33`](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/slack.ts:33)
- [`gas/src/adapters/slack.ts:70`](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/slack.ts:70)

しかしカード再描画全体が catch で囲まれ、例外を呼び出し側へ返しません。

- [`gas/src/app/cardHelpers.ts:44`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/cardHelpers.ts:44)
- [`gas/src/app/cardHelpers.ts:64`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/cardHelpers.ts:64)

その結果、`handleStamp()` は無条件で成功を返します。

- [`gas/src/app/stamp.ts:94`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:94)
- [`gas/src/app/stamp.ts:96`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:96)

Worker は `ok:true` なら `applied` やカード更新成否を見ずに `done` とします。

- [`worker/src/gas.ts:87`](/Users/takenouchiharuhi/projects/kadobo/worker/src/gas.ts:87)
- [`worker/src/gas.ts:90`](/Users/takenouchiharuhi/projects/kadobo/worker/src/gas.ts:90)
- [`worker/src/handlers/stamp.ts:115`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:115)

これが「GAS は ok:true、D1 は done、カードは⏳」の直接理由です。

## 根本原因候補のランキング

### 1. 既存の内部 card ts が対策前に桁落ちし、未移行のまま

確度: 非常に高い。

今回の症状に最も一致します。書式対策を適用しても既存値は戻らず、正常な値で上書きされる経路もありません。`pushCard()` は既存 ts があれば更新して即 return し、`setInternalValue()` を呼ばないからです。

具体的修正:

- 既存 card 行のデータ移行または再作成。
- stamp 時は内部値ではなく `req.message_ts` を優先する。
- 更新成功後に内部値を `req.message_ts` で upsertし、自己修復させる。

### 2. 内部シートが別の有効なカード ts を指し、押されたカードとは別のカードを更新している

確度: 中～高。

ts が桁落ちしていなくても、重複カードや古いカードが存在すると発生します。GAS は `req.message_ts` を無視するため、Worker は押されたカードを⏳にし、GAS は内部シートが指す別カードをWORKINGにします。

D1 `payload.message_ts` と内部 `value` が別の完全な6桁tsなら、このケースです。

具体的修正:

- stamp/correction の再描画では必ず request の `message_ts` を使用する。
- 更新成功時にその ts を内部シートへ再登録する。
- 内部シートの `kind + key` 重複も検出・整理する。

### 3. GAS側固有の Slack API エラー

確度: 低～中。

GAS token の不一致、`message_not_found`、`cant_update_message`、`invalid_blocks` 等はすべて同じ catch に入り、同じ `ok:true` になります。ただし、Worker の⏳更新が成功し、`/kado` の投稿も同じGAS tokenで本当に新規成功しているなら、token・権限・blocksの可能性は相対的に低いです。

GAS実行ログの `redrawCard failed: slack_api_error:chat.update:<error>` を確認すれば即座に特定できます。

### 4. 状態読み戻しまたは通常の同一リクエスト内更新競合

確度: 低い。

START の状態遷移・WORKING blocks生成はコード上正しいです。またWorkerは⏳更新を await した後にGASを呼ぶため、通常の一押下ではWorkerの⏳がGAS更新より後に走る構造ではありません。

## 推奨コード修正

最重要なのは次の3点です。

1. `redrawCardForBusinessDate()` に `preferredMessageTs` を追加し、stamp/correctionでは `req.message_ts` を使う。
2. 更新成功後に内部 card ts をその値で上書きし、壊れたレジストリを自己修復する。
3. 再描画結果を握りつぶさず呼び出し側へ返す。

生ログ追記後にカード更新が失敗した場合は、既存の冪等性を利用して `{ok:false, error:"CARD_UPDATE_FAILED", retryable:true}` とするのが実装しやすいです。Cron 再送では生ログ重複を検出して追記せず、再描画だけ再試行できます。

併せて、保存 ts で `message_not_found` が返った場合は、

- stampなら `req.message_ts` で再試行
- command/triggerなら新規 `chat.postMessage` して内部値を置換

という自己修復を入れるべきです。

## その他の潜在不具合

- **生ログ追記後に日次・月次再計算が失敗すると、再送時に再計算されない。**  
  初回は追記後の [`gas/src/app/stamp.ts:93`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:93) で失敗してpendingになりますが、再送時の重複分岐はカード再描画だけで成功を返します（[`gas/src/app/stamp.ts:35`](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:35)）。日次・月次が欠落したままD1がdoneになります。重複分岐でも再計算が必要です。訂正処理にも同じ問題があります。

- **Workerの20秒timeoutとGASの20秒Lock待機が同値。**  
  Worker timeoutは [`shared/src/protocol.ts:15`](/Users/takenouchiharuhi/projects/kadobo/shared/src/protocol.ts:15)、GAS lock待機は [`gas/src/adapters/lock.ts:7`](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/lock.ts:7) です。ロックを待ったリクエストは、その後のSheets/Slack処理を含めるとWorker側でほぼ確実にtimeoutします。Lock待機を短くするか、Worker timeoutを「Lock最大待機＋処理時間」より長くする必要があります。

- **timeout時にWorkerが古いblocksでGASの成功描画を上書きできる。**  
  Workerの⚠️表示は押下時の `payload.message.blocks` を再利用します（[`worker/src/handlers/stamp.ts:126`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:126)）。GASが実際には記録・描画を完了したもののWorkerへの応答だけtimeoutした場合、Workerの⚠️更新が後勝ちして古い状態へ戻す可能性があります。

- **⏳表示中も元のactionsを残すため、再押下できる。**  
  `withStatusBlock()` はstatusしか除去せず、actionsをそのまま残します（[`worker/src/handlers/stamp.ts:29`](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/stamp.ts:29)）。処理中はactionsブロックを外す方が安全です。

- **正常な進行中カードが「本日累計 ⚠️ 要修正」と表示される。**  
  進行中は `worked_seconds=null`（[`gas/src/core/aggregate.ts:192`](/Users/takenouchiharuhi/projects/kadobo/gas/src/core/aggregate.ts:192)）で、カード側はnullを無条件に要修正表示へ変換します（[`gas/src/core/card.ts:167`](/Users/takenouchiharuhi/projects/kadobo/gas/src/core/card.ts:167)）。WORKING/ON_BREAKと要修正を区別する必要があります。

なおコード変更はしていません。Vitestも試行しましたが、現在のread-only環境では Vitest が `gas/node_modules/.vite-temp` を作成できず、起動前にEPERMとなりました。静的経路と既存テストコードによる結論です。
