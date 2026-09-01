/**
 * `gas/src/adapters/drive.ts`（`DriveAdapter`）のテスト（実装設計 経費フェーズ §5.9, §5.4）。
 *
 * `DriveApp`/`Utilities.newBlob` の最小フェイク（`./fakeDriveApp.ts`）に差し替えて本番の
 * `DriveAdapter` をそのままテストする（`test/adapters/slack.test.ts` と同じ方針）。
 * §5.4 の saga（保存前に必ず `findByName` で検索する）が成立するために `DriveAdapter` が
 * 満たすべき性質（フォルダの遅延作成・同名複数件の検出・ルート未設定時の fail closed）を確認する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DriveAdapter } from "../../src/adapters/drive";
import { FakeProps } from "../app/fakes";
import { installFakeDriveEnvironment, type FakeDriveApp, type FakeDriveFolder } from "./fakeDriveApp";

describe("DriveAdapter", () => {
  let app: FakeDriveApp;
  let restore: () => void;
  let props: FakeProps;

  beforeEach(() => {
    const installed = installFakeDriveEnvironment();
    app = installed.app;
    restore = installed.restore;
    props = new FakeProps();
  });

  afterEach(() => {
    restore();
  });

  it("DRIVE_RECEIPT_ROOT_ID が未設定なら例外を投げる（fail closed、実装設計 §5.9）", () => {
    const adapter = new DriveAdapter(props);
    expect(() => adapter.findByName("経費証憑/紙/2026/09", "x.jpg")).toThrow(/DRIVE_RECEIPT_ROOT_ID/);
  });

  it("DRIVE_RECEIPT_ROOT_ID が無効な ID の場合は例外を投げる（ルートフォルダを自動作成しない）", () => {
    props.set("DRIVE_RECEIPT_ROOT_ID", "not-a-real-folder-id");
    const adapter = new DriveAdapter(props);
    expect(() => adapter.findByName("経費証憑/紙/2026/09", "x.jpg")).toThrow();
  });

  describe("ルートフォルダ設定済み", () => {
    let root: FakeDriveFolder;
    let adapter: DriveAdapter;

    beforeEach(() => {
      root = app.createRootFolder();
      props.set("DRIVE_RECEIPT_ROOT_ID", root.getId());
      adapter = new DriveAdapter(props);
    });

    it("findByName: 途中のフォルダが無ければ [] を返し、フォルダを作成しない", () => {
      const result = adapter.findByName("経費証憑/紙/2026/09", "x.jpg");
      expect(result).toEqual([]);
      expect(root.getFoldersByName("経費証憑").hasNext()).toBe(false);
    });

    it("saveFile: 途中のフォルダを必要なだけ作成し、ファイルを保存する", () => {
      const info = adapter.saveFile({
        folderPath: "経費証憑/紙/2026/09",
        filename: "20260901_1200円_○○商店_R-20260901-001.jpg",
        bytes: [1, 2, 3, 4],
        mimeType: "image/jpeg",
      });

      expect(info.name).toBe("20260901_1200円_○○商店_R-20260901-001.jpg");
      expect(info.size).toBe(4);
      expect(info.trashed).toBe(false);
      expect(info.id).toBeTruthy();
      expect(info.url).toContain(info.id);

      // フォルダ階層（経費証憑/紙/2026/09）が実際に作られている。
      const level1 = root.getFoldersByName("経費証憑");
      expect(level1.hasNext()).toBe(true);
      const level2 = level1.next().getFoldersByName("紙");
      expect(level2.hasNext()).toBe(true);
    });

    it("saveFile を 2 回呼ぶと、同名でも 2 件のファイルができる（冪等性の保証はユースケース側の責務）", () => {
      // DrivePort 自体は「保存前に検索する」規律を強制しない（それは handleExpenseSubmit の
      // 責務。実装設計 §5.4）。アダプタ単体は素直に 2 回 createFile するだけであることを確認する。
      adapter.saveFile({ folderPath: "経費証憑/紙/2026/09", filename: "x.jpg", bytes: [1], mimeType: "image/jpeg" });
      adapter.saveFile({ folderPath: "経費証憑/紙/2026/09", filename: "x.jpg", bytes: [1, 2], mimeType: "image/jpeg" });

      const found = adapter.findByName("経費証憑/紙/2026/09", "x.jpg");
      expect(found).toHaveLength(2);
    });

    it("saveFile 後に findByName で同じファイルが見つかる（saga のフェーズ 3 が使う経路）", () => {
      const saved = adapter.saveFile({
        folderPath: "経費証憑/紙/2026/09",
        filename: "x.jpg",
        bytes: [1, 2, 3],
        mimeType: "image/jpeg",
      });

      const found = adapter.findByName("経費証憑/紙/2026/09", "x.jpg");
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe(saved.id);
      expect(found[0]?.size).toBe(3);
    });

    it("getById: 保存済みファイルの情報を返す", () => {
      const saved = adapter.saveFile({
        folderPath: "経費証憑/紙/2026/09",
        filename: "x.jpg",
        bytes: [1, 2],
        mimeType: "image/jpeg",
      });

      expect(adapter.getById(saved.id)).toEqual(saved);
    });

    it("getById: 存在しない ID は null を返す", () => {
      expect(adapter.getById("not-exist")).toBeNull();
    });

    it("getById: 削除済み（trashed）のファイルも trashed:true として返す（週次照合の「消えた証憑」検出用）", () => {
      const saved = adapter.saveFile({
        folderPath: "経費証憑/紙/2026/09",
        filename: "x.jpg",
        bytes: [1],
        mimeType: "image/jpeg",
      });
      app.fileById(saved.id).setTrashedForTest(true);

      const found = adapter.getById(saved.id);
      expect(found?.trashed).toBe(true);
    });

    it("findByName: 既存フォルダに事前登録したファイルが見つかる（保存せず植えたケース）", () => {
      const folder = root.plantFolder("経費証憑").plantFolder("電子取引").plantFolder("2026").plantFolder("09");
      const planted = folder.plantFile("existing.pdf", [9, 9, 9, 9], "application/pdf");

      const found = adapter.findByName("経費証憑/電子取引/2026/09", "existing.pdf");
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe(planted.getId());
      expect(found[0]?.size).toBe(4);
    });
  });
});
