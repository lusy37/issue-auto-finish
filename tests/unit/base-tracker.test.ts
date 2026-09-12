import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as atomicFile from "../../src/utils/atomicFile.js";
import { DiaryStore } from "../../src/distill/DiaryStore.js";
import type { DiaryEntry } from "../../src/distill/types.js";

/** Tracker 验证业务错误传播与启动清理；底层写入故障由 atomic-file 回归覆盖。 */
describe("BaseTracker 持久化边界", () => {
  let dir: string;
  const entry = (id: string): DiaryEntry => ({
    id, kind: "phase-summary", issueIid: 1, phase: "plan", title: "测试", content: "内容",
    createdAt: new Date().toISOString(), distilled: false,
  });
  beforeEach(() => {
    const root = path.resolve(".iaf-mini/tracker-tests");
    fs.mkdirSync(root, { recursive: true });
    dir = fs.mkdtempSync(path.join(root, "存储 "));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("保存失败时包装错误并保留 code、errno、syscall、path 和 cause", () => {
    const store = new DiaryStore(dir);
    const error = Object.assign(new Error("磁盘配额不足"), {
      code: "EDQUOT", errno: -122, syscall: "write", path: path.join(dir, "临时文件"),
    });
    vi.spyOn(atomicFile, "writeJsonAtomicSync").mockImplementation(() => { throw error; });
    let caught: unknown;
    try { store.create(entry("失败")); } catch (failure) { caught = failure; }
    expect(caught).toMatchObject({ code: "EDQUOT", errno: -122, syscall: "write", path: error.path, cause: error });
    expect((caught as Error).message).toContain("diary-store");
    expect((caught as Error).message).toContain("磁盘配额不足");
  });

  it("保存失败后重启仍读取上次成功的状态", () => {
    const store = new DiaryStore(dir);
    store.create(entry("已保存"));
    vi.spyOn(atomicFile, "writeJsonAtomicSync").mockImplementation(() => {
      throw Object.assign(new Error("写入失败"), { code: "EIO" });
    });
    expect(() => store.create(entry("未保存"))).toThrow("写入失败");
    const restarted = new DiaryStore(dir);
    expect(restarted.get("已保存")).toBeDefined();
    expect(restarted.get("未保存")).toBeUndefined();
  });

  it("启动清理本 Tracker 的新旧临时文件，并保留其他文件", () => {
    const stale = [".diary-store-12345-1700000000000.tmp", "diaries.json.tmp-1234567890abcdef"];
    const keep = [".other-tracker-1.tmp", "other.json.tmp-1234567890abcdef", "diaries.json.tmp-backup"];
    for (const name of [...stale, ...keep]) fs.writeFileSync(path.join(dir, name), "{}");
    new DiaryStore(dir);
    for (const name of stale) expect(fs.existsSync(path.join(dir, name))).toBe(false);
    for (const name of keep) expect(fs.existsSync(path.join(dir, name))).toBe(true);
  });

  it("临时文件目录读取失败不阻止启动", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("目录被占用"); });
    expect(() => new DiaryStore(dir)).not.toThrow();
  });
});
