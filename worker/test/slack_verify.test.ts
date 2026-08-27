/**
 * Slack 署名検証テスト（実装設計 §6.1, 要件定義 §5.2）。ハーネス不要のユニットテスト。
 */
import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/webcrypto";
import { verifySlackSignature } from "../src/slack/verify";

const SIGNING_SECRET = "test-slack-signing-secret-DO-NOT-USE";

async function sign(ts: string, body: string): Promise<string> {
  const hex = await hmacSha256Hex(SIGNING_SECRET, `v0:${ts}:${body}`);
  return `v0=${hex}`;
}

describe("verifySlackSignature", () => {
  it("正しい署名・時刻窓内なら true", async () => {
    const nowSec = 1756260000;
    const ts = String(nowSec);
    const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
    const signature = await sign(ts, body);
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestampHeader: ts,
      signatureHeader: signature,
      nowSec,
    });
    expect(ok).toBe(true);
  });

  it("不正な署名（1 文字改変）なら false", async () => {
    const nowSec = 1756260000;
    const ts = String(nowSec);
    const body = "command=%2Fkado&text=";
    const validSig = await sign(ts, body);
    const tamperedSig = `${validSig.slice(0, -1)}${validSig.endsWith("0") ? "1" : "0"}`;
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestampHeader: ts,
      signatureHeader: tamperedSig,
      nowSec,
    });
    expect(ok).toBe(false);
  });

  it("body が改変されていれば署名は一致しない", async () => {
    const nowSec = 1756260000;
    const ts = String(nowSec);
    const signature = await sign(ts, "command=%2Fkado&text=");
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body: "command=%2Fkado&text=tampered",
      timestampHeader: ts,
      signatureHeader: signature,
      nowSec,
    });
    expect(ok).toBe(false);
  });

  it("タイムスタンプが 300 秒より過去なら false（古すぎる）", async () => {
    const nowSec = 1756260301;
    const ts = "1756260000"; // 301 秒前
    const body = "text=x";
    const signature = await sign(ts, body);
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestampHeader: ts,
      signatureHeader: signature,
      nowSec,
    });
    expect(ok).toBe(false);
  });

  it("タイムスタンプが 300 秒より未来なら false", async () => {
    const nowSec = 1756260000;
    const ts = "1756260301"; // 301 秒後
    const body = "text=x";
    const signature = await sign(ts, body);
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestampHeader: ts,
      signatureHeader: signature,
      nowSec,
    });
    expect(ok).toBe(false);
  });

  it("ちょうど 300 秒差は許容する（境界値）", async () => {
    const nowSec = 1756260300;
    const ts = "1756260000"; // ちょうど 300 秒前
    const body = "text=x";
    const signature = await sign(ts, body);
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestampHeader: ts,
      signatureHeader: signature,
      nowSec,
    });
    expect(ok).toBe(true);
  });

  it("ヘッダ欠落は false", async () => {
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body: "text=x",
      timestampHeader: null,
      signatureHeader: null,
      nowSec: 1756260000,
    });
    expect(ok).toBe(false);
  });

  it("数値でないタイムスタンプは false", async () => {
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body: "text=x",
      timestampHeader: "not-a-number",
      signatureHeader: "v0=deadbeef",
      nowSec: 1756260000,
    });
    expect(ok).toBe(false);
  });

  it("定時間比較: 長さの異なる署名でも例外を投げず false を返す", async () => {
    const nowSec = 1756260000;
    const ts = String(nowSec);
    const body = "text=x";
    const ok = await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestampHeader: ts,
      signatureHeader: "v0=short",
      nowSec,
    });
    expect(ok).toBe(false);
  });
});
