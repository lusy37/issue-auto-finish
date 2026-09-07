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
const keys = [
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
    res.json({
      values: Object.fromEntries(
        keys.map((k) => [
          k,
          k === "GITHUB_TOKEN"
            ? ""
            : (values[k] ??
              (k === "CODEX_BINARY"
                ? config.ai.binary
                : k === "AI_MODEL"
                  ? config.ai.model
                  : k === "AI_PHASE_TIMEOUT_MS"
                    ? String(config.ai.phaseTimeoutMs)
                    : k === "UAT_CONFIG_FILE"
                      ? config.e2e.configFile
                      : k === "UAT_TIMEOUT_MS"
                        ? String(config.e2e.timeoutMs)
                        : k === "E2E_BASE_URL"
                          ? config.e2e.baseUrl
                          : k === "PREVIEW_ENABLED"
                            ? String(config.preview.enabled)
                            : k === "BASE_BRANCH"
                              ? config.project.baseBranch
                              : k === "PROJECT_WORK_DIR"
                                ? config.project.workDir
                                : k === "GIT_ROOT_DIR"
                                  ? config.project.gitRootDir
                                  : k === "PROJECT_SUBDIR"
                                    ? config.project.projectSubDir
                                    : k === "GITHUB_API_URL"
                                      ? config.github.apiUrl
                                      : k === "GITHUB_REPOSITORY"
                                        ? config.github.repository
                                        : k === "PREVIEW_BACKEND_COMMAND"
                                          ? config.preview.backendCommand
                                          : k === "PREVIEW_FRONTEND_COMMAND"
                                            ? config.preview.frontendCommand
                                            : k === "PREVIEW_FRONTEND_DIR"
                                              ? config.preview.frontendDir
                                              : "")),
        ]),
      ),
      restartRequired: true,
    });
  });
  router.put("/api/settings", (req, res, next) => {
    try {
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
      fs.writeFileSync(
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
