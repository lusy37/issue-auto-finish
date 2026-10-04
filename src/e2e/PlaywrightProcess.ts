import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runProcess } from '../utils/process.js';

export interface PlaywrightProcessOptions {
  runId: string;
  issueIid: number;
  dataDir: string;
  outputDir: string;
  workDir: string;
  configFile: string;
  browserChannel?: string;
  baseUrl: string;
  timeoutMs: number;
  signal: AbortSignal;
  onTemporaryFile?: (file: string, present: boolean) => void;
  onOutput?: (text: string) => void;
}

export interface PlaywrightProcessResult {
  report?: unknown;
  code: number | null;
  reportAvailable: boolean;
  commandLog: string;
  stderr: string;
  error?: string;
}

function wrapperSource(configFile: string, browserChannel?: string): string {
  const configImport = `./${path.basename(configFile)}`;
  const channel = JSON.stringify(browserChannel ?? null);
  return [
    `import original from ${JSON.stringify(configImport)};`,
    'const config = original ?? {};',
    `const browserChannel = ${channel};`,
    "const forcedUse = { ...config.use, browserName: 'chromium', screenshot: 'on',",
    "  ...(browserChannel ? { channel: browserChannel } : {}) };",
    "const projects = config.projects?.map((project) => ({",
    "  ...project, use: { ...config.use, ...project.use, browserName: 'chromium',",
    "    screenshot: 'on', ...(browserChannel ? { channel: browserChannel } : {}) },",
    '}));',
    'export default { ...config, use: forcedUse, ...(projects ? { projects } : {}) };',
  ].join('\n');
}

async function resolvePlaywrightCli(config: string): Promise<string> {
  try {
    return path.join(path.dirname(createRequire(config).resolve('playwright/package.json')), 'cli.js');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw cause;
    const packageFile = createRequire(import.meta.url).resolve('playwright/package.json');
    return path.join(path.dirname(packageFile), 'cli.js');
  }
}

/** 只负责启动 Playwright、读取本轮报告和清理临时配置。 */
export async function runPlaywrightProcess(
  options: PlaywrightProcessOptions,
): Promise<PlaywrightProcessResult> {
  const config = path.resolve(options.workDir, options.configFile);
  const reportPath = path.join(options.outputDir, 'results.json');
  const wrapper = path.join(path.dirname(config), `.iaf-uat-${options.runId}.config.ts`);
  let commandLog = '';
  let stderr = '';
  let code: number | null = null;
  let reportAvailable = false;

  try {
    if (!fs.existsSync(config)) throw new Error(`找不到 Playwright 配置：${config}`);
    const cli = await resolvePlaywrightCli(config);
    const browserChannel = options.browserChannel || process.env.PLAYWRIGHT_CHANNEL;
    options.onTemporaryFile?.(wrapper, true);
    fs.writeFileSync(wrapper, wrapperSource(config, browserChannel));
    const command = await runProcess(
      process.execPath,
      [
        cli,
        'test',
        '--config',
        wrapper,
        '--reporter=json,html',
        '--output',
        path.join(options.outputDir, 'artifacts'),
        '--retries=0',
      ],
      {
        cwd: options.workDir,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        onOutput: (text) => {
          commandLog = (commandLog + text).slice(-2_000_000);
          options.onOutput?.(text);
        },
        env: {
          ...process.env,
          CI: '1',
          UAT_BASE_URL: options.baseUrl,
          PLAYWRIGHT_CHANNEL: browserChannel,
          IAF_VISUAL_CASES_FILE: path.join(
            options.dataDir,
            'issues',
            String(options.issueIid),
            'uat',
            'visual-cases.json',
          ),
          PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(options.outputDir, 'report'),
          PLAYWRIGHT_HTML_OPEN: 'never',
        },
      },
    );
    code = command.code;
    stderr = command.stderr;
    if (!fs.existsSync(reportPath)) {
      throw new Error(`本次验收没有生成报告：${command.stderr.slice(-500)}`);
    }
    reportAvailable = fs.existsSync(path.join(options.outputDir, 'report', 'index.html'));
    return {
      report: JSON.parse(fs.readFileSync(reportPath, 'utf8')) as unknown,
      code,
      reportAvailable,
      commandLog,
      stderr,
    };
  } catch (error) {
    return {
      code,
      reportAvailable,
      commandLog,
      stderr,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (fs.existsSync(wrapper)) fs.rmSync(wrapper, { force: true });
    options.onTemporaryFile?.(wrapper, false);
  }
}
