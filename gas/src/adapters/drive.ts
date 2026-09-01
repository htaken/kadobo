/**
 * `DrivePort` の GAS 実装（実装設計 経費フェーズ §5.9, §5.4）。Script Property
 * `DRIVE_RECEIPT_ROOT_ID` を起点に `folderPath`（`/` 区切り、例 `経費証憑/紙/2026/09`）を辿る。
 *
 * `DRIVE_RECEIPT_ROOT_ID` が未設定なら例外を投げて停止する（fail closed。§5.9）。
 * ルートフォルダ自体の自動作成はしない（誤ったフォルダが乱立するのを防ぐため、手動作成が前提）。
 */
import type { DriveFileInfo, DrivePort, PropsPort } from "../app/ports";

function toFileInfo(file: GoogleAppsScript.Drive.File): DriveFileInfo {
  return {
    id: file.getId(),
    name: file.getName(),
    size: file.getSize(),
    createdAtMs: file.getDateCreated().getTime(),
    trashed: file.isTrashed(),
    url: file.getUrl(),
  };
}

export class DriveAdapter implements DrivePort {
  constructor(private readonly props: PropsPort) {}

  private rootFolder(): GoogleAppsScript.Drive.Folder {
    const rootId = this.props.get("DRIVE_RECEIPT_ROOT_ID");
    if (rootId === null || rootId === "") {
      throw new Error(
        "DRIVE_RECEIPT_ROOT_ID が未設定です（実装設計 経費フェーズ §5.9）。" +
          "証憑ルートフォルダを手動で作成し、Script Property に ID を設定してから経費機能を有効化してください。",
      );
    }
    return DriveApp.getFolderById(rootId);
  }

  /**
   * `folderPath`（`/` 区切り）をルートから辿る。`create` が `false` のとき、途中のフォルダが
   * 1 つでも無ければ `null`（`findByName` 用。未作成のフォルダを検索しても異常ではない）。
   * `create` が `true` のとき、無いフォルダは都度作成する（`saveFile` 用）。
   *
   * 同名フォルダが複数存在する場合は先頭の 1 件を使う（このフォルダ構成は本システムが
   * 自身で作成する前提のため、通常は起こらない）。
   */
  private resolveFolder(folderPath: string, create: boolean): GoogleAppsScript.Drive.Folder | null {
    let folder = this.rootFolder();
    for (const segment of folderPath.split("/").filter((s) => s !== "")) {
      const it = folder.getFoldersByName(segment);
      if (it.hasNext()) {
        folder = it.next();
        continue;
      }
      if (!create) {
        return null;
      }
      folder = folder.createFolder(segment);
    }
    return folder;
  }

  findByName(folderPath: string, filename: string): DriveFileInfo[] {
    const folder = this.resolveFolder(folderPath, false);
    if (folder === null) {
      return [];
    }
    const result: DriveFileInfo[] = [];
    const it = folder.getFilesByName(filename);
    while (it.hasNext()) {
      result.push(toFileInfo(it.next()));
    }
    return result;
  }

  saveFile(input: { folderPath: string; filename: string; bytes: number[]; mimeType: string }): DriveFileInfo {
    // create:true を渡すため resolveFolder は必ず Folder を返す（null にはならない）。
    const folder = this.resolveFolder(input.folderPath, true) as GoogleAppsScript.Drive.Folder;
    const blob = Utilities.newBlob(input.bytes, input.mimeType, input.filename);
    const file = folder.createFile(blob);
    return toFileInfo(file);
  }

  getById(fileId: string): DriveFileInfo | null {
    try {
      return toFileInfo(DriveApp.getFileById(fileId));
    } catch {
      // 削除・権限喪失等で取得できない場合。呼び出し側（週次照合）は「消えた証憑」として扱う。
      return null;
    }
  }
}
