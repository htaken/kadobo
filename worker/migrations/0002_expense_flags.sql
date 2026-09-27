-- 経費フェーズの機能フラグ（実装設計 経費フェーズ §5.9, §5.9.1, §10.1 ステップ1）。
-- フラグはすべて無効（'0'）の状態で入れる。行が無ければ isSettingEnabled は false を返す
-- （settings.forwarding_enabled と同じ機構・同じ既定に揃える）。
-- INSERT OR IGNORE: 既に行があれば触らない（再実行しても安全。0001_journal.sql と同じ方針）。
INSERT OR IGNORE INTO settings(key, value) VALUES ('enable_expense', '0');
INSERT OR IGNORE INTO settings(key, value) VALUES ('enable_e_doc', '0');
