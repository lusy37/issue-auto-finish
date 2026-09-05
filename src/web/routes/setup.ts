import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { resolveConfigFilePath, type Config } from "../../config.js";
import { envSchema, extractEnvSubset } from "../../config-schema.js";
import { findExecutable, runProcess } from "../../utils/process.js";
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
    res.json({ checks });
  });
  return router;
}
