/**
 * `SecretStorePort` の GAS 実装（実装設計 MF連携 §4.1, §4.2）。`PropertiesService.getScriptProperties()`
 * の読み書き両方を行う（{@link PropsPort} は読み取り専用のまま残す）。MF のトークン
 * （`MF_INVOICE_TOKENS`）の保存専用に使う。
 */
import type { SecretStorePort } from "../app/ports";

export class SecretStoreAdapter implements SecretStorePort {
  get(key: string): string | null {
    return PropertiesService.getScriptProperties().getProperty(key);
  }

  set(key: string, value: string): void {
    PropertiesService.getScriptProperties().setProperty(key, value);
  }
}
