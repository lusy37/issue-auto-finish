import fs from 'node:fs';
import path from 'node:path';
import type { AIRunner, StreamEvent } from '../ai-runner/AIRunner.js';
import { buildCallOptions, configuredCallPolicy } from '../ai-runner/CallPolicy.js';
import type { Config } from '../config.js';
import type { TaskPlan } from '../dag/contracts.js';
import type { DemandSpec } from '../demand/DemandSpec.js';
import type { VisualCasesManifest } from '../shared/workbench.js';
import { uatPreparationPrompt } from '../prompts/taskExecution.js';
import { readVisualCases, visualCasesPath } from './VisualEvidence.js';

export class UatPreparationError extends Error {
  constructor(message: string) {
    super(`UAT 准备文件缺失或无效：${message}`);
    this.name = 'UatPreparationError';
  }
}

interface PreparationContext {
  workDir: string;
  dataDir: string;
  issueIid: number;
  plan: TaskPlan;
  e2e: Pick<Config['e2e'], 'configFile' | 'visualReviewEnabled'>;
}

export interface UatPreparationFiles {
  acceptance: Map<string, string>;
  cases?: VisualCasesManifest;
}

/** 构建收尾和验收启动共用同一个文件契约，不以模型文字作为准备凭证。 */
export function validateUatPreparation(context: PreparationContext): UatPreparationFiles {
  const acceptance = new Map<string, string>();
  context.plan.acceptanceCriteria.forEach((item, index) => acceptance.set(`plan:${index}`, item));
  for (const task of context.plan.tasks) {
    task.acceptanceCriteria.forEach((item, index) => acceptance.set(`task:${task.id}:${index}`, item));
  }
  let file = path.resolve(context.workDir, context.e2e.configFile);
  try {
    if (!fs.existsSync(file)) throw new Error('缺少 Playwright 配置');
    if (!fs.statSync(file).isFile()) throw new Error('Playwright 配置不是文件');
    if (!context.e2e.visualReviewEnabled) return { acceptance };
    file = visualCasesPath(context.dataDir, context.issueIid);
    const cases = readVisualCases(file, context.plan.digest, new Set(acceptance.keys()));
    return { acceptance, cases };
  } catch (error) {
    throw new UatPreparationError(`${file}；${(error as Error).message}`);
  }
}

/** 仅创建当前 Issue 的授权目录；拒绝通过链接把写权限扩展到其他运行数据。 */
export function ensureUatWriteDirectory(dataDir: string, issueIid: number): string {
  if (!Number.isSafeInteger(issueIid) || issueIid < 1) {
    throw new UatPreparationError('Issue 编号必须是正整数');
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    let directory = fs.realpathSync(dataDir);
    for (const segment of ['issues', String(issueIid), 'uat']) {
      directory = path.join(directory, segment);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory);
      if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
        throw new Error(`额外写目录不能经过链接或非目录：${directory}`);
      }
    }
    return directory;
  } catch (error) {
    throw new UatPreparationError(`无法创建当前 Issue 的写目录；${(error as Error).message}`);
  }
}

/** 准备失败停在环境检查，不形成候选提交，也不进入业务代码修复循环。 */
export async function prepareUat(context: PreparationContext & {
  runner: AIRunner;
  ai: Config['ai'];
  demand: DemandSpec;
  onStreamEvent?: (event: StreamEvent) => void;
}): Promise<UatPreparationFiles> {
  try {
    return validateUatPreparation(context);
  } catch (error) {
    if (!(error instanceof UatPreparationError)) throw error;
    context.onStreamEvent?.({
      type: 'uat-preparation', content: error.message, timestamp: new Date().toISOString(),
    });
  }
  const directory = context.e2e.visualReviewEnabled
    ? ensureUatWriteDirectory(context.dataDir, context.issueIid) : undefined;
  const prepared = await context.runner.run({
    workDir: context.workDir,
    ...buildCallOptions(configuredCallPolicy(context.ai), 'uat-prepare'),
    additionalDirectories: directory ? [directory] : undefined,
    prompt: uatPreparationPrompt(
      context.demand, context.plan, context.e2e.configFile,
      directory ? path.join(directory, 'visual-cases.json') : undefined,
    ),
    onStreamEvent: context.onStreamEvent,
  });
  if (!prepared.success) {
    throw new UatPreparationError(prepared.errorMessage || '浏览器测试准备调用失败');
  }
  return validateUatPreparation(context);
}
