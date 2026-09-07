#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { ensureDir } from "../paths.js";
import { resolveConfigFilePath } from "../config.js";
import { createCodexClient } from "../ai-runner/CodexRunner.js";
import { findExecutable, runProcess } from "../utils/process.js";
const program = new Command()
  .name("issue-auto-finish")
  .description("AI Issue 面试展示工作台");
program
  .command("start")
  .description("以前台方式启动工作台")
  .action(async () => {
    const { main } = await import("../index.js");
    await main();
  });
program
  .command("init")
  .description("创建独立配置文件")
  .action(() => {
    const file = resolveConfigFilePath();
    ensureDir(path.dirname(file));
    if (fs.existsSync(file))
      throw new Error("配置已存在，请直接编辑或在工作台设置中修改");
    fs.writeFileSync(
      file,
      "GITHUB_API_URL=https://api.github.com\nGITHUB_TOKEN=replace-me\nGITHUB_REPOSITORY=owner/repo\nPROJECT_WORK_DIR=" +
        process.cwd().replaceAll("\\", "/") +
        "\nBASE_BRANCH=main\nAI_RUNNER_MODE=codex\nCODEX_BINARY=\nAI_PHASE_TIMEOUT_MS=2700000\n",
    );
    console.log("已创建配置：" + file);
  });
program
  .command("doctor")
  .description("检查本机依赖")
  .action(async () => {
    const file = resolveConfigFilePath();
    const saved = fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
    for (const binary of [
      "node",
      "git",

    ]) {
      const found = findExecutable(binary);
      console.log(`${binary}: ${found || "未安装或未加入 PATH"}`);
      if (found) {
        const result = await runProcess(found, ["--version"], {
          cwd: process.cwd(),
          timeoutMs: 10000,
        });
        console.log(result.stdout.trim() || result.stderr.trim());
      }
    }
    try {
      createCodexClient(process.env.CODEX_BINARY || saved.CODEX_BINARY || "");
      console.log("Codex SDK：内置执行程序或自定义程序已就绪；登录请运行 npx codex login");
    } catch (error) {
      console.error("Codex SDK：" + (error as Error).message);
      process.exitCode = 1;
    }
    console.log("配置：" + resolveConfigFilePath());
  });
program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
