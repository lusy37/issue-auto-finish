import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url);
const children = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === "win32")
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  }
}
function start(entry, args) {
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.on("exit", (code) => {
    if (!stopping) {
      process.exitCode = code || 0;
      stop();
    }
  });
}
// 两个服务共用当前工作目录和配置；退出任一服务时清理另一个。
start(require.resolve("tsx/cli"), ["watch", "src/run.ts"]);
start(
  path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js"),
  ["--config", "src/web/frontend/vite.config.ts"],
);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
