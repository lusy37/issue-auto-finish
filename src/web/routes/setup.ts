import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { resolveConfigFilePath, type Config } from "../../config.js";
import { envSchema, extractEnvSubset } from "../../config-schema.js";
import { findExecutable, runProcess } from "../../utils/process.js";
import { createCodexClient } from "../../ai-runner/CodexRunner.js";
import { createAIRunner, type AIRunner } from "../../ai-runner/index.js";
import { GitHubClient } from "../../clients/GitHubClient.js";
import { writeTextAtomicSync } from "../../utils/atomicFile.js";
const keys = [
  "MAX_CONCURRENT_ISSUES",
  "AI_MAX_CONCURRENCY",
  "MAX_RETRIES",
  "GITHUB_API_URL",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "PROJECT_WORK_DIR",
  "GIT_ROOT_DIR",
  "PROJECT_SUBDIR",
  "BASE_BRANCH",
  "CODEX_BINARY",
  "AI_MODEL",
  "AI_PHASE_TIMEOUT_MS",
  "UAT_CONFIG_FILE",
  "UAT_TIMEOUT_MS",
  "E2E_BASE_URL",
  "PREVIEW_ENABLED",
  "PREVIEW_BACKEND_COMMAND",
  "PREVIEW_FRONTEND_COMMAND",
  "PREVIEW_FRONTEND_DIR",
  "REVIEW_ENABLED",
  "KNOWLEDGE_ENABLED",
  "DISTILL_ENABLED",
  "VERIFY_FIX_LOOP_ENABLED",
  "VERIFY_FIX_MAX_ITERATIONS",
];
export function createSetupRouter(config: Config) {
  const router = Router();
  router.post("/api/settings/check-github", async (_req, res) => {
    try {
      const repository = await new GitHubClient(
        config.github,
      ).checkConnection();
      res.json({
        ok: true,
        message: `已连接 ${repository.fullName}，默认分支：${repository.defaultBranch}`,
      });
    } catch (error) {
      res.json({ ok: false, message: (error as Error).message });
    }
  });
  let checkingConnection = false;
  router.post("/api/settings/check-connection", async (_req, res) => {
    if (checkingConnection) {
      res.status(409).json({ error: "正在检查连接，请稍候" });
      return;
    }
    checkingConnection = true;
    let runner: AIRunner | undefined;
    try {
      runner = createAIRunner(config.ai);
      res.once("close", () => runner?.killAll());
      const result = await runner.run({
        prompt: "这是连接检查。不要调用工具，只回复 OK。",
        workDir: config.project.workDir,
        mode: "plan",
        timeoutMs: 30000,
      });
      const ok = result.success && result.output.trim().length > 0;
      res.json({
        ok,
        message: ok
          ? "Codex 已响应，当前模型连接可用"
          : result.errorMessage ||
            "Codex 未返回有效结果，请检查登录、网络和模型配置",
      });
    } catch (error) {
      res.json({ ok: false, message: (error as Error).message });
    } finally {
      runner?.killAll();
      checkingConnection = false;
    }
  });
  router.get("/api/settings", (_req, res) => {
    const file = resolveConfigFilePath();
    const values = fs.existsSync(file) ? parseEnv(fs.readFileSync(file)) : {};
    const defaults: Record<string, string | undefined> = {
      MAX_CONCURRENT_ISSUES: String(config.poll.maxConcurrent),
      AI_MAX_CONCURRENCY: String(config.ai.maxConcurrency),
      MAX_RETRIES: String(config.poll.maxRetries),
      GITHUB_API_URL: config.github.apiUrl,
      GITHUB_REPOSITORY: config.github.repository,
      PROJECT_WORK_DIR: config.project.workDir,
      GIT_ROOT_DIR: config.project.gitRootDir,
      PROJECT_SUBDIR: config.project.projectSubDir,
      BASE_BRANCH: config.project.baseBranch,
      CODEX_BINARY: config.ai.binary,
      AI_MODEL: config.ai.model,
      AI_PHASE_TIMEOUT_MS: String(config.ai.phaseTimeoutMs),
      UAT_CONFIG_FILE: config.e2e.configFile,
      UAT_TIMEOUT_MS: String(config.e2e.timeoutMs),
      E2E_BASE_URL: config.e2e.baseUrl,
      PREVIEW_ENABLED: String(config.preview.enabled),
      PREVIEW_BACKEND_COMMAND: config.preview.backendCommand,
      PREVIEW_FRONTEND_COMMAND: config.preview.frontendCommand,
      PREVIEW_FRONTEND_DIR: config.preview.frontendDir,
      REVIEW_ENABLED: String(config.review.enabled),
      KNOWLEDGE_ENABLED: String(config.knowledge.enabled),
      DISTILL_ENABLED: String(config.distill.enabled),
      VERIFY_FIX_LOOP_ENABLED: String(config.verifyFixLoop.enabled),
      VERIFY_FIX_MAX_ITERATIONS: String(config.verifyFixLoop.maxIterations),
    };
    res.json({
      values: Object.fromEntries(
        keys.map((k) => [
          k,
          k === "GITHUB_TOKEN"
            ? ""
            : (values[k] ?? defaults[k] ?? ""),
        ]),
      ),
      restartRequired: true,
    });
  });
  router.put("/api/settings", (req, res, next) => {
    try {
      if (req.body.values?.WEB_ENABLED !== undefined) {
        extractEnvSubset({ WEB_ENABLED: String(req.body.values.WEB_ENABLED) });
      }
      const file = resolveConfigFilePath();
      const old = fs.existsSync(file) ? parseEnv(fs.readFileSync(file)) : {};
      const values: Record<string, string> = {
        GITHUB_TOKEN: config.github.token,
        ...old,
      };
      for (const key of keys) {
        const value = req.body.values?.[key];
        if (typeof value !== "string") continue;
        if (key === "GITHUB_TOKEN" && !value) continue;
        if (/[\r\n']/.test(value))
          throw new Error("配置值不能包含换行或单引号");
        values[key] = value;
      }
      const checked = envSchema.safeParse(
        extractEnvSubset({ ...process.env, ...values }),
      );
      if (!checked.success)
        throw new Error(
          checked.error.issues.map((i) => `${i.path}: ${i.message}`).join("\n"),
        );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      delete values.WEB_ENABLED;
      writeTextAtomicSync(
        file,
        Object.entries(values)
          .map(([k, v]) => `${k}='${v}'`)
          .join("\n") + "\n",
      );
      res.json({ success: true, restartRequired: true });
    } catch (e) {
      next(e);
    }
  });
  router.get("/api/settings/check", async (_req, res) => {
    const checks = await Promise.all(
      ["node", "git"].map(async (binary) => {
        const executable = findExecutable(binary);
        if (!executable)
          return { name: binary, ok: false, message: "未安装或未加入 PATH" };
        try {
          const result = await runProcess(executable, ["--version"], {
            cwd: process.cwd(),
            timeoutMs: 10000,
          });
          return {
            name: binary,
            ok: result.code === 0,
            message: result.stdout.trim() || result.stderr.trim(),
          };
        } catch (e) {
          return { name: binary, ok: false, message: (e as Error).message };
        }
      }),
    );
    try {
      createCodexClient(config.ai.binary);
      checks.push({ name: "Codex SDK", ok: true, message: "执行程序已就绪；请用连接检查验证登录和模型" });
    } catch (error) {
      checks.push({ name: "Codex SDK", ok: false, message: (error as Error).message });
    }
    res.json({ checks });
  });
  return router;
}
