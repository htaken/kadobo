/**
 * Worker のバインディング型（実装設計 §6.7）。
 *
 * Secrets（`wrangler secret put` で設定、ローカルは `.dev.vars`）:
 *   SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GAS_SHARED_SECRET, GAS_URL
 * Bindings:
 *   DB（D1 受付ジャーナル、実装設計 §5）
 *
 * `index.ts` から独立させているのは、`gas.ts` 等の I/O モジュールが `Env` 型を必要とする一方で
 * `index.ts` がそれらのモジュールを import する循環参照を避けるため。
 */
export interface Env {
  /** D1 受付ジャーナル（実装設計 §5）。 */
  DB: D1Database;
  /** Slack のリクエスト署名検証用シークレット（実装設計 §6.1, 要件定義 §5.2）。 */
  SLACK_SIGNING_SECRET: string;
  /** Slack Bot User OAuth Token（`chat.update` 等の呼び出しに使用）。 */
  SLACK_BOT_TOKEN: string;
  /** Worker↔GAS 封筒の HMAC 共有シークレット（実装設計 §3.1）。 */
  GAS_SHARED_SECRET: string;
  /** GAS Web アプリの `/exec` URL（実装設計 §3）。 */
  GAS_URL: string;
}
