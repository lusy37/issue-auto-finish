import { it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { executeUat } from "../../src/e2e/PlaywrightRunner.js";

it("真实 Playwright 的失败、零测试、全跳过和超时均不通过，旧报告不能复用", async () => {
  const root = path.resolve(".iaf-mini/uat-negative-tests");
  fs.mkdirSync(root, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(root, "验收 "));
  vi.stubEnv("DATA_DIR", path.join(workDir, "data"));
  fs.writeFileSync(
    path.join(workDir, "playwright.config.ts"),
    "export default {testDir:'.',testMatch:'acceptance.spec.ts',timeout:200};",
  );
  const configFile = "playwright.config.ts";
  const runIds = new Set<string>();
  try {
    for (const [name, body] of [
      ["通过", "test('正常',()=>expect(1).toBe(1));"],
      ["失败", "test('实际失败',()=>expect(1).toBe(2));"],
      ["全跳过", "test.skip('跳过',()=>{});"],
      ["零测试", ""],
      [
        "超时",
        "test('超时',async()=>{await new Promise(r=>setTimeout(r,1000));});",
      ],
    ]) {
      fs.writeFileSync(
        path.join(workDir, "acceptance.spec.ts"),
        "import {test,expect} from '@playwright/test';" + body,
      );
      const result = await executeUat({
        issueIid: 1,
        workDir,
        configFile,
        baseUrl: "http://127.0.0.1:9",
        // 允许 Windows 上的 Node/Playwright 冷启动；测试自身的 200ms 超时仍由上方配置验证。
        timeoutMs: 60000,
      });
      const machinePassed = result.playwrightExitCode === 0 && result.reportValid && result.passedTests > 0 && result.failedTests === 0 && result.reportErrors.length === 0 && !result.machineCancelled;
      expect(machinePassed, name + ": " + result.error).toBe(name === "通过");
      expect(runIds.has(result.runId)).toBe(false);
      runIds.add(result.runId);
    }
    const missing = await executeUat({
      issueIid: 1,
      workDir,
      configFile: "missing.config.ts",
      baseUrl: "http://127.0.0.1:9",
      timeoutMs: 1000,
    });
    expect(missing.reportValid).toBe(false);
    expect(missing.reportAvailable).toBe(false);
    expect(
      fs.existsSync(
        path.join(process.env.DATA_DIR!, "uat", missing.runId, "results.json"),
      ),
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
}, 300000);
