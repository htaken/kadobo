/**
 * MF API 呼び出し失敗の通知（実装設計 MF連携 §4.4）。
 *
 * - {@link MfReauthRequiredError}/{@link MfAuthError} → DM で対処を依頼する。文言・抑止キーは
 *   `err.service` で分ける（レビュー指摘）:
 *   - `"invoice"`（請求書 API・OAuth）→ 既存の再認可文言。内部シート `mf_notice/reauth` に
 *     最終通知時刻を記録し、24 時間に 1 回まで
 *   - `"accounting"`（会計 API・API キー）→ API キーの有効性・権限確認を促す文言
 *     （OAuth の再認可とは対処方法が違うため、「再認可してください」とは言わない）。
 *     内部シート `mf_notice/apikey` で同じく 24 時間に 1 回まで
 * - {@link MfTransientError} → 内部シート `mf_fail/<target>` に連続回数を数え、
 *   6 回目に「一時障害が続いています」を DM（上記 2 つとは文言を分ける）
 * - 成功時は {@link notifyMfSuccess} で連続回数カウンタをリセットする
 *
 * `MfApiError`・`ConfigMissingError` はここでは扱わない（呼び出し側が個別の業務エラーとして
 * 台帳・カード等に反映する。実装設計 §4.4 の表）。
 *
 * **ロックについて**（レビュー指摘）: 内部シートの `getInternalValue`/`setInternalValue` は
 * 「読んで、無ければ追記・あれば更新」という read-modify-write のため、ロックの外から複数の
 * 実行が同時に同じ kind/key を書こうとすると、両方が「無い」と判定して 2 行できる事故がありうる
 * （`adapters/sheets.ts` の `setInternalValue` 参照）。{@link notifyMfFailure}/
 * {@link notifyMfSuccess}（トリガー等、**ロックの外から呼ぶ**関数）は、読み→判定→書きの部分
 * だけを短い `ports.lock.withLock` で囲み、DM 送信（HTTP）はロックの外で行う
 * （MF 呼び出しと同じ理由。実装設計 §0）。
 *
 * 呼び出し側が**既に**スクリプトロックを保持している場合は、ここで追加のロックを取ると
 * 入れ子になり失敗する（`LockAdapter.withLock` は `finally` で `releaseLock()` するため
 * 入れ子にできない。`app/mf/lease.ts` 冒頭と同じ注意）。その場合は
 * {@link notifyMfFailureUnlocked}/{@link notifyMfSuccessUnlocked} を使うこと。
 */
import type { AppPorts } from "../ports";
import { MfAuthError, MfReauthRequiredError, MfTransientError, type MfService } from "./errors";

const NOTICE_KIND = "mf_notice";
const REAUTH_NOTICE_KEY = "reauth";
const APIKEY_NOTICE_KEY = "apikey";
const REAUTH_SUPPRESS_MS = 24 * 60 * 60 * 1000;

const FAIL_COUNT_KIND = "mf_fail";
/** この回数に達した時点で 1 回だけ通知する（実装設計 §4.4「6 回連続したら」）。 */
const TRANSIENT_NOTIFY_THRESHOLD = 6;

function dmOperator(ports: AppPorts, text: string): void {
  const userId = ports.props.get("SLACK_USER_ID");
  if (userId === null) {
    return;
  }
  try {
    ports.slack.dm(userId, text);
  } catch {
    // 通知自体の失敗はベストエフォート（`expense.ts` の `notifyConfigMissing` と同じ方針）。
  }
}

/** service ごとの内部シートキーと DM 文言（レビュー指摘: invoice/accounting で対処法が違う）。 */
function reauthNoticeKeyAndText(target: string, service: MfService): { key: string; text: string } {
  if (service === "accounting") {
    return {
      key: APIKEY_NOTICE_KEY,
      text: `⚠️ MF 会計 API の認証に失敗しました（${target}）。MF_ACCOUNTING_API_KEY の有効性と権限（設計書 §9）を確認してください。`,
    };
  }
  return {
    key: REAUTH_NOTICE_KEY,
    text: `⚠️ MF の再認可が必要です（${target}）。runbook 02 の手順で再認可してください。`,
  };
}

/** 読み→判定→書きだけを行い、DM で送るべきテキストを返す（`null` なら送らない）。ロックは取らない。 */
function decideReauthNotify(ports: AppPorts, target: string, service: MfService): string | null {
  const { key, text } = reauthNoticeKeyAndText(target, service);
  const nowMs = ports.clock.nowMs();
  const last = ports.sheets.getInternalValue(NOTICE_KIND, key);
  if (last !== null) {
    const lastMs = parseInt(last, 10);
    if (Number.isFinite(lastMs) && nowMs - lastMs < REAUTH_SUPPRESS_MS) {
      return null;
    }
  }
  ports.sheets.setInternalValue(NOTICE_KIND, key, String(nowMs));
  return text;
}

/** 読み→判定→書きだけを行い、DM で送るべきテキストを返す（`null` なら送らない）。ロックは取らない。 */
function decideTransientNotify(ports: AppPorts, target: string): string | null {
  const current = ports.sheets.getInternalValue(FAIL_COUNT_KIND, target);
  const count = (current === null ? 0 : parseInt(current, 10) || 0) + 1;
  ports.sheets.setInternalValue(FAIL_COUNT_KIND, target, String(count));
  if (count === TRANSIENT_NOTIFY_THRESHOLD) {
    return `⚠️ MF（${target}）で一時障害が続いています（${count} 回連続）。`;
  }
  return null;
}

/** 内部シートの読み→判定→書きだけを行う（ロックは取らない）。DM で送るべきテキスト（無ければ `null`）。 */
function decideFailureNotify(ports: AppPorts, target: string, err: unknown): string | null {
  if (err instanceof MfReauthRequiredError || err instanceof MfAuthError) {
    return decideReauthNotify(ports, target, err.service);
  }
  if (err instanceof MfTransientError) {
    return decideTransientNotify(ports, target);
  }
  return null;
}

/** `mf_fail/<target>` の連続回数カウンタをリセットする（ロックは取らない）。 */
function resetTransientCounter(ports: AppPorts, target: string): void {
  const current = ports.sheets.getInternalValue(FAIL_COUNT_KIND, target);
  if (current !== null && current !== "0") {
    ports.sheets.setInternalValue(FAIL_COUNT_KIND, target, "0");
  }
}

/**
 * {@link notifyMfFailure} の「ロックを取らない版」。**呼び出し側が既にスクリプトロックを
 * 保持している場合だけ**使う（そうでなければロック無しで内部シートを read-modify-write する
 * ことになり、複数実行が競合すると同じ kind/key の行が二重にできるおそれがある。上記クラス
 * コメント参照）。
 */
export function notifyMfFailureUnlocked(ports: AppPorts, target: string, err: unknown): void {
  const text = decideFailureNotify(ports, target, err);
  if (text !== null) {
    dmOperator(ports, text);
  }
}

/**
 * MF API 呼び出しの例外を分類して通知する。**ロックの外（トリガー等）から呼ぶこと**。
 * 内部シートの読み→判定→書きだけを短い `ports.lock.withLock` で囲み、DM 送信はロックの外で
 * 行う。呼び出し側が既にロックを保持している場合は {@link notifyMfFailureUnlocked} を使うこと
 * （入れ子にすると `LockPort` の実装によっては失敗する）。
 */
export function notifyMfFailure(ports: AppPorts, target: string, err: unknown): void {
  const text = ports.lock.withLock(() => decideFailureNotify(ports, target, err));
  if (text !== null) {
    dmOperator(ports, text);
  }
}

/** {@link notifyMfSuccess} の「ロックを取らない版」。呼び出し側が既にロックを保持している場合に使う。 */
export function notifyMfSuccessUnlocked(ports: AppPorts, target: string): void {
  resetTransientCounter(ports, target);
}

/**
 * 成功時に呼ぶ。`mf_fail/<target>` の連続回数カウンタをリセットする。**ロックの外から呼ぶこと**。
 * 呼び出し側が既にロックを保持している場合は {@link notifyMfSuccessUnlocked} を使うこと。
 */
export function notifyMfSuccess(ports: AppPorts, target: string): void {
  ports.lock.withLock(() => resetTransientCounter(ports, target));
}
