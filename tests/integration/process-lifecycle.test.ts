import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { findExecutable, runProcess } from "../../src/utils/process.js";

let cwd: string;
beforeEach(() => {
  const root = path.resolve(".iaf-mini/process-tests");
  fs.mkdirSync(root, { recursive: true });
  cwd = fs.mkdtempSync(path.join(root, "中文 空格 "));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(cwd, { recursive: true, force: true });
});

const isOpen = (port: number) => new Promise<boolean>(resolve => {
  const socket = net.connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

describe("进程入口的实际执行行为", () => {
  it("取消前已中止时不启动命令", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(process.execPath, ["-e", "require('fs').writeFileSync('执行标记','x')"], {
      cwd, signal: controller.signal,
    })).rejects.toThrow("操作已取消");
    expect(fs.existsSync(path.join(cwd, "执行标记"))).toBe(false);
  });

  it("工作目录不存在时上抛启动错误，不伪造退出码", async () => {
    await expect(runProcess(process.execPath, ["--version"], { cwd: path.join(cwd, "不存在") })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("非零退出码仍返回结果，并完整传递实时中文输出", async () => {
    let output = "";
    const result = await runProcess(process.execPath, ["-e", "console.log('中文 输出');console.error('失败原因');process.exitCode=7;"], {
      cwd, onOutput: text => { output += text; },
    });
    expect(result).toEqual({ code: 7, stdout: "中文 输出\n", stderr: "失败原因\n" });
    expect(output).toContain("中文 输出");
    expect(output).toContain("失败原因");
  });

  it("长日志仅截掉前部，命令仍正常完成", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(8100000)+'末尾');process.stderr.write('y'.repeat(2100000)+'结束');"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(8_000_000);
    expect(result.stderr).toHaveLength(2_000_000);
    expect(result.stdout.endsWith("末尾")).toBe(true);
    expect(result.stderr.endsWith("结束")).toBe(true);
  });

  it("查找程序支持 PATH 与 Windows 自定义 PATHEXT", () => {
    const name = process.platform === "win32" ? "自定义程序.IAF" : "自定义程序";
    const binary = path.join(cwd, name);
    fs.writeFileSync(binary, "占位文件");
    if (process.platform !== "win32") fs.chmodSync(binary, 0o755);
    vi.stubEnv("PATH", cwd);
    if (process.platform === "win32") vi.stubEnv("PATHEXT", ".IAF;.EXE");
    expect(findExecutable("自定义程序")).toBe(binary);
    expect(findExecutable("不存在的程序")).toBeUndefined();
  });

  it.each(["取消", "超时"])("%s时清理 cmd 启动的后代服务并释放端口", async mode => {
    fs.writeFileSync(path.join(cwd, "服务.mjs"), "import http from 'node:http';const server=http.createServer((q,s)=>s.end('ok'));server.listen(0,'127.0.0.1',()=>console.log('READY:'+server.address().port+':'+process.pid));");
    fs.writeFileSync(path.join(cwd, "启动.mjs"), "import {spawn} from 'node:child_process';spawn(process.execPath,['服务.mjs'],{stdio:'inherit'});setInterval(()=>{},1000);");
    fs.writeFileSync(path.join(cwd, "启动.cmd"), '@echo off\r\n"' + process.execPath + '" "启动.mjs"\r\n');
    const controller = new AbortController();
    let port = 0, pid = 0, output = "";
    let notifyReady!: () => void;
    const ready = new Promise<void>(resolve => { notifyReady = resolve; });
    const pending = runProcess(
      process.platform === "win32" ? path.join(cwd, "启动.cmd") : process.execPath,
      process.platform === "win32" ? [] : ["启动.mjs"],
      {
        cwd, signal: controller.signal, timeoutMs: 5_000,
        onOutput: text => {
          output += text;
          const match = output.match(/READY:(\d+):(\d+)/);
          if (match) { port = Number(match[1]); pid = Number(match[2]); notifyReady(); }
        },
      },
    ).then(
      result => new Error(
        `服务提前退出：退出码=${result.code}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
      ),
      error => error as Error,
    );
    try {
      await Promise.race([ready, pending.then(error => { throw error; })]);
      expect(await isOpen(port)).toBe(true);
      if (mode === "取消") controller.abort();
      expect((await pending)?.message).toContain(mode);
      const deadline = Date.now() + 5_000;
      while (await isOpen(port)) {
        if (Date.now() >= deadline) throw new Error("后代服务端口未释放");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await pending;
      // 断言失败时也只清理本测试记录的后代进程。
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
    }
  }, 20_000);
});
