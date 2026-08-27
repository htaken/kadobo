# 封筒（envelope）相互運用テストベクタ

`envelope.json` は Worker（WebCrypto の HMAC-SHA256）と GAS（`Utilities.computeHmacSha256Signature`）が
**同一の署名を再現できること**を保証する契約テストベクタ。監督者が Node の crypto を正典（ground truth）
として生成済み。実装設計 §3.1・§7.4 参照。

- `secret` はダミー値（テスト専用）。本番では絶対に使わない
- `signing_string_format` = `${ts}.${nonce}.${payload}`、`sig` は小文字 hex
- WP1（Worker）・WP2（GAS core）は各自の HMAC 実装でこのベクタの `sig` を再現するテストを持つこと
