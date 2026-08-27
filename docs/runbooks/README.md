# Runbooks（運用手順書）

kadobo（稼働記録・経費管理システム MVP）を**実際に動かすため**の手順書。
`../../README.md` が「何を・なぜ」を説明する参照ドキュメントなのに対し、この runbooks は
「順番どおりに実行すればデプロイ・運用できる」チェックリスト形式の実行手順。

| # | 手順書 | 使う場面 |
|---|---|---|
| 01 | [初回デプロイ](01_初回デプロイ.md) | まっさらな状態から本番稼働まで（1 回きり） |
| 02 | [運用・再デプロイ](02_運用・再デプロイ.md) | コード変更の再デプロイ、停止/再開、シークレット更新、月次締め、バックアップ |
| 03 | [トラブルシューティング](03_トラブルシューティング.md) | 打刻が記録されない、401、pending が残る等の対処 |

## 全体像（依存の順序）

デプロイには URL の相互依存がある。**必ず 01 の順序で行う**。

```
① ローカル検証（test/build）
② Slack アプリ作成 → signing secret / bot token / channel_id / user_id を控える
③ Cloudflare: D1 作成 → migrations → secrets（GAS_URL は一旦ダミー）→ deploy
      └→ Worker の URL が確定
④ Slack の Request URL 2 本を Worker URL に設定
⑤ GAS: スプレッドシート作成 → clasp push → ウェブアプリ公開
      └→ /exec URL が確定。Script Properties 設定・setupSpreadsheet・installTriggers
⑥ Worker の GAS_URL secret を本物の /exec URL に上書き（再デプロイ不要）
⑦ スモークテスト → 受入試験（../受入試験チェックリスト.md）
```

## 前提

- Node 24（`node -v`）。リポジトリ直下で `npm install` 済み
- `npx wrangler` / `npx clasp` が使える（devDependencies なのでグローバル導入は不要）
- Cloudflare アカウント、Google アカウント（2 段階認証推奨）、本人所有 Slack ワークスペース
- 対話ログイン（`wrangler login`・`clasp login`）はブラウザ認証が必要。**Claude Code のプロンプトで `! <コマンド>` と打つと、その場で実行され出力が会話に取り込まれる**ので伴走しやすい

## シークレットの扱い

- `GAS_SHARED_SECRET` は自分で生成する共有秘密。**Worker 側（`wrangler secret put`）と GAS 側（Script Property）に同じ値**を入れる
- 生成: `openssl rand -hex 32`
- どのシークレットも Git・ドキュメント・ログに実値を書かない
