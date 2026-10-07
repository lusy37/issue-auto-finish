import type { GitOperations } from '../git/GitOperations.js';
import { runProcess, splitCommand } from '../utils/process.js';
import type { VerifyAgentResult } from './VerifyResultCodec.js';
import fs from 'node:fs';
import path from 'node:path';

export type VerificationChecks = VerifyAgentResult['checks'];

/** 命令由工作台执行，AI 仅在只读沙箱中分析本轮凭证。 */
export async function runVerificationCommands(options: {
  workDir: string;
  git: GitOperations;
  commands: Record<keyof VerificationChecks, string>;
  timeoutMs: number;
  onOutput?: (text: string) => void;
}): Promise<VerificationChecks> {
  const before = await options.git.snapshotRepositoryContent();
  const checks = {} as VerificationChecks;
  let executionError: unknown;
  try {
    for (const name of ['lint', 'build', 'test'] as const) {
      const command = options.commands[name];
      options.onOutput?.(`\n[verify:${name}] ${command}\n`);
      let exitCode: number | null = null;
      let output: string;
      try {
        const [binary, ...args] = splitCommand(command);
        // npm 等会向父目录寻找项目；缺少清单时不能误执行工作台自身的脚本。
        const packageManager = path.basename(binary).toLowerCase().replace(/\.cmd$/, '');
        if (['npm', 'pnpm', 'yarn'].includes(packageManager) &&
          !fs.existsSync(path.join(options.workDir, 'package.json'))) {
          throw new Error('验证工作目录缺少 package.json，拒绝向父目录查找验证脚本');
        }
        const result = await runProcess(binary, args, {
          cwd: options.workDir,
          timeoutMs: options.timeoutMs,
          onOutput: options.onOutput,
        });
        exitCode = result.code;
        output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      } catch (error) {
        // 取消必须交还编排器，不能继续启动后续检查。
        if ((error as Error).message === '操作已取消') throw error;
        output = (error as Error).message;
      }
      const passed = exitCode === 0;
      checks[name] = {
        command,
        exitCode,
        status: passed ? 'passed' : 'failed',
        summary: `${name} ${passed ? '通过' : '失败'}，退出码 ${exitCode ?? '无法取得'}`,
        diagnostics: output ? [output.slice(-12_000)] : [],
      };
    }
  } catch (error) {
    executionError = error;
  }
  // 即使命令中断，也检查待交付内容；不在 finally 中覆盖原异常。
  const after = await options.git.snapshotRepositoryContent();
  if (before !== after) {
    throw new Error('验证命令修改了仓库源码、配置、测试或 Git 状态，请人工检查；验证阶段不得修复代码');
  }
  if (executionError) throw executionError;
  return checks;
}

/** 机器凭证作为报告的一部分持久化，避免展示旧轮次或模型虚构的结果。 */
export function renderVerificationEvidence(checks: VerificationChecks): string {
  return '# 本轮命令执行凭证\n\n' + Object.entries(checks).map(([name, check]) =>
    `## ${name}\n\n命令：${check.command}\n\n${check.summary}\n\n` +
    (check.diagnostics.length ? '```text\n' + check.diagnostics.join('\n') + '\n```' : '命令没有输出。'),
  ).join('\n\n');
}
