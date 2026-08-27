/**
 * 封筒署名の契約テスト（実装設計 §3.1, §8 WP1 受入条件）。
 *
 * `shared/test/vectors/envelope.json` は監督者が正典として生成したテストベクタ。
 * Worker の WebCrypto 実装（`src/webcrypto.ts` の `hmacSha256Hex`）が同じ `sig` を
 * 再現できることを検証する（Worker=WebCrypto と GAS=Utilities.computeHmacSha256Signature の
 * 相互運用性を担保する契約テスト）。ハーネス不要のユニットテスト。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envelopeSigningString } from "@kadobo/shared/protocol";
import { hmacSha256Hex } from "../src/webcrypto";

const vectorsPath = fileURLToPath(
  new URL("../../shared/test/vectors/envelope.json", import.meta.url),
);

interface EnvelopeVector {
  name: string;
  ts: number;
  nonce: string;
  payload: string;
  signing_string: string;
  sig: string;
}

interface VectorsFile {
  secret: string;
  vectors: EnvelopeVector[];
}

const vectorsFile = JSON.parse(readFileSync(vectorsPath, "utf-8")) as VectorsFile;

describe("封筒署名の契約テスト（shared/test/vectors/envelope.json）", () => {
  it("ベクタファイルに5件のベクタが含まれる", () => {
    expect(vectorsFile.vectors.length).toBe(5);
  });

  for (const vector of vectorsFile.vectors) {
    it(`${vector.name}: signing_string の組み立てが一致する`, () => {
      expect(envelopeSigningString(vector.ts, vector.nonce, vector.payload)).toBe(
        vector.signing_string,
      );
    });

    it(`${vector.name}: WebCrypto HMAC-SHA256 が期待される sig を再現する`, async () => {
      const sig = await hmacSha256Hex(vectorsFile.secret, vector.signing_string);
      expect(sig).toBe(vector.sig);
    });
  }
});
