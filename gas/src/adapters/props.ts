/** `PropsPort` の GAS 実装（実装設計 §7.8）。`PropertiesService.getScriptProperties()`。 */
import type { PropsPort } from "../app/ports";

export class PropsAdapter implements PropsPort {
  get(key: string): string | null {
    return PropertiesService.getScriptProperties().getProperty(key);
  }
}
