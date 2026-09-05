import fs from "node:fs";
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
/** Windows 的索引器可能短暂占用 JSON 文件；有限重试原子替换，绝不先删除旧文件。 */
export function replaceFileSync(temporary: string, destination: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, destination);
      return;
    } catch (error) {
      if (
        attempt >= 5 ||
        !["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      Atomics.wait(waitBuffer, 0, 0, 10 * 2 ** attempt);
    }
  }
}
