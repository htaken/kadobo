# Codex レビュー: MF 連携 WP-M5 コード（2026-10-08）

対象: `0a72905..6bdf6ec`
実行: `codex exec --skip-git-repo-check -s read-only -m gpt-6.1-sol -c model_reasoning_effort=medium` / codex-cli 0.160.1 / tokens 116,502

---

## 1. 総評

**このままの本番デプロイは推奨しません。Blocker 2 件があります。** いずれも MF の仕訳を誤って変更・削除する経路です。

対象は `0a72905..6bdf6ec`。指定差分には Worker・shared・dispatch・validateRequest・stamp・monthly・correction の変更はなく、打刻・旧 Worker の `/keihi` 再送に対する直接的な互換性破壊は見つかりませんでした。ただし、既存本番で `MF_ENABLED=true` の場合、今回の取消処理は **`MF_MATCH_ENABLED=false` でも動く**ため、照合フラグを無効にするだけでは以下の Blocker を隔離できません。

以下は静的確認に基づきます。B1 の純関数の分岐は、ファイルを書き換えず実行して確認しました。

## 2. Blocker（デプロイ前に必ず直す）

### B1. 引継ぎのセル書込みが途中で失敗すると、次回に経費仕訳を私用へ変更する

**箇所:** [gas/src/core/journalSync.ts:1018](/Users/takenouchiharuhi/projects/kadobo/gas/src/core/journalSync.ts:1018)、[gas/src/app/journalSync.ts:655](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:655)、[gas/src/adapters/sheets.ts:1130](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:1130)

**事実:** 引継ぎは MF の PUT 後、新行へセル単位で書き込みます。`mf_journal_id` が最初、`mf_sync_state` が最後です。一方、引継ぎ済みの判定は「同じ仕訳 ID **かつ SYNCED**」に限定されています。

次の障害経路があります。

1. PUT が成功し、仕訳が新行の経費内容になる。
2. 新行の `mf_journal_id` 保存後、後続セルの書込みが失敗する。
3. 新行は仕訳 ID を持つが、状態は空または `WAITING_TRANSACTION`。
4. 次回、旧行を先に処理すると、`done` にも `inherit` にも該当せず **`void`** を選ぶ。
5. 同じ仕訳を `事業主貸` に変更する。後続の新行取り込みは存在確認で `SYNCED` にできるため、台帳と MF の科目が食い違う。

純関数実行でも、正常時は `inherit`、新行に仕訳 ID だけ保存した状態では `void` になることを確認しました。

**修正案:** 同じ仕訳 ID を持つ子孫行が未確定なら、取消へ落とさず「引継ぎ復旧」に進める。MF の内容と新行を照合し、必要な PUT と不足セルの保存を完了してから旧行を `REVERSED` にしてください。

**テストの穴:** [gas/test/app/journalMatch.test.ts:1154](/Users/takenouchiharuhi/projects/kadobo/gas/test/app/journalMatch.test.ts:1154) は新行が完全に `SYNCED` になった後の旧行書込み失敗だけを検証しています。新行の各セル保存後に失敗するケースが必要です。

### B2. PUT／DELETE を現在の支払方法で選ぶため、連携仕訳を DELETE できてしまう

**箇所:** [gas/src/app/journalSync.ts:513](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:513)

**事実:** 取消方法は `serviceKindOf(row.payment_method)` で選ばれ、作成時の入力要約や明細 ID を見ません。

**帰結:** 連携明細から作成済みの行について、人が支払方法を `cash` に変更して同時に `VOID`／`CORRECTED` にすると、取消処理が変更検出より先に動き、**DELETE に進みます**。契約と同梱 OpenAPI の説明上、元明細は `excluded` になり、通常の照合から消えます。逆方向の変更では、現金仕訳を連携仕訳として PUT する可能性もあります。

**修正案:** 作成経路は `mf_sync_input` の作成時支払方法・明細 ID、必要なら MF の `transaction_id` で判定してください。来歴が不明・矛盾している場合は自動削除せず確認待ちにするべきです。祖先の引継ぎ待ち判定も同じ基準に揃えてください。

## 3. Major

### M1. 自動照合の「一対一」が実行中の台帳変更で崩れる

**箇所:** [gas/src/app/journalSync.ts:1619](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:1619)、[gas/src/app/journalSync.ts:1512](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:1512)

**事実:** 一対一判定はスナップショットに対して行います。保存直前には全行を読み直しますが、再確認するのは「他行が明細 ID を使用中か」であり、**新たな候補行との取り合い**は再確認しません。

例えば、照合計算後に別の `/keihi` 行が同じ金額・日付範囲で登録されても、その行は明細 ID を持たないため、自動確定できます。

**修正案:** 自動確定時はロック内の最新全行で候補・取り合い・祖先待ちを再評価してください。人が明細 ID を指定した経路とは判定を分ける必要があります。

### M2. 週次報告には実行期限が効かず、履歴量に応じてタイムアウトする

**箇所:** [gas/src/app/journalSync.ts:1879](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:1879)、[gas/src/app/journalSync.ts:1951](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:1951)

**事実:** 仕訳は開業日以降を毎週取得し、明細取得は明示的に `useDeadline:false` です。表示上限 10 件は取得量を制限しません。既存の証憑突合・OAuth keepalive の後に同じ実行で動きます。

**リスク:** 現在の件数で 6 分を超えるとは確認できませんでした。ただし、複数サービス・複数年・ページ取得や Retry-After が重なると、報告前に強制終了する構造です。

**修正案:** トリガー開始からの共通期限を渡し、ページ位置・集計途中結果を保存して分割実行してください。未完了を「異常なし」と扱わないことも必要です。

### M3. 明細のページ上限到達を「全件取得成功」として返す

**箇所:** [gas/src/app/journalSync.ts:759](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:759)

**事実:** `metadata.total_pages > 50` でも、50 ページ終了後に取得済みの配列を正常に返します。

**帰結:** 未取得ページに別候補がある場合、実際には複数候補なのに一対一と判断できます。回収では明細の未発見、週次報告では件数過少になります。期限超過時に部分結果を返さない設計と不整合です。

**修正案:** 上限到達時に残ページがあるなら、結果を返さず「検索未完了」にしてください。期間の再分割などで続きを取得する方式が適切です。

### M4. S-M5b は回収と貸方保存の前提が崩れても成功扱いになり得る

**箇所:** [gas/src/app/mf/spikeJournalize.ts:175](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/mf/spikeJournalize.ts:175)、[gas/src/app/mf/spikeJournalize.ts:208](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/mf/spikeJournalize.ts:208)

**事実:**

- `transaction_ids` 検索で作成仕訳が見つからなくても、ログだけで処理を続けます。
- PUT 後の合否は摘要だけです。貸方科目・金額・補助科目、明細との紐付きを比較しません。
- フェイクは [gas/test/app/mf/fakeMfAccounting.ts:320](/Users/takenouchiharuhi/projects/kadobo/gas/test/app/mf/fakeMfAccounting.ts:320) で、仕訳済み明細への再 POST を必ず拒否します。これは再送安全性の前提を実装したもので、実機検証の代わりにはなりません。

**修正案:** 検索結果不一致をスパイク失敗にし、PUT 前後の貸方と明細紐付きを検証してください。同一明細への再 POST が二重作成されないことも実機で確認し、その観測をフェイクと契約に反映してください。

## 4. Minor

### 無効ルールの行番号が空行の後でずれる

**箇所:** [gas/src/adapters/sheets.ts:1155](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:1155)、[gas/src/app/journalSync.ts:1992](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/journalSync.ts:1992)

空行を除去してから配列添字に `2` を足して報告するため、実際のシート行番号と一致しません。

**修正案:** ルール取得時に実際の行番号を保持してください。

## 5. 良い点

- 全台帳行を対象に取り合いを検出し、API 作成件数だけを 20 行に制限している。
- MF・Slack 呼出しをスクリプトロック外に置き、列指定書込みで業務列を保護している。
- 通常同期では、期限切れの部分検索結果を確定判断に使わない。
- パス ID のエンコードとクエリ ID の raw 指定を分離し、免税設定の不要項目を送っていない。
- OAuth 更新の直列化、世代確認、保存失敗時の固定例外により、秘密情報を含む例外の伝播を抑えている。

## 6. 確認できなかった点

- **1083 件のテスト成功は依頼文の情報です。** 今回、全テストは再実行していません。B1 の純関数分岐は実行確認済みです。
- 本番 GAS @12、Script Properties、実際のシート移行結果・保護・非表示、トリガー所有者とユーザーロックの動作。
- S-M5b の実測結果、同一明細への再 POST の実機挙動、PUT 後の貸方・明細紐付きの保存。
- 現在の履歴量での週次報告所要時間と、トリガー合計実行時間。
- §6.6 の本番有効化条件である、カード・口座それぞれの 1 か月分の残高照合。

ファイルの変更は行っていません。
