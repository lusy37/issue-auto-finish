import { it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { replaceFileSync } from "../../src/utils/atomicFile.js";
it("文件被短暂占用后重试替换；永久错误保留旧数据并向上传播", () => {
  const root = path.resolve(".iaf-mini/atomic-tests");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "文件 ")),
    target = path.join(dir, "state.json"),
    tmp = target + ".tmp";
  fs.writeFileSync(target, "旧数据");
  fs.writeFileSync(tmp, "新数据");
  const original = fs.renameSync;
  const rename = vi
    .spyOn(fs, "renameSync")
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("文件被占用"), { code: "EPERM" });
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("文件被占用"), { code: "EBUSY" });
    })
    .mockImplementation(original);
  try {
    replaceFileSync(tmp, target);
    expect(fs.readFileSync(target, "utf8")).toBe("新数据");
    expect(rename).toHaveBeenCalledTimes(3);
    fs.writeFileSync(tmp, "下一版");
    rename.mockImplementation(() => {
      throw Object.assign(new Error("磁盘错误"), { code: "EIO" });
    });
    expect(() => replaceFileSync(tmp, target)).toThrow("磁盘错误");
    expect(fs.readFileSync(target, "utf8")).toBe("新数据");
  } finally {
    rename.mockRestore();
  }
});
