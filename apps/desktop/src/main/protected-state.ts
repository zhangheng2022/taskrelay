import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 仅 Main 可访问的系统加密暂存区。文件名不含账号信息；普通 journal 不保存状态正文。 */
export class ProtectedStateFiles {
  constructor(
    private directory: string,
    private encryption: {
      isEncryptionAvailable(): boolean;
      encryptString(value: string): Buffer;
      decryptString(value: Buffer): string;
    },
  ) {}
  /** 小型可靠回执内联密文；普通 journal 只接触密文，不依赖临时文件恢复。 */
  encrypt(value: unknown): string {
    if (!this.encryption.isEncryptionAvailable()) throw Error("OS_ENCRYPTION_UNAVAILABLE");
    return this.encryption.encryptString(JSON.stringify(value)).toString("base64");
  }
  decrypt(value: string): unknown {
    return JSON.parse(this.encryption.decryptString(Buffer.from(value, "base64")));
  }
  async put(value: unknown) {
    if (!this.encryption.isEncryptionAvailable()) throw Error("OS_ENCRYPTION_UNAVAILABLE");
    await mkdir(this.directory, { recursive: true });
    const id = randomUUID();
    await writeFile(
      path.join(this.directory, `${id}.state`),
      this.encryption.encryptString(JSON.stringify(value)),
    );
    return id;
  }
  async read(id: string) {
    this.validate(id);
    return JSON.parse(
      this.encryption.decryptString(await readFile(path.join(this.directory, `${id}.state`))),
    ) as unknown;
  }
  async remove(id: string) {
    this.validate(id);
    await unlink(path.join(this.directory, `${id}.state`)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async recover() {
    for (const name of await readdir(this.directory).catch(() => []))
      if (/^[a-f0-9-]{36}\.state$/.test(name)) await this.remove(name.slice(0, -6));
  }
  private validate(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("STATE_REFERENCE_INVALID");
  }
}
