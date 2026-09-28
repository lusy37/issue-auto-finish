import { t } from '../i18n/index.js';
import { getProjectKnowledge } from '../knowledge/index.js';
import { KNOWLEDGE_DEFAULTS } from '../knowledge/KnowledgeDefaults.js';
import type { ProjectKnowledge } from '../knowledge/ProjectKnowledge.js';
import type { DemandSpec } from '../demand/DemandSpec.js';
import type { RepoContext } from '../workspace/WorkspaceTypes.js';

export interface WorkspaceLayout {
  repos: RepoContext[];
  workspaceRoot: string;
}

export interface PromptContext {
  issueTitle: string;
  issueDescription: string;
  issueIid: number;
  supplementText?: string;
  workspace?: WorkspaceLayout;
  knowledgeEnabled?: boolean;
}

const PLAN_OUTPUT_CONSTRAINT = [
  '不要修改任何文件；结构化计划由服务端持久化并生成只读展示。',
  '所有内部任务共同完成一个父 Issue；任务只包含业务代码、文档、配置、测试等有效仓库变化。',
  '任务依赖使用 dependsOn，不能成环；所有任务完成后统一 verify、UAT 和 PR 交付。',
  '审核、Git 提交/推送和 PR 创建由工作台执行，不列为子任务。最终输出严格 JSON。',
].join('\n');

/**
 * Build template variable map from knowledge config (or defaults).
 */
export function getKnowledgeForPrompt(enabled = true): Record<string, string> {
  const k: ProjectKnowledge = getProjectKnowledge() ?? KNOWLEDGE_DEFAULTS;

  const codeStyleParts: string[] = [];
  if (k.codeStyle.indentStyle === 'spaces') {
    codeStyleParts.push(`${k.codeStyle.indentSize}空格缩进`);
  } else {
    codeStyleParts.push('Tab缩进');
  }
  codeStyleParts.push(`${k.codeStyle.lineWidth}字符行宽`);
  codeStyleParts.push('命名规范等');
  if (enabled && k.codeStyle.additionalRules?.length) {
    codeStyleParts.push(...k.codeStyle.additionalRules);
  }

  const knownIssueLines = enabled
    ? k.knownIssues.map(
        (issue) => `- ${issue.description}${issue.advice ? `，${issue.advice}` : ''}`,
      )
    : [];

  return {
    dependencyCheckPath: k.toolchain.dependencyCheckPath ?? 'node_modules/.bin/eslint',
    installCommand: k.toolchain.installCommand,
    installFallbackCommand:
      k.toolchain.installFallbackCommand ?? `${k.toolchain.installCommand} --ignore-scripts`,
    lintCommand: k.toolchain.lintCommand ?? 'npm run lint',
    buildCommand: k.toolchain.buildCommand ?? 'npm run build',
    testCommand: k.toolchain.testCommand ?? 'npm test',
    testFilesCommand:
      k.toolchain.testFilesCommand ??
      `${k.toolchain.testCommand ?? 'npm test'} -- <涉及变更的测试文件>`,
    knownIssuesSection:
      knownIssueLines.length > 0 ? knownIssueLines.join('\n') : '- 无已知预存问题',
    codeStyleDescription: enabled ? codeStyleParts.join('、') : '遵循项目现有代码风格',
    // E2E related
    e2eDir: k.structure.e2eDir ?? 'e2e',
    e2eTool: k.structure.e2eTool ?? 'E2E',
    frontendDir: k.structure.frontendDir ?? 'frontend',
  };
}

/**
 * 从 DemandSpec 构建 prompt 上下文，统一补充信息的格式化。
 */
export function demandToPromptContext(demand: DemandSpec): {
  title: string;
  description: string;
  displayId: string;
  supplementText: string;
} {
  const parts: string[] = [];
  const s = demand.supplement;
  if (s?.requirements?.trim()) parts.push(`### 补充需求说明\n${s.requirements.trim()}`);
  if (s?.acceptanceCriteria?.trim()) parts.push(`### 验收标准\n${s.acceptanceCriteria.trim()}`);
  if (s?.scope?.trim()) parts.push(`### 变更范围\n${s.scope.trim()}`);
  if (s?.constraints?.trim()) parts.push(`### 约束条件\n${s.constraints.trim()}`);
  if (s?.references?.trim()) parts.push(`### 参考链接\n${s.references.trim()}`);
  if (s?.freeText?.trim()) parts.push(`### 其他补充\n${s.freeText.trim()}`);
  return {
    title: demand.title,
    description: demand.description,
    displayId: demand.sourceRef.displayId ?? demand.demandId,
    supplementText: parts.length ? `## 补充信息\n\n${parts.join('\n\n')}` : '',
  };
}

export function planModeVerifyPrompt(ctx: PromptContext): string {
  const kv = getKnowledgeForPrompt(ctx.knowledgeEnabled);
  return `验证 Issue #${ctx.issueIid}：${ctx.issueTitle}\n${ctx.issueDescription}\n依次执行 ${kv.lintCommand}、${kv.buildCommand}、${kv.testCommand}，按实际命令结果判断。\n不要修改源码、配置、测试或计划，不要提交或推送，不要写报告文件；报告由服务端保存。临时文件用完后清理。最终回复完整 Markdown 报告，包含 **Lint 结果**: 通过/失败、**Build 结果**: 通过/失败、**Test 结果**: 通过/失败，并列出失败命令及诊断。没有实际执行或无法确定时必须报告失败。任务完成由服务端核对，不依赖计划中的勾选标记。\n项目检查说明：${kv.knownIssuesSection}`;
}

export function planPrompt(ctx: PromptContext): string {
  const supplementSection = ctx.supplementText ? `\n\n${ctx.supplementText}` : '';

  const outputInstruction = '请制定一份完整的实施计划，内容包括：';
  const outputConstraint = PLAN_OUTPUT_CONSTRAINT;

  const base = t('prompt.plan', {
    number: ctx.issueIid,
    title: ctx.issueTitle,
    description: ctx.issueDescription,
    supplement: supplementSection,
    outputInstruction,
    outputConstraint,
  });
  return base;
}

export interface ReviewRoundForPrompt {
  round: number;
  feedback: string;
  timestamp: string;
  /** 计划保持只读；驳回时携带上一轮快照和审核反馈。 */
  planSnapshot?: string;
}

/** 上轮完整快照属于审核契约，不能静默截断后让模型据不完整方案重新规划。 */
function buildRejectedPlanSection(snapshot: string | undefined): string {
  return snapshot
    ? `\n\n## 上一轮被驳回的完整实施计划\n\n<rejected-plan>\n${snapshot}\n</rejected-plan>`
    : '';
}

/** 计划保持只读；驳回时携带上一轮快照和审核反馈。 */
export function buildReviewFeedbackResumePrompt(
  history: ReviewRoundForPrompt[],
  supplementText?: string,
): string {
  if (history.length === 0) return '';
  const latest = history[history.length - 1];
  const allRoundsLines = history
    .map((r) =>
      t('prompt.rePlanRound', { round: r.round, timestamp: r.timestamp, feedback: r.feedback }),
    )
    .join('\n\n');
  const supplementSection = supplementText ? `\n\n${supplementText}` : '';
  const prompt = t('prompt.rePlanResume', {
    historyCount: history.length,
    latestFeedback: latest.feedback,
    allRoundsLines,
    supplement: supplementSection,
  });
  return `${prompt}\n\n${buildRejectedPlanSection(latest.planSnapshot)}\n\n${PLAN_OUTPUT_CONSTRAINT}`;
}

export function rePlanPrompt(ctx: PromptContext, history: ReviewRoundForPrompt[]): string {
  const supplementSection = ctx.supplementText ? `\n\n${ctx.supplementText}` : '';
  const feedbackLines = history
    .map((r) =>
      t('prompt.rePlanRound', { round: r.round, timestamp: r.timestamp, feedback: r.feedback }),
    )
    .join('\n\n');

  const latestSnapshot = history.length > 0 ? history[history.length - 1].planSnapshot : undefined;
  const rejectedPlanSection = buildRejectedPlanSection(latestSnapshot);

  const rePlanReadInstruction = rejectedPlanSection
    ? '请先阅读:\n- AGENTS.md (项目架构)\n\n上文已直接给出上一轮被驳回的方案全文，请基于该方案对照反馈做修改。'
    : '请先阅读:\n- AGENTS.md (项目架构)\n\n参考之前的审核反馈历史来改进计划。';
  const rePlanOutputInstruction =
    '请基于上一轮被驳回的实施计划做实质性修改：\n- 针对每条审核反馈给出可验证的调整（说明改了什么、为什么、影响范围）\n- 不要原样照搬被驳回方案，也不要只做措辞润色\n- 避免空洞口号（如"提升健壮性"），代之以具体的设计/接口/步骤/验收标准\n\n请输出修改后的完整新版结构化计划，使用规定的 JSON 字段。';
  const outputConstraint = PLAN_OUTPUT_CONSTRAINT;

  const base = t('prompt.rePlan', {
    number: ctx.issueIid,
    title: ctx.issueTitle,
    description: ctx.issueDescription,
    supplement: supplementSection,
    historyCount: history.length,
    feedbackLines,
    rePlanReadInstruction,
    rePlanOutputInstruction,
    outputConstraint,
    rejectedPlanSection,
  });
  return base;
}

export function issueProgressComment(phase: string, status: string, detail?: string): string {
  const emoji: Record<string, string> = {
    analysis: '🔍',
    design: '📐',
    implement: '💻',
    verify: '✅',
    plan: '📋',
    review: '👀',
    build: '🔨',
    uat: '🧪',
  };
  const icon = emoji[phase] || '📋';
  const statusKey =
    status === 'completed'
      ? 'progress.completed'
      : status === 'failed'
        ? 'progress.failed'
        : 'progress.inProgress';
  const statusText = t(statusKey);
  let msg = t('progress.comment', { icon, phase, status: statusText });
  if (detail) {
    msg += `\n\n${detail}`;
  }
  return msg;
}
