# Codex レビュー: MF 連携実装設計 v1（2026-09-27）

対象: `docs/実装設計_MF連携.md`（v1）
実行: `codex exec --skip-git-repo-check -s read-only` / tokens 155,275

---

## 1. 総評

**このまま実装の契約として確定するのは不可です。** 特に、締め処理の競合、経費の途中状態、仕訳作成後の応答喪失、訂正時の明細再利用に、データ欠落・二重計上につながる穴があります。

認証方式の分離、外部 I/O のポート化、段階リリースは妥当です。ただし、**「作成前に検索する」だけでは二重作成を保証できず、MF 側の処理結果が不明な状態を扱う設計が必要**です。

以下、設計書を「MF設計」、取得済みの写しを `iv_openapi.yaml`／`acc_openapi.yaml` と表記します。「確定」は文書・コードから確認できる不整合、「条件付き」は外部挙動や操作順に依存するリスクです。ファイルは変更していません。

## 2. Blocker — 実装前に必ず直す

### B1. 月次行の更新が直列化されておらず、締め状態を巻き戻せる【確定】

**根拠:** [MF設計:255](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:255)、[MF設計:268](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:268)、[triggers.ts:131](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/triggers.ts:131)、[monthly.ts:55](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/monthly.ts:55)、[sheets.ts:757](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:757)。

既存 `trigMonthly` はロックなしで再集計します。次の順序が成立します。

1. 月次トリガーが `REVIEWING` の行を読む。
2. Slack 処理がロック内で `LOCKED` にする。
3. トリガーが古い状態を含む行全体を書き戻す。

`isMonthFrozen` への置換だけでは、この読み取り後の競合を防げません。請求書 ID の消失や、請求書作成中の訂正受付につながります。

**修正案:** 月次行を変更する全経路について、同じ短いロック内で読取・状態確認・書込を完結させる契約を追加してください。既存のロック内呼出しとの入れ子を避け、関数ごとのロック所有責任も明記します。MF 呼出し後の確定時は、最新の状態・締め世代を再確認してください。

### B2. 処理途中の経費を永久に `NOT_TARGET` にしてしまう【確定】

**根拠:** [MF設計:393](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:393)、[MF設計:403](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:403)、[expense.ts:148](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/expense.ts:148)。

経費登録は `RECEIVED → FILE_SAVED → COMPLETED` です。外部ファイル取得中に毎時同期が走ると、`COMPLETED` でないため `NOT_TARGET` になります。その後登録が完了しても「以後触らない」ため仕訳されません。

また、§6.2 を同期状態より先に適用すると、`SYNCED + CORRECTED/VOID` も対象外になり、取消処理を飛ばします。

**修正案:** 評価順序を固定してください。

- 既存の外部操作の回収・取消を先に処理する。
- `RECEIVED/FILE_SAVED` は保留し、同期状態を確定しない。
- 支払方法の追加入力等で対象条件が変わった行は再評価する。
- 永久除外と一時的な未準備を別状態にする。

### B3. 明細仕訳の作成成功後に落ちると、回収経路に到達できない【確定】

**根拠:** [MF設計:445](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:445)、[MF設計:463](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:463)、[MF設計:471](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:471)。

`journalize` 成功後、台帳への ID 保存前に停止すると、次回その明細は未仕訳一覧から消えます。`MF明細ID` も未保存なので、候補選択後にある `GET /journals?...transaction_ids=...` に到達できません。

人が明細 ID を再入力しても、「未仕訳一覧に実在する」検証で拒否されます。さらに、停止中に旧行が `CORRECTED/VOID` になると、`SYNCED` でないため削除対象にもなりません。

**修正案:** POST 前に明細 ID・操作内容・操作状態を永続化してください。再開時は未仕訳候補の探索より先に、その操作を仕訳一覧から回収します。取消済みの行でも、実行済みか不明な操作は回収してから取り消す必要があります。

**受入条件:** 「MF 作成成功→応答喪失」「作成成功→シート保存失敗」「その間に取消」の三経路を追加してください。

### B4. 訂正後に同じ明細を再利用できない【確定】

**根拠:** [MF設計:451](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:451)、[MF設計:495](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:495)。

候補から「他の行の `MF明細ID` に使われている明細」を除外しますが、削除後の旧行は `REVERSED` になるだけで ID を保持します。したがって、MF 側で未仕訳に戻っても訂正後の行とは照合できません。

既存の訂正手順は新行登録と旧行変更が別操作なので、同期が途中を観測する場合も考慮が必要です。

**修正案:** 明細の現在の使用権と履歴を分離してください。旧仕訳の削除・回収完了後に使用権を解放し、`訂正元証憑ID` のある新行は旧行の処理完了を待たせます。旧 ID は監査用に保持できます。

### B5. 支払方法を無視した照合と、明細の取り合いを許す例外がある【確定】

**根拠:** [MF設計:446](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:446)、[MF設計:451](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:451)。

カード・銀行の明細を取得しますが、候補条件に支払方法と連携サービスの対応がありません。カード払いの領収書を同額の銀行支出へ紐付けられます。

また、日付一致を優先する第二条件では、「他の待ち行の候補でもない」という第一条件の制約が抜けています。同額で日付が異なる二行が同じ明細を候補にしている場合、安全に確定できません。

**修正案:** `linked_card`／`linked_bank` ごとに許可するサービス・口座を定義し、候補を分離してください。すべての確定規則で、全待ち行に対する一対一対応を要求します。20行の処理バッチ外の行も競合判定に含め、人が入力した ID にも同じ検証を適用してください。

### B6. 「検索ゼロ件なら再POST」は、応答不明時の二重作成を防ぐ保証にならない【条件付き】

**根拠:** [MF設計:26](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:26)、[MF設計:174](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:174)、[MF設計:338](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:338)、[MF設計:415](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:415)。

POST の通信失敗・5xx 後、MF 側で処理が続いている、または検索への反映が遅れる場合、次回の検索がゼロ件でも前回の作成失敗を意味しません。

取得済み OpenAPI からは、請求書番号・タグの一意制約や検索の即時反映保証を確認できませんでした。lease は GAS 同士の並行実行を抑えますが、この不確実性は解消しません。

**修正案:** POST の結果不明を `UNKNOWN` 等で永続化し、通常の再試行と区別してください。検索で回収できるまでは再POSTせず、自動再作成できる条件が公式仕様で確認できなければ人の確認に倒します。検索は全ページを確認し、複数一致はエラーにしてください。lease は結果の永続化まで保持します。

### B7. 手動作成から自動化へ切り替えると、過去分を再作成し得る【条件付き】

**根拠:** [MF設計:310](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:310)、[MF設計:519](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:519)、[MF設計:638](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:638)、[MF設計:388](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:388)。

手動請求の月は `LOCKED`・ID 空のまま残せます。翌月に自動化を有効にすると再作成対象になり、手動請求書が `KD-YYYYMM` 以外の番号なら検索で発見できません。

経費も、既存の手入力 `MF仕訳ID` を優先する規則が `NEEDS_REVIEW` にしかありません。ID が既にある `cash` 行を評価すると、タグのない手動仕訳を見つけられず新規作成できます。

**修正案:** 自動化開始前の移行処理を契約に含めてください。手動作成済み ID の検証・取込みを最優先し、未確認の過去行にはPOSTしないこと。請求書には手動処理済みを表す状態、または自動作成対象期間を設けてください。

## 3. Major

### M1. OAuth の保存失敗・再認可・keepalive が一貫していない

**根拠:** [MF設計:177](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:177)、[MF設計:192](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:192)、[MF設計:197](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:197)、[MF設計:646](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:646)。

- `setMany` 一回という契約はありますが、保存失敗時の再保存・検証・停止状態がありません。Google の `setProperties` の説明には、複数キーのトランザクション保証は明記されていません。原子的保存を保証済みとして扱えません。[Google 公式](https://developers.google.com/apps-script/reference/properties/properties)
- 再認可では二値しか貼らず、必須とされる `REFRESHED_AT` を初期化しません。稼働中の更新処理との競合も未定義です。
- 「401 時だけ更新」と「週次に強制更新」が矛盾します。MF 公式は有効期限まで再利用し、401 を受けて更新する方針です。[MF 公式](https://developers.biz.moneyforward.com/docs/api/auth/create-token/)
- 寿命不明のリフレッシュトークンについて、週一回で失効を防げる保証はありません。

**修正案:** トークン組・更新日時・世代を一つの保存単位にまとめ、応答取得後の保存失敗では取得済みの値を再保存・照合します。復旧不能なら永続的な再認可待ちにします。再認可は同期停止中に一括反映し、keepalive は通常の `GET /office` 経由に統一してください。失効と一時障害の通知も分けます。

### M2. トークン更新が「必ず10秒以内」は成立しない

**根拠:** [MF設計:184](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:184)、[MF設計:195](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:195)、[lock.ts:15](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/lock.ts:15)。

トークンHTTPを共通の ScriptLock 内で実行しますが、1秒程度というのは期待値です。10秒は他処理のロック取得待ち上限であり、HTTP の実行時間上限ではありません。

**修正案:** 認証専用の永続的な更新状態を短いロックで確保し、HTTP は外で実行する方式、または打刻への影響を許容して再送で復旧する方式を明示してください。前者では、更新結果不明のまま別実行が古いリフレッシュトークンを再使用しない設計が必要です。遅延・保存失敗・同時401を受入試験に追加します。

### M3. 請求書のエラー状態と金額不一致の扱いが未完成

**根拠:** [MF設計:218](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:218)、[MF設計:251](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:251)、[MF設計:344](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:344)。

共通エラー処理は対象を `ERROR` にしますが、月次状態機械に `ERROR` がなく、凍結対象にも含まれません。そのまま採用すると、締め後のAPIエラーで再集計・訂正が可能になります。

金額不一致も通常の `MF_CREATED` になり、次回は金額を再照合せず送付・入金だけ追跡します。また、源泉徴収なしの場合の `deduct_price === 0` を検証していません。

**修正案:** 締め状態と連携エラー・照合結果を分離し、失敗しても凍結を維持してください。不一致は解消を確認するまで明示的に保持し、源泉徴収ゼロと差引入金予定額も比較します。再作成時に使う単価・税設定・日別明細も締め時点で固定してください。

### M4. 前月限定では、締め遅延・過去月の再作成から復旧できない

**根拠:** [MF設計:267](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:267)、[MF設計:651](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:651)。

10月分が要修正のまま12月になれば、毎時評価は11月分だけになります。過去月を `REVIEWING` に戻してカードを消しても、「次のトリガーで再投稿」という復旧手順は成立しません。

**修正案:** 請求開始月以降の未完了月を評価対象にするか、対象月を指定できる復旧エントリを設けてください。古いボタンの再送が再作成後の締めとして有効にならないよう、締め世代も検証します。

### M5. 凍結月への遅延打刻と、人のシート編集を扱えていない

**根拠:** [MF設計:255](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:255)、[stamp.ts:50](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/stamp.ts:50)、[MF設計:509](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:509)、[sheets.ts:826](/Users/takenouchiharuhi/projects/kadobo/gas/src/adapters/sheets.ts:826)。

既存 `handleStamp` は過去月の遅延到着でも凍結確認なしに追記します。月次だけ固定すると、生ログ・日次と請求書が食い違います。

経費では再読込時に金額・科目・支払方法・手入力IDの変更を検証せず、古い入力で作った仕訳を `SYNCED` にできます。さらに `updateExpense` は部分更新APIに見えて、実際には行全体を書き戻します。ScriptLock は人の編集を排他しません。

**修正案:** 未適用の遅延打刻は凍結月なら例外処理へ回してください。MF 操作の入力スナップショットを保存し、変更を検出したら照合待ちにします。同期結果は専用列だけに書き、人による復旧時は同期停止・実行終了待ちを手順化してください。

### M6. MF API の期間・日付・初期設定に食い違いがある

**根拠:** [MF設計:443](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:443)、[MF設計:466](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:466)、[MF設計:568](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:568)。取得済み `acc_openapi.yaml:260,868,5106`。

| 項目 | 確認結果と修正案 |
|---|---|
| 明細取得期間 | API は開始・終了の差を366日以内に制限。最古の待ち行から今日まででは、長期未照合行が残ると失敗する。期間分割が必要。 |
| 仕訳日 | `journalize` の `transaction_date` を省略すると明細日になる。証憑日と最大10日ずれる設計なので年をまたぎ得る。費用計上日を明示し、回収検索もその日付に合わせる。 |
| 事業者番号取得 | `/accessible_offices` はAPIキーでも `office_code` 不要。「全リクエスト必須」から除外しないと、番号を調べる前に設定必須となる。 |

### M7. 家事按分に必要な区別を MF に渡していない

**根拠:** [MF設計:92](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:92)、[MF設計:421](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:421)。

MF の家事按分は勘定科目・補助科目ごとの合計に割合を適用します。行ごとに異なる事業使用割合を、同一科目・補助科目なしで全額登録すると、そのままでは再現できません。[MF公式「家事按分」](https://biz.moneyforward.com/support/tax-return/guide/financial-report/fr06.html)

例えば事業専用の通信費と50%使用の通信費を混ぜると、一律50%では前者まで減額されます。

**修正案:** MF に按分を任せる方針は維持し、割合・用途に対応した補助科目へ振り分けてください。両作成APIに `sub_account_id` があります。対応できない行は自動仕訳せず手動確認に回します。

### M8. 税務上の分類と証憑保存の受入条件が不足している

**根拠:** [MF設計:396](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:396)、[MF設計:438](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:438)、[MF設計:616](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:616)。

**免税事業者:** 税込経理が必要です。MF の公式説明では、免税事業者設定では仕訳に税区分を登録できません。APIで既定 `tax_id` を送った場合の挙動は未確認なので、S-M3のマスタ読取だけで確定すべきではありません。[国税庁](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6909.htm)、[MF公式](https://biz.moneyforward.com/support/account/guide/office02/of02.html)

**開業前支出:** 「開業日前だからすべて開業費」は不正確です。固定資産等を区別する必要があります。「自動同期対象外・人が分類する」に変更してください。[国税庁・決算の手引き](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/041.pdf)

**カード明細:** 電子受領した利用明細自体にも保存が必要です。未決事項には記載されていますが、本設計には保存先・担当・確認手順がありません。月次明細を `/keihi` の仕訳対象として登録すると、個々の支出と二重計上し得ます。仕訳を作らない保存経路を明記してください。[国税庁・一問一答 問5](https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_05.pdf)

**修正案:** S-M3/S-M5 に、免税設定の実事業者で作成した仕訳の税込額・税区分の確認を追加してください。NISA・カード引落しは、除外だけで終わらず、MF側の仕訳ルールと残高照合が成立することをリリース条件にします。

### M9. 全停止フラグと実行時間の契約が不足している

**根拠:** [MF設計:505](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:505)、[MF設計:519](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:519)、[MF設計:656](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:656)。

「フラグをfalseにすればMF呼出しはすべて止まる」に対し、追跡・keepalive・週次報告のガードが明示されていません。削除を支払方法別のどのフラグで制御するかも不明です。

また20行×2～3呼出しは40～60呼出しです。350ms間隔から分かるのは待機時間であり、HTTP・Sheets・ページ巡回を含めて20秒で終わる根拠にはなりません。GAS は1実行6分で、個人アカウントのトリガー総実行時間は90分/日です。[Google公式](https://developers.google.com/apps-script/guides/services/quotas)

Worker の25秒は [gas.ts:64](/Users/takenouchiharuhi/projects/kadobo/worker/src/gas.ts:64) の独自タイムアウトです。GASが後から `ok:true` を返しても、既にタイムアウトしたWorkerの再送は防げません。

**修正案:** 全停止フラグと機能別フラグの適用表を作り、経過時間による打切り・継続位置・行単位の確定を定義してください。締めボタンは締めとジョブ記録までで応答し、MF作成をトリガーへ寄せると単純になります。

### M10. 受入試験が正常系寄りで、実装漏れも検出できない

**根拠:** [MF設計:627](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:627)、[validateRequest.ts:59](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/validateRequest.ts:59)。

変更一覧に `gas/src/app/validateRequest.ts` がありません。現状のままでは `month_close` が `BAD_REQUEST` になります。

S-M1 の `160.25 × 1800` は消費税も整数なので、端数処理の検証には不十分です。例えば `160.01 × 1800` なら消費税相当額に端数が出ます。

**修正案:** B1〜B7の障害順序に加え、署名付きリクエストがWorker→GASの実行時検証を通る試験、旧Workerの再送、税額端数、全フラグfalseでHTTPゼロ件、20行を超える待ち行間の競合を受入条件へ追加してください。

## 4. Minor

- **ステータスの型を明示する。** [MF設計:367](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:367) の `2` は、OpenAPIでは文字列型のコード説明です。`"2"` と日本語ラベルを正規化する契約にしてください。
- **「カードは月一回だけ」の保証範囲を限定する。** [MF設計:269](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:269) は投稿成功後・ts保存前の停止で重複投稿します。許容するなら「通常一回」とし、強い保証を受入条件にしないこと。
- **祝日の説明が逆です。** [MF設計:361](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:361) で12/31が効くのは、通常「11月分・12月末払い」です。
- **会計APIの350ms制御は共有JWT全体には効きません。** [MF設計:207](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:207) は毎時同期・週次報告・手動Pingが同時に同じJWTを使う場合を定義していません。429からの復旧を保証すれば、厳密な共有レート制御まで追加する必要はありません。
- **初回認可スクリプトの仕様を補う。** [MF設計:223](/Users/takenouchiharuhi/projects/kadobo/docs/実装設計_MF連携.md:223) に、コールバックの照合、loopbackへの限定、待受期限、エラー応答処理を追加してください。

## 5. 良い点

- 請求書OAuthと会計APIキーの分離は、障害範囲を小さくしています。APIキー→JWT交換の方式は公式説明と一致します。[MF公式](https://developers.biz.moneyforward.com/docs/common/api-keys/overview/)
- HTTP・時計・保存をポート化しており、障害注入テストを作りやすい構成です。
- `isMonthFrozen` の共通化、末尾への列追加、旧Workerとの互換性維持は適切です。
- MF呼出しをGASに置くため、Workerの外部サブリクエスト数は直接増えません。既存Cronの16件上限は、Freeの50件制限を考慮しています。[Cloudflare公式](https://developers.cloudflare.com/workers/platform/limits/)
- 実物で確認すべき事項をスパイクとして分け、段階的に有効化する方針は維持すべきです。

## 6. 確認できなかった点

- 本物のMFに対する作成・削除・認可更新は実行していません。S-M1〜S-M5の結果、明細の日付、削除後の未仕訳復帰は未確認です。
- POST後の検索反映時間、タイムアウト後のサーバー処理継続、請求書番号・タグの一意性保証は確認できませんでした。
- リフレッシュトークンの寿命、旧トークンの再利用猶予は未確認です。ローテーションありという点は、提供された調査記録の実測に依拠しています。
- 会計APIのオンラインOpenAPI・Rate Limiterページは取得エラーでした。APIの構造は指定されたローカル写しで確認しましたが、3回/秒という値は今回オンラインで再確認できていません。
- MF事業者の免税設定、連携口座・カードの科目と補助科目、NISA・引落しルール、請求書→会計の標準連携設定は未確認です。
