import type { DemandSpec } from '../demand/DemandSpec.js';
import type { TaskDefinition, TaskPlan } from '../dag/contracts.js';
import type { VisualRepairContext } from '../shared/workbench.js';
import { createHash } from 'node:crypto';

export function taskExecutionPrompt(plan: TaskPlan, task: TaskDefinition, rules = ''): string {
  return `${rules}\n实现当前父需求的一个内部任务。工作区已包含所有前置任务的已合并结果。不要推送代码、创建 PR 或修改 Git 分支；不写工作台运行产物。\n父需求与批准计划：\n${JSON.stringify(plan)}\n当前任务：\n${JSON.stringify(task)}`;
}

export function conflictRepairPrompt(plan: TaskPlan, files: readonly string[]): string {
  return `只修复当前 rebase 的冲突文件并暂存，不运行 rebase --continue，不提交或推送。保持已批准需求语义。冲突文件：${files.join(', ')}\n父需求与批准计划：\n${JSON.stringify(plan)}`;
}

export function integrationRepairPrompt(plan: TaskPlan, report: string, rules = ''): string {
  return `${rules}\n按已批准的计划修复集成代码。不要重跑任务图，不要推送或创建 PR。\n计划：${JSON.stringify(plan)}\n本轮验证失败报告：${report}`;
}

export function visualRepairPrompt(plan: TaskPlan, context: VisualRepairContext, rules = ''): string {
  const reportDigest = createHash('sha256').update(context.report).digest('hex');
  return `${rules}
处理当前 UAT 视觉证据缺口，只围绕该缺口和批准计划中的相关验收要求工作。不要修改验收结果文件，不要手动设置视觉状态，不要跳过 Verify 或 UAT，不要推送或创建 PR。
如果现有测试已证明该缺口属于行为证据，返回 behavior-covered，并至少引用一个当前候选提交上的通过测试；该决定必须覆盖缺口的全部 acceptanceRefs 且不要修改文件。需要明确可见状态时返回 add-visual-evidence 并补充该状态下的 Playwright 截图采集；截图确实显示界面实现问题时返回 fix-ui；当前图片或调用无法可靠判断时返回 retry-visual。动态行为使用自动化断言，不要为每条动态行为强行添加截图。
只返回符合指定 JSON Schema 的对象。testRefs.reportDigest 必须等于本轮报告摘要 ${reportDigest}。\n计划：${JSON.stringify(plan)}\n视觉缺口上下文：${JSON.stringify({ ...context, reportDigest })}`;
}

export function uatPreparationPrompt(
  demand: DemandSpec,
  plan: TaskPlan,
  configFile: string,
  visualCasesFile?: string,
): string {
  const visualInstructions = visualCasesFile
    ? `视觉用例清单是工作台运行数据，必须写入 ${visualCasesFile}，该文件的父目录已授予额外写权限，不要在业务仓库创建或提交 iaf.visual-cases.json，也不要仅把清单保存在临时目录。测试代码通过 process.env.IAF_VISUAL_CASES_FILE 读取清单。视觉用例清单必须使用 format=iaf-mini/visual-cases/v1、planDigest=${plan.digest}，每个场景列出必需视口和验收条目，expectedState 描述截图时实际可见的界面状态。需要视觉证据的测试在明确页面状态通过 testInfo.attach 附加图片（name=iaf-visual，contentType=image/png）及 JSON 元数据附件（name=iaf-visual-meta，字段 caseId、sceneId、viewport、pageUrl、acceptanceRefs）；不要依赖文件名识别场景。`
    : '视觉复核未启用，不需要生成或读取视觉用例清单。';
  return `为批准的需求补充 Playwright Chromium 验收测试和配置 ${configFile}。${visualInstructions}测试使用 process.env.UAT_BASE_URL 读取预览地址。点击计算、状态转换、接口行为和边界条件必须用自动化断言验证；截图只用于界面布局、样式和可见状态复核，不能代替行为断言，也不要要求每条动态逻辑单独提供截图。检查已有测试并补齐缺失采集能力，不要运行验收，不写验收结论，不推送。完成前确认配置和要求的清单已实际写入指定路径。需求：${JSON.stringify(demand)}\n批准计划与验收要求：${JSON.stringify(plan)}`;
}
