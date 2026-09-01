/**
 * gas/tsconfig.json は `types: ["google-apps-script"]` のみを持ち、Node の型定義
 * （`@types/node`）を含めない（core が GAS 型にも Node 型にも依存しないための制約）。
 * テストでは実装設計 §7.4 の指示どおり Node の `crypto` を HMAC 実装として注入するため、
 * また経費フェーズ（`FakeDigest`、実装設計 経費フェーズ §5.9）で SHA-256 の計算に使うため、
 * `node:crypto` の型だけをこのテスト専用のアンビエント宣言で最小限補う
 * （`@types/node` を依存に追加しない。実行時は Node/Vitest が提供する実物を使う）。
 */
declare module "node:crypto" {
  interface Hmac {
    update(data: string, inputEncoding: string): Hmac;
    digest(encoding: string): string;
  }
  export function createHmac(algorithm: string, key: string): Hmac;

  interface Hash {
    update(data: Uint8Array): Hash;
    digest(encoding: string): string;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: string): Hash;
}
