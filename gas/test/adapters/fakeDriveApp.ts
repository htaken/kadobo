/**
 * `DriveApp`/`Utilities.newBlob` の最小フェイク（`gas/src/adapters/drive.ts` のテスト専用）。
 *
 * `DriveAdapter` が使う範囲（`getFolderById`/`getFileById`/`getFoldersByName`/`getFilesByName`/
 * `createFolder`/`createFile`）だけを実装する。同名の複数フォルダ・複数ファイルも作れるように
 * しておく（実装設計 経費フェーズ §5.4 の `DRIVE_CONFLICT`＝同名 2 件以上、を再現するため）。
 */

export class FakeDriveFile {
  private trashedFlag = false;

  constructor(
    private readonly id: string,
    private readonly name: string,
    private readonly bytes: number[],
    private readonly mimeType: string | null,
    private readonly createdAtMs: number,
  ) {}

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  getSize(): number {
    return this.bytes.length;
  }

  getDateCreated(): { getTime(): number } {
    const ms = this.createdAtMs;
    return { getTime: () => ms };
  }

  isTrashed(): boolean {
    return this.trashedFlag;
  }

  getUrl(): string {
    return `https://drive.google.com/file/d/${this.id}/view`;
  }

  // --- 以下はテスト専用（実 GAS の `File` には無い）。保存内容の検証・故障注入に使う。 ---

  bytesForTest(): number[] {
    return this.bytes;
  }

  mimeTypeForTest(): string | null {
    return this.mimeType;
  }

  setTrashedForTest(trashed: boolean): void {
    this.trashedFlag = trashed;
  }
}

class FakeItemIterator<T> {
  private index = 0;
  constructor(private readonly items: T[]) {}

  hasNext(): boolean {
    return this.index < this.items.length;
  }

  next(): T {
    const item = this.items[this.index];
    this.index++;
    if (item === undefined) {
      throw new Error("fake_drive_iterator_exhausted");
    }
    return item;
  }
}

interface FakeBlobLike {
  getBytes(): number[];
  getContentType(): string | null;
  getName(): string | null;
}

export class FakeDriveFolder {
  private readonly subfolderIds = new Map<string, string[]>();
  private readonly fileIds = new Map<string, string[]>();

  constructor(
    private readonly app: FakeDriveApp,
    private readonly id: string,
    private readonly name: string,
  ) {}

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  getFoldersByName(name: string): FakeItemIterator<FakeDriveFolder> {
    const ids = this.subfolderIds.get(name) ?? [];
    return new FakeItemIterator(ids.map((id) => this.app.folderById(id)));
  }

  createFolder(name: string): FakeDriveFolder {
    const folder = this.app.newFolder(name);
    const list = this.subfolderIds.get(name) ?? [];
    list.push(folder.getId());
    this.subfolderIds.set(name, list);
    return folder;
  }

  getFilesByName(name: string): FakeItemIterator<FakeDriveFile> {
    const ids = this.fileIds.get(name) ?? [];
    return new FakeItemIterator(ids.map((id) => this.app.fileById(id)));
  }

  createFile(blob: FakeBlobLike): FakeDriveFile {
    const name = blob.getName() ?? "untitled";
    const file = this.app.newFile(name, blob.getBytes(), blob.getContentType());
    const list = this.fileIds.get(name) ?? [];
    list.push(file.getId());
    this.fileIds.set(name, list);
    return file;
  }

  /** テスト専用: `DriveApp` を経由せず直接サブフォルダを作る（事前状態の準備用）。 */
  plantFolder(name: string): FakeDriveFolder {
    return this.createFolder(name);
  }

  /** テスト専用: `DriveApp` を経由せず直接ファイルを作る（`findByName` の事前登録用）。 */
  plantFile(name: string, bytes: number[], mimeType: string | null = null): FakeDriveFile {
    const file = this.app.newFile(name, bytes, mimeType);
    const list = this.fileIds.get(name) ?? [];
    list.push(file.getId());
    this.fileIds.set(name, list);
    return file;
  }
}

/** `globalThis.DriveApp` に据えるフェイク本体。`getFolderById`/`getFileById` が実体を引く。 */
export class FakeDriveApp {
  private nextId = 1;
  private readonly folders = new Map<string, FakeDriveFolder>();
  private readonly files = new Map<string, FakeDriveFile>();

  private genId(prefix: string): string {
    const id = `fake-drive-${prefix}-${this.nextId}`;
    this.nextId++;
    return id;
  }

  newFolder(name: string): FakeDriveFolder {
    const folder = new FakeDriveFolder(this, this.genId("folder"), name);
    this.folders.set(folder.getId(), folder);
    return folder;
  }

  newFile(name: string, bytes: number[], mimeType: string | null): FakeDriveFile {
    const file = new FakeDriveFile(this.genId("file"), name, bytes, mimeType, Date.now());
    this.files.set(file.getId(), file);
    return file;
  }

  /** `DriveAdapter`/`FakeDriveFolder` 内部から使う参照解決（実 API の `getFolderById` 相当）。 */
  folderById(id: string): FakeDriveFolder {
    const folder = this.folders.get(id);
    if (folder === undefined) {
      throw new Error(`fake_drive_folder_not_found:${id}`);
    }
    return folder;
  }

  /** 実 API の `getFileById` 相当。テストから保存済みファイルを直接検証するのにも使う。 */
  fileById(id: string): FakeDriveFile {
    const file = this.files.get(id);
    if (file === undefined) {
      throw new Error(`fake_drive_file_not_found:${id}`);
    }
    return file;
  }

  /** テスト側から「証憑ルートフォルダ」を作る。返り値の `getId()` を `DRIVE_RECEIPT_ROOT_ID` に設定する。 */
  createRootFolder(name = "経費証憑ルート"): FakeDriveFolder {
    return this.newFolder(name);
  }

  // --- `DriveApp` グローバルとして呼ばれるメソッド ---

  getFolderById(id: string): FakeDriveFolder {
    return this.folderById(id);
  }

  getFileById(id: string): FakeDriveFile {
    return this.fileById(id);
  }
}

/**
 * `globalThis.DriveApp`・`globalThis.Utilities`（`newBlob` のみ）にフェイクをインストールする。
 * `drive.ts` は `Utilities.newBlob(bytes, mimeType, filename)` でファイル内容の Blob を作るため、
 * `DriveApp` と合わせてここで用意する。`restore()` で元に戻す。
 */
export function installFakeDriveEnvironment(): { app: FakeDriveApp; restore: () => void } {
  const app = new FakeDriveApp();
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const previousDriveApp = globalRecord.DriveApp;
  const previousUtilities = globalRecord.Utilities;

  globalRecord.DriveApp = app;
  globalRecord.Utilities = {
    newBlob: (data: number[], contentType?: string, name?: string): FakeBlobLike => ({
      getBytes: () => data,
      getContentType: () => contentType ?? null,
      getName: () => name ?? null,
    }),
  };

  return {
    app,
    restore: () => {
      globalRecord.DriveApp = previousDriveApp;
      globalRecord.Utilities = previousUtilities;
    },
  };
}
