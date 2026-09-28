import type { DemandSpec } from '../demand/DemandSpec.js';
import type { TaskDefinition, TaskPlan } from '../dag/contracts.js';

export function taskExecutionPrompt(plan: TaskPlan, task: TaskDefinition, rules = ''): string {
  return `${rules}\n实现当前父需求的一个内部任务。工作区已包含所有前置任务的已合并结果。不要推送代码、创建 PR 或修改 Git 分支；不写工作台运行产物。\n父需求与批准计划：\n${JSON.stringify(plan)}\n当前任务：\n${JSON.stringify(task)}`;
}

export function conflictRepairPrompt(plan: TaskPlan, files: readonly string[]): string {
  return `只修复当前 rebase 的冲突文件并暂存，不运行 rebase --continue，不提交或推送。保持已批准需求语义。冲突文件：${files.join(', ')}\n父需求与批准计划：\n${JSON.stringify(plan)}`;
}

export function integrationRepairPrompt(plan: TaskPlan, report: string, rules = ''): string {
  return `${rules}\n按已批准的计划修复集成代码。不要重跑任务图，不要推送或创建 PR。\n计划：${JSON.stringify(plan)}\n本轮验证失败报告：${report}`;
}

export function uatPreparationPrompt(
  demand: DemandSpec,
  plan: TaskPlan,
  configFile: string,
): string {
  return `为批准的需求补充 Playwright Chromium 验收测试和配置 ${configFile}。使用 process.env.UAT_BASE_URL 读取预览地址。不要运行验收，不写验收结论，不推送。需求：${JSON.stringify(demand)}\n批准计划与验收要求：${JSON.stringify(plan)}`;
}
