import { createRequire } from "node:module";
import path from "node:path";
import { spawnProcess, stopProcess, type ManagedProcess } from "../src/utils/process.js";
const require = createRequire(import.meta.url);
const children: ManagedProcess[] = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) stopProcess(child);
}
function start(entry: string, args: string[]) {
  const child = spawnProcess(process.execPath, [entry, ...args], { stdio: "inherit" });
  children.push(child);
  void child.then(result => {
    if (!stopping) {
      if (result.failed) console.error(result.message);
      process.exitCode = result.exitCode ?? (result.failed ? 1 : 0);
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
