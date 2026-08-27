/**
 * `WorkerStatusPort` の GAS 実装（実装設計 §3.4, §7.7 `trigEveningCheck`）。
 * `UrlFetchApp` で Worker の `POST /internal/status` へ封筒（`payload = JSON({kind:'status'})`）を
 * 送る。Script Properties の `WORKER_STATUS_URL`/`GAS_SHARED_SECRET` が未設定、通信失敗、
 * 応答が `ok:true` でない場合は `null` を返す（trigEveningCheck は他のチェックを継続する）。
 */
import { ENVELOPE_VERSION, envelopeSigningString } from "@kadobo/shared/protocol";
import type { ClockPort, HmacPort, PropsPort, RandomPort, WorkerStatusInfo, WorkerStatusPort } from "../app/ports";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

export class WorkerStatusAdapter implements WorkerStatusPort {
  constructor(
    private readonly props: PropsPort,
    private readonly hmac: HmacPort,
    private readonly random: RandomPort,
    private readonly clock: ClockPort,
  ) {}

  fetchStatus(): WorkerStatusInfo | null {
    const url = this.props.get("WORKER_STATUS_URL");
    const secret = this.props.get("GAS_SHARED_SECRET");
    if (url === null || secret === null) {
      return null;
    }

    const payload = JSON.stringify({ kind: "status" });
    const ts = this.clock.nowSec();
    const nonce = bytesToHex(this.random.randomBytes(16));
    const sig = this.hmac.hmacHex(secret, envelopeSigningString(ts, nonce, payload));
    const envelope = { v: ENVELOPE_VERSION, ts, nonce, payload, sig };

    try {
      const res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json; charset=utf-8",
        payload: JSON.stringify(envelope),
        muteHttpExceptions: true,
      });
      const json = JSON.parse(res.getContentText()) as {
        ok?: unknown;
        pending?: unknown;
        rejected_24h?: unknown;
        oldest_pending_at_ms?: unknown;
      };
      if (json.ok !== true) {
        return null;
      }
      return {
        pending: typeof json.pending === "number" ? json.pending : 0,
        rejected_24h: typeof json.rejected_24h === "number" ? json.rejected_24h : 0,
        oldest_pending_at_ms: typeof json.oldest_pending_at_ms === "number" ? json.oldest_pending_at_ms : null,
      };
    } catch {
      return null;
    }
  }
}
