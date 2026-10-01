#!/usr/bin/env node
import { AI_DEFAULTS, PREVIEW_DEFAULTS, PROJECT_DEFAULTS } from '../shared/runtime/defaults.js';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { ensureDir } from '../paths.js';
import { resolveConfigFilePath } from '../config.js';
import { createCodexClient } from '../ai-runner/CodexRunner.js';
import { findExecutable, runProcess } from '../utils/process.js';
const program = new Command().name('issue-auto-finish').description('AI Issue 展示工作台');

function createInitialConfig(projectWorkDir: string): string {
  const normalizedWorkDir = projectWorkDir.replaceAll('\\', '/');
  return (
    [
      '# GitHub 配置',
      `GITHUB_API_URL=${PROJECT_DEFAULTS.githubApiUrl}`,
      'GITHUB_TOKEN=replace-me',
      'GITHUB_REPOSITORY=owner/repo',
      `PROJECT_WORK_DIR=${normalizedWorkDir}`,
      `BASE_BRANCH=${PROJECT_DEFAULTS.baseBranch}`,
      '',
      '# Codex SDK 配置',
      'AI_RUNNER_MODE=codex',
      'CODEX_BINARY=',
      'AI_MODEL=',
      'CODEX_WINDOWS_SANDBOX=elevated',
      `AI_PHASE_TIMEOUT_MS=${AI_DEFAULTS.phaseTimeoutMs}`,
      'AI_IDLE_TIMEOUT_MS=1200000',
      'PHASE_TIMEOUT_GRACE_MS=60000',
      'PHASE_TIMEOUT_EXTENSION_MS=600000',
      'PHASE_TIMEOUT_MAX_EXTENSIONS=3',
      '',
      '# 轮询、并发与重试',
      'MAX_RETRIES=3',
      `AI_MAX_CONCURRENCY=${AI_DEFAULTS.maxConcurrency}`,
      `MAX_CONCURRENT_ISSUES=${PROJECT_DEFAULTS.maxConcurrentIssues}`,
      '',
      '# 审核与流程开关',
      'REVIEW_ENABLED=true',
      'REVIEW_AUTO_APPROVE_LABELS=',
      'KNOWLEDGE_ENABLED=true',
      'DISTILL_ENABLED=true',
      'DISTILL_MIN_DIARIES_FOR_DISTILL=3',
      'DISTILL_MEMORY_CONFIDENCE_THRESHOLD=0.7',
      'VERIFY_FIX_LOOP_ENABLED=true',
      'VERIFY_FIX_MAX_ITERATIONS=3',
      '',
      '# Web 工作台',
      'WEB_HOST=127.0.0.1',
      'WEB_PORT=3000',
      '',
      '# 浏览器验收',
      'E2E_UI_ENABLED=true',
      'PLAYWRIGHT_CHANNEL=msedge',
      'UAT_CONFIG_FILE=playwright.config.ts',
      'UAT_TIMEOUT_MS=300000',
      `E2E_BASE_URL=http://127.0.0.1:${PREVIEW_DEFAULTS.frontendPortBase}`,
      `E2E_BACKEND_PORT_BASE=${PREVIEW_DEFAULTS.backendPortBase}`,
      `E2E_FRONTEND_PORT_BASE=${PREVIEW_DEFAULTS.frontendPortBase}`,
      '',
      '# 预览服务',
      'PREVIEW_ENABLED=true',
      'PREVIEW_BACKEND_COMMAND=npm run dev:backend',
      'PREVIEW_FRONTEND_COMMAND=npm run dev:frontend -- --port {port}',
      'PREVIEW_FRONTEND_DIR=.',
      `PREVIEW_STARTUP_TIMEOUT_MS=${PREVIEW_DEFAULTS.startupTimeoutMs}`,
      `PREVIEW_READINESS_INTERVAL_MS=${PREVIEW_DEFAULTS.readinessIntervalMs}`,
      'PREVIEW_BACKEND_READY_URL=',
      'PREVIEW_FRONTEND_READY_URL=',
      'PREVIEW_KEEP_AFTER_COMPLETE=false',
      'PREVIEW_TTL_MS=86400000',
      'PREVIEW_REAP_INTERVAL_MS=300000',
      '',
      '# 工作区清理',
      'WORKTREE_CLEANUP_ENABLED=true',
      'WORKTREE_RETENTION_MS=604800000',
      'WORKTREE_CLEANUP_INTERVAL_MS=3600000',
      '',
    ].join('\n')
  );
}

program
  .command('start')
  .description('以前台方式启动工作台')
  .action(async () => {
    const { main } = await import('../index.js');
    await main();
  });
program
  .command('init')
  .description('创建独立配置文件')
  .action(() => {
    const file = resolveConfigFilePath();
    ensureDir(path.dirname(file));
    if (fs.existsSync(file)) throw new Error('配置已存在，请直接编辑或在工作台设置中修改');
    fs.writeFileSync(
      file,
      createInitialConfig(process.cwd()),
    );
    console.log('已创建配置：' + file);
  });
program
  .command('doctor')
  .description('检查本机依赖')
  .action(async () => {
    const file = resolveConfigFilePath();
    const saved = fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
    for (const binary of ['node', 'git']) {
      const found = findExecutable(binary);
      console.log(`${binary}: ${found || '未安装或未加入 PATH'}`);
      if (found) {
        const result = await runProcess(found, ['--version'], {
          cwd: process.cwd(),
          timeoutMs: 10000,
        });
        console.log(result.stdout.trim() || result.stderr.trim());
      }
    }
    try {
      createCodexClient(process.env.CODEX_BINARY || saved.CODEX_BINARY || '');
      console.log('Codex SDK：内置执行程序或自定义程序已就绪；登录请运行 npx codex login');
    } catch (error) {
      console.error('Codex SDK：' + (error as Error).message);
      process.exitCode = 1;
    }
    console.log('配置：' + resolveConfigFilePath());
  });
program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
