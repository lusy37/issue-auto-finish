import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonAtomicSync } from "../../src/utils/atomicFile.js";
import { runProcess } from "../../src/utils/process.js";

let dir: string;
beforeEach(() => {
  const root = path.resolve(".iaf-mini/atomic-tests");
  fs.mkdirSync(root, { recursive: true });
  dir = fs.mkdtempSync(path.join(root, "中文 文件 "));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** 在独立 Node 中注入文件系统故障，确保依赖实际执行重试、替换及失败清理。 */
async function fault(scenario: string) {
  const source = `
    import fs from 'node:fs';
    import path from 'node:path';
    const [target, scenario, moduleUrl] = process.argv.slice(1);
    fs.writeFileSync(target, JSON.stringify({value:'旧数据'}));
    const originalRename = fs.renameSync, originalWrite = fs.writeSync;
    let renames = 0, writes = 0;
    fs.renameSync = (...args) => {
      renames++;
      if (scenario === 'busy' || scenario === 'io' || scenario === 'retry' && renames <= 3) {
        const code = scenario === 'busy' ? 'EPERM' : scenario === 'io' ? 'EIO' : ['EPERM','EACCES','EBUSY'][renames-1];
        throw Object.assign(new Error('注入故障'), {code});
      }
      return originalRename(...args);
    };
    fs.writeSync = (...args) => {
      writes++;
      if (scenario === 'partial') {
        originalWrite(args[0], '部分数据');
        throw Object.assign(new Error('磁盘配额不足'), {code:'EDQUOT',errno:-122,syscall:'write'});
      }
      return originalWrite(...args);
    };
    const {writeJsonAtomicSync} = await import(moduleUrl);
    let error;
    const start = Date.now();
    try { writeJsonAtomicSync(target, {value:'新数据'}); }
    catch (caught) { error = {code:caught.code,errno:caught.errno,syscall:caught.syscall}; }
    const elapsed = Date.now()-start;
    const result = {value:JSON.parse(fs.readFileSync(target,'utf8')).value,error,elapsed,renames,writes,files:fs.readdirSync(path.dirname(target))};
    console.log(JSON.stringify(result));
  `;
  const result = await runProcess(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", source,
    path.join(dir, "state.json"), scenario, pathToFileURL(path.resolve("src/utils/atomicFile.ts")).href,
  ], { cwd: process.cwd(), timeoutMs: 15_000 });
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("原子 JSON 写入", () => {
  it("自动创建中文空格目录，同步返回后新数据可立即读取", () => {
    const target = path.join(dir, "新目录", "state.json");
    writeJsonAtomicSync(target, { value: "中文内容", number: 1 });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ value: "中文内容", number: 1 });
    expect(fs.readdirSync(path.dirname(target))).toEqual(["state.json"]);
  });

  it("序列化失败时保留旧文件且不生成临时文件", () => {
    const target = path.join(dir, "state.json");
    writeJsonAtomicSync(target, { value: "旧数据" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJsonAtomicSync(target, circular)).toThrow();
    expect(() => writeJsonAtomicSync(target, undefined)).toThrow("无法保存");
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ value: "旧数据" });
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  it("EPERM、EACCES、EBUSY 短暂占用后重试成功", async () => {
    const result = await fault("retry");
    expect(result).toMatchObject({ value: "新数据", renames: 4, files: ["state.json"] });
    expect(result.error).toBeUndefined();
  });

  it("持续占用时有限重试，失败保留旧数据并清理临时文件", async () => {
    const result = await fault("busy");
    expect(result).toMatchObject({ value: "旧数据", error: { code: "EPERM" }, files: ["state.json"] });
    expect(result.renames).toBeGreaterThan(1);
    expect(result.elapsed).toBeLessThan(2_000);
  });

  it("永久替换错误上抛且旧数据仍可读取", async () => {
    const result = await fault("io");
    expect(result).toMatchObject({ value: "旧数据", error: { code: "EIO" }, files: ["state.json"] });
  });

  it("部分写入后配额不足，旧数据与诊断信息均保留", async () => {
    const result = await fault("partial");
    expect(result).toMatchObject({ value: "旧数据", error: { code: "EDQUOT", errno: -122, syscall: "write" }, files: ["state.json"] });
    expect(result.writes).toBeGreaterThan(0);
    expect(result.renames).toBe(0);
  });
});
