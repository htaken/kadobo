/**
 * GAS の純粋ロジック（実装設計 §7.2〜§7.4, §7.6）。
 * Sheets/Slack/Drive/Cache/Lock/Calendar 等の外部 I/O に一切依存しない純関数群。
 * WP3（app/adapters）はこのバレルから import してユースケースを組み立てる。
 */
export const CORE_VERSION = 1;

export * from "./state";
export * from "./correction";
export * from "./businessDate";
export * from "./aggregate";
export * from "./envelope";
export * from "./card";
export * from "./expense";
