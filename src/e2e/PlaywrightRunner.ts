import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runProcess } from "../utils/process.js";
import { resolveDataDir, ensureDir } from "../paths.js";
export interface UatResult {
  runId: string;
  issueIid: number;
  passed: boolean;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  screenshots?: string[];
  reportAvailable?: boolean;
  startedAt: string;
  finishedAt: string;
  error?: string;
}
const active = new Map<number, AbortController>();
export function cancelUat(issueIid?: number): void {
  for (const [number, controller] of active)
    if (issueIid === undefined || number === issueIid) controller.abort();
}
/** 实际测试报告为唯一通过依据。 */
export function validateUatReport(report: unknown, code: number | null) {
  const value = report as {
    stats?: {
      expected?: number;
      unexpected?: number;
      flaky?: number;
      skipped?: number;
    };
    errors?: unknown[];
  } | null;
  const stats = value?.stats;
  if (
    !stats ||
    !["expected", "unexpected", "flaky", "skipped"].every(
      (key) =>
        Number.isInteger(stats[key as keyof typeof stats]) &&
        Number(stats[key as keyof typeof stats]) >= 0,
    )
  )
    throw new Error("Playwright 报告格式不完整");
  const passedTests = stats.expected!,
    failedTests = stats.unexpected! + stats.flaky!,
    skippedTests = stats.skipped!;
  return {
    passed:
      code === 0 &&
      passedTests > 0 &&
      failedTests === 0 &&
      !value?.errors?.length,
    passedTests,
    failedTests,
    skippedTests,
  };
}
export async function executeUat(options: {
  issueIid: number;
  workDir: string;
  configFile: string;
  baseUrl: string;
  timeoutMs: number;
  onOutput?: (text: string) => void;
}): Promise<UatResult> {
  if (active.has(options.issueIid)) throw new Error("该任务正在执行浏览器验收");
  const controller = new AbortController();
  active.set(options.issueIid, controller);
  const runId = randomUUID(),
    startedAt = new Date().toISOString();
  const outputDir = ensureDir(path.join(resolveDataDir(), "uat", runId));
  let result: UatResult = {
    runId,
    issueIid: options.issueIid,
    startedAt,
    finishedAt: startedAt,
    passed: false,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
  };
  let wrapper: string | undefined;
  try {
    const config = path.resolve(options.workDir, options.configFile);
    if (!fs.existsSync(config))
      throw new Error(`找不到 Playwright 配置：${config}`);
    // CLI 与配置、用例必须使用同一份 Playwright，否则独立仓库会出现 test() 上下文冲突。
    let playwrightPackage: string;
    try {
      playwrightPackage = createRequire(config).resolve("playwright/package.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
      playwrightPackage = createRequire(import.meta.url).resolve("playwright/package.json");
    }
    const cli = path.join(path.dirname(playwrightPackage), "cli.js");
    const reportPath = path.join(outputDir, "results.json");
    wrapper = path.join(
      path.dirname(config),
      ".iaf-uat-" + runId + ".config.ts",
    );
    const configImport = "./" + path.basename(config);
    fs.writeFileSync(
      wrapper,
      `import original from ${JSON.stringify(configImport)};
const config = original ?? {};
export default { ...config, use: {...config.use, browserName: 'chromium', screenshot: 'on'}, projects: config.projects?.map((p: any) => ({...p, use: {...config.use, ...p.use, browserName: 'chromium', screenshot: 'on'}})) };
`,
    );
    const command = await runProcess(
      process.execPath,
      [
        cli,
        "test",
        "--config",
        wrapper,
        "--reporter=json,html",
        "--output",
        path.join(outputDir, "artifacts"),
        "--retries=0",
      ],
      {
        cwd: options.workDir,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        onOutput: options.onOutput,
        env: {
          ...process.env,
          CI: "1",
          UAT_BASE_URL: options.baseUrl,
          PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(outputDir, "report"),
          PLAYWRIGHT_HTML_OPEN: "never",
        },
      },
    );
    if (!fs.existsSync(reportPath))
      throw new Error(`本次验收没有生成报告：${command.stderr.slice(-500)}`);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    result = { ...result, ...validateUatReport(report, command.code) };
    if (!result.passed) {
      const messages: string[] = [];
      const collectErrors = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(collectErrors);
          return;
        }
        for (const [key, item] of Object.entries(value)) {
          if (key === "error" || key === "errors") {
            const errors = Array.isArray(item) ? item : [item];
            for (const error of errors)
              if (error?.message) messages.push(String(error.message));
          } else if (typeof item === "object") collectErrors(item);
        }
      };
      collectErrors(report);
      result.error =
        [...new Set(messages)].join("\n").slice(0, 2000) ||
        command.stderr.slice(-1000) ||
        "没有实际通过的测试，请查看本次报告";
    }
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    active.delete(options.issueIid);
    if (wrapper) fs.rmSync(wrapper, { force: true });
  }
  const listImages = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isSymbolicLink()
          ? []
          : entry.isDirectory()
            ? listImages(path.join(dir, entry.name))
            : /\.(png|jpe?g|webp)$/i.test(entry.name)
              ? [
                  path
                    .relative(outputDir, path.join(dir, entry.name))
                    .split(path.sep)
                    .join("/"),
                ]
              : [],
      );
  result.screenshots = listImages(outputDir);
  result.reportAvailable = fs.existsSync(
    path.join(outputDir, "report", "index.html"),
  );
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(outputDir, "summary.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
