# Codex レビュー: 経費フェーズ WP9c（機能フラグ）＋ WP9b（受入試験・運用手順）（2026-09-27）

対象: 未コミットの差分（`worker/`・`gas/`・`worker/migrations/0002_expense_flags.sql`・
`docs/受入試験チェックリスト.md`・`docs/runbooks/01_初回デプロイ.md`・`docs/runbooks/02_運用・再デプロイ.md`）
実行: `codex exec --skip-git-repo-check -s read-only` / codex-cli 0.155.1 / tokens 86,307

> Claude 側の所見はプロンプトに含めていない（独立性を保つため）。
> 本ファイルは Codex の生出力。突き合わせの結果と対応は下の「対応」節に記す。

---

**総評：このままのコミットは見送るべきです。** フラグの基本実装は設計と整合していますが、電子取引を紙として再登録させる案内と、ロールバック時の競合・排出確認に修正が必要です。

`git status --short`・`git diff` と、未追跡の `0002_expense_flags.sql` を確認しました。以下は独立した判断です。

**Blocker**

1. **電子取引の拒否文言が、法令ゲートを回避する操作を指示しています。**  
   [worker/src/handlers/expense.ts:328](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/expense.ts:328)

   `E_DOC_DISABLED_ERROR` の「紙の証憑として登録してください」に従って区分だけ `paper` に変えると、同じ電子取引ファイルが登録できます。保存先も紙側になり、電子取引向けの規程・運用から外れるおそれがあります。

   電子取引かどうかは受領方法で決まり、選択肢を変更したり紙に出力したりして電子データ保存を代替できるものではありません。[国税庁・電子取引関係一問一答（問2・問27）](https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0024005-113_r603.pdf)

   「電子取引の受付は無効です。区分を変更せず、元データを所定フォルダへ手動保存してください」等に変更し、要件定義 §4.3 の暫定運用へ誘導してください。また、無効理由はロールバックや D1 障害の場合もあるため、「G-2・G-3 の完了待ち」の固定表示も不正確です。

**修正すべき**

2. **フラグ確認と journal INSERT が非原子的で、pending＝0 を確認した後に受付が成立し得ます。**  
   [worker/src/handlers/expense.ts:350](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/expense.ts:350)、[同:399](/Users/takenouchiharuhi/projects/kadobo/worker/src/handlers/expense.ts:399)  
   [docs/runbooks/02_運用・再デプロイ.md:232](/Users/takenouchiharuhi/projects/kadobo/docs/runbooks/02_運用・再デプロイ.md:232)

   次の順序が可能です。

   1. 送信処理がフラグ `1` を読む。
   2. 運用者が Worker フラグを `0` にし、pending＝0 を確認する。
   3. GAS フラグを落とす。
   4. 先ほどの送信処理が INSERT し、モーダルを閉じる。
   5. GAS が新規行を `EXPENSE_DISABLED` で拒否する。

   これでは正しい切替順でも、受付済みの記録が台帳に残りません。フラグ条件付き INSERT 等で、**最終受付判定と永続化を同一の原子的操作にする**必要があります。無効化を両処理の間に差し込むテストも追加してください。

3. **「放置すれば自然に捌ける」と pending＝0 だけでは、ロールバック完了を保証できません。**  
   [docs/runbooks/02_運用・再デプロイ.md:232](/Users/takenouchiharuhi/projects/kadobo/docs/runbooks/02_運用・再デプロイ.md:232)

   `forwarding_enabled=0` なら Cron は動かず、pending は減りません。継続する GAS／Drive 障害でも減りません。逆に、`FILE_NOT_FOUND` や `CONFIG_MISSING` で `rejected` になれば、保存が完了しなくても pending はゼロになります。

   手順に以下を明記してください。

   - 排出中は `forwarding_enabled=1`、GAS 側の対象フラグも有効であること。
   - 減らない場合は `attempts`・`last_error` を調べ、原因を復旧すること。
   - ゼロになった後、対象の `rejected` と台帳の未完了行を照合し、手動対応を確定してから旧コードへ戻すこと。
   - 電子取引だけ止める場合は、**電子取引の pending** を対象に待つこと。

   これは新しい無限再送バグというより、既存の失敗経路を新しい運用手順が扱えていない問題です。

4. **週次突合試験の仕込みでは、記載された異常を再現できない場合があります。**  
   [docs/受入試験チェックリスト.md:436](/Users/takenouchiharuhi/projects/kadobo/docs/受入試験チェックリスト.md:436)

   - 停滞行の例に挙げた「8-h の手順3・4」では、台帳行はまだありません。台帳を走査する週次突合では検出できません。
   - サイズ不一致は「同名ファイルへの差し替え」では不十分です。実装は名前ではなく `drive_file_id` で取得します。別 ID でアップロードすると、元ファイルが残れば異常なし、削除すれば「消えた証憑」になります。

   実際の `RECEIVED`／`FILE_SAVED`／`ERROR` 行を用意し、サイズ試験では**同じ file ID の内容を更新する**手順へ具体化してください。根拠は [gas/src/app/triggers.ts:200](/Users/takenouchiharuhi/projects/kadobo/gas/src/app/triggers.ts:200) 以降です。

5. **受入試験8-nは、説明している GAS 側のフラグ迂回を実地確認していません。**  
   [docs/受入試験チェックリスト.md:474](/Users/takenouchiharuhi/projects/kadobo/docs/受入試験チェックリスト.md:474)

   操作手順で変更するのは Worker の小文字フラグだけです。それで Cron が進んでも、GAS の `ENABLE_EXPENSE`／`ENABLE_E_DOC` 無効時に再開できる証明にはなりません。また、8-j を最後まで実施した行は既に `COMPLETED` です。

   再開待ち行を作る操作、GAS フラグを落とす操作、再送後の確認、設定復元を明記してください。台帳未作成の pending と混同しないよう、試験対象の ID も固定する必要があります。

**提案**

6. **追加15件は WP9c の最低条件をカバーしていますが、切替境界のテストを補強してください。**  
   [worker/test/expense.test.ts:731](/Users/takenouchiharuhi/projects/kadobo/worker/test/expense.test.ts:731)  
   [gas/test/app/expense.test.ts:418](/Users/takenouchiharuhi/projects/kadobo/gas/test/app/expense.test.ts:418)

   静的には、モーダル停止・INSERT抑止・電子取引だけの停止・既存行の再開という §9 の4条件を満たしています。追加価値が高いのは次です。

   - 台帳未作成の D1 pending が、Worker 無効・GAS 有効で Cron により完了する。
   - 新エラー2種が journal の `rejected` になり、次回 Cron で再送されない。
   - モーダルを開いた後の無効化、受付済み submission の再配送。
   - `RECEIVED` の電子取引を `ENABLE_E_DOC=0` で再開する。現在の電子取引側の再開試験は `FILE_SAVED` です。
   - D1 読み取り例外をハンドラまで通して、INSERT／外部送信がないことを確認する。

7. **電子取引の解禁後に、保存から提示までの受入試験を追加してください。**  
   [docs/runbooks/01_初回デプロイ.md:278](/Users/takenouchiharuhi/projects/kadobo/docs/runbooks/01_初回デプロイ.md:278)

   G-1〜G-5 を待つ方針は妥当ですが、紙の登録試験だけでは電子取引の運用を確認できません。元データの登録・ダウンロード後の同一性、日付／金額／取引先による検索、画面表示・印刷、台帳と証憑の一括出力、訂正記録の確認を追加するとよいです。検索要件の免除があっても、保存・提示に必要な他の要件まで免除されるわけではありません。[国税庁・電子取引関係一問一答（問15・問16）](https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0024005-113_r603.pdf)

通常の署名済み・同一ペイロード再送については、**既存行の検索後に新規行だけフラグ判定する配置は妥当**です。新エラーの `retryable:false` も既存の応答マッピングに乗り、それ自体が無限再送を生む経路は見つかりませんでした。D1 の fail closed と migration の既定値も妥当です。

検証結果は **Worker・GAS とも型チェック成功**。テストは両方とも、読み取り専用環境による Vitest 一時ファイル作成の `EPERM` で開始できておらず、実行成功は確認していません。


---

## 対応（2026-09-27）

Claude 側で全 7 件の裏を取り、**5 件を修正、1 件を運用側での回避に留め、1 件を将来の試験項目として採用**した。

| # | Codex の指摘 | 判定 | 対応 |
|---|---|---|---|
| 1 | `E_DOC_DISABLED_ERROR` が「紙の証憑として登録してください」と案内している（Blocker） | ✅ **成立** | 撤回。要件定義 §4.3.3 のとおり電子取引は電磁的記録そのものの保存義務があり、書面出力で代えることは不可。区分を `paper` に変えさせると紙の運用（`経費証憑/紙/...`）に入ってしまう。文言を「区分を『紙』に変えて登録しないでください」＋要件定義 §4.3.3 末尾の**暫定運用**（元データを Drive の所定フォルダへ手動保存し台帳に手入力）への誘導に差し替えた。停止理由を「G-2・G-3 完了待ち」と固定断定するのもやめた（ロールバック中・D1 障害でも無効になりうる） |
| 2 | フラグ判定と journal INSERT が非原子的で、pending=0 確認後に受付が成立しうる | ✅ 成立（**根本修正は見送り**） | 窓の存在は事実。ただし `insertJournal` の `inserted:false` は現在**重複受付**を意味しており、フラグ由来の不成立を同じ値で返すと `{response_action:'clear'}`＝利用者には成功に見える。区別する経路を足すと常時通る受付パスが複雑になる一方、窓はハッシュ計算＋1 INSERT（通常 1 秒未満）、利用者 1 名、ロールバックは年に数回、外れても失敗の DM が届く。**運用で塞ぐ**判断とし、`enable_expense=0` の後 1 分あけて pending=0 を 2 回確認する手順を runbook §I-5 に、判断の理由を実装設計 §5.9.3 に記録した |
| 3 | 「放置すれば自然に捌ける」では排出を保証できない | ✅ **成立** | runbook §I を 7 ステップに再構成。排出中の前提確認（`forwarding_enabled=1`・GAS 側フラグ有効）、減らないときの `attempts`／`last_error` 調査、pending=0 後の `rejected` 行と台帳未完了行の突き合わせ、`e_doc` だけ止める場合の pending の絞り込みを追加した |
| 4 | 8-m の仕込みでは週次突合の異常を再現できない | ✅ **成立** | `trigWeeklyOrphanCheck` は経費台帳の全行を起点に `drive_file_id` で Drive を引く。停滞行の仕込みを「実在の台帳行」に、サイズ不一致を「**同じ file ID のままバージョンを差し替える**」に具体化した |
| 5 | 8-n が GAS 側フラグの迂回を実地確認していない | ✅ **成立** | 8-n-1（Worker 側）／8-n-2（GAS 側）に分割。8-n-2 で証憑 ID・journal ID を固定した再開待ち行を作り、GAS の `ENABLE_EXPENSE=0` のまま Cron 再送で `COMPLETED` に戻ることを確認する手順にした |
| 6 | 切替境界のテスト補強 | ✅ 採用（一部） | 4 件追加: D1 読み取り例外をハンドラまで通して INSERT も外部送信も起きないこと／`RECEIVED` の `e_doc` を `ENABLE_E_DOC=0` のまま再開／`enable_expense=0` でも既存 pending が Cron で GAS へ届くこと／新エラー 2 種が `rejected` になり再送されないこと。テストは 546 → **561 件** |
| 7 | `e_doc` 解禁後の可視性の受入試験 | ✅ **採用** | 受入試験 8-p を新設（原本の SHA-256 一致、日付・金額・取引先での検索、画面表示・印刷、台帳と証憑の一括出力、訂正削除申請シートの記録）。検索要件が緩和されても見読可能性・真実性は免除されない旨を注記 |

**Codex が「妥当」と判定した点**: 既存行の検索後に新規行だけフラグ判定する配置、新エラーの `retryable:false`、
D1 の fail closed、migration の既定値。無限再送を生む新しい経路は見つからなかった。

⚠️ Codex は読み取り専用サンドボックスのため Vitest を実行できていない（`EPERM`）。
テストの実行結果は Claude 側で確認した（**561 件全通過**・`npm run typecheck` exit 0）。
