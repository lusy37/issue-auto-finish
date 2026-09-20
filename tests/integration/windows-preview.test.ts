import { it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { DevServerManager } from "../../src/preview/DevServerManager.js";
import { PortAllocator } from "../../src/preview/PortAllocator.js";

const isOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
async function until(check: () => Promise<boolean>, expected: boolean) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await check()) === expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("端口状态未在期限内变化");
}

it("中文空格目录中通过 cmd 启动预览，取消后清除进程树并释放两个端口", async () => {
  const root = path.resolve(".iaf-mini/preview-tests");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "中文 预览 "));
  vi.stubEnv("DATA_DIR", path.join(dir, "data"));
  const allocator = new PortAllocator({
      backendPortBase: 18000,
      frontendPortBase: 19000,
      maxPorts: 100,
    }),
    ports = await allocator.allocate(1);
  fs.writeFileSync(
    path.join(dir, "服务.mjs"),
    "import http from 'node:http';http.createServer((q,s)=>s.end('ok')).listen(Number(process.argv[2]),'127.0.0.1');",
  );
  fs.writeFileSync(
    path.join(dir, "启动.mjs"),
    "import {spawn} from 'node:child_process';spawn(process.execPath,['服务.mjs',process.argv[2]],{stdio:'inherit'});setInterval(()=>{},1000);",
  );
  fs.writeFileSync(
    path.join(dir, "启动.cmd"),
    '@echo off\r\n"' + process.execPath + '" "启动.mjs" %1\r\n',
  );
  const command =
    process.platform === "win32"
      ? { bin: path.join(dir, "启动.cmd"), args: ["{port}"] }
      : { bin: process.execPath, args: ["启动.mjs", "{port}"] };
  const manager = new DevServerManager({
    startupTimeoutMs: 10000,
    backendCommand: command,
    frontendCommand: command,
  });
  try {
    await manager.startServers(
      { issueIid: 1, branchName: "demo", gitRootDir: dir, workDir: dir },
      ports,
    );
    await until(() => isOpen(ports.backendPort), true);
    await until(() => isOpen(ports.frontendPort), true);
    expect(manager.getStatus(1).running).toBe(true);
    manager.stopServers(1);
    await until(() => isOpen(ports.backendPort), false);
    await until(() => isOpen(ports.frontendPort), false);
    expect(manager.getStatus(1).running).toBe(false);
  } finally {
    manager.stopAll();
    allocator.release(1);
    vi.unstubAllEnvs();
  }
}, 30000);
