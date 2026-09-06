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
}

function planDir(number: number): string {
  return `.claude-plan/issue-${number}`;
}

const PLAN_OUTPUT_CONSTRAINT = [
  '不要修改任何代码文件。',
  '实施 Todolist 只包含编码代理在 build/verify 阶段能够实际完成的代码、测试、文档与检查，步骤数量按需求复杂度确定。',
  '计划审核、正式 UAT、Git 提交/推送和 PR 创建由外层工作台执行，须放在独立的后续流程说明中，不能列为待勾选项；尤其不能要求在 verify 之前完成 PR 创建。',
  '本地浏览器自检可以列入实施清单，但不能替代工作台后续生成的正式 UAT 结果。',
].join('\n');

/**
 * Build template variable map from knowledge config (or defaults).
 */
export function getKnowledgeForPrompt(): Record<string, string> {
  const k: ProjectKnowledge = getProjectKnowledge() ?? KNOWLEDGE_DEFAULTS;

  const codeStyleParts: string[] = [];
  if (k.codeStyle.indentStyle === 'spaces') {
    codeStyleParts.push(`${k.codeStyle.indentSize}空格缩进`);
  } else {
    codeStyleParts.push('Tab缩进');
  }
  codeStyleParts.push(`${k.codeStyle.lineWidth}字符行宽`);
  codeStyleParts.push('命名规范等');
  if (k.codeStyle.additionalRules?.length) {
    codeStyleParts.push(...k.codeStyle.additionalRules);
  }

  const knownIssueLines = k.knownIssues.map(issue => `- ${issue.description}${issue.advice ? `，${issue.advice}` : ''}`);

  return {
    dependencyCheckPath: k.toolchain.dependencyCheckPath ?? 'node_modules/.bin/eslint',
    installCommand: k.toolchain.installCommand,
    installFallbackCommand: k.toolchain.installFallbackCommand ?? `${k.toolchain.installCommand} --ignore-scripts`,
    lintCommand: k.toolchain.lintCommand ?? 'npm run lint',
    buildCommand: k.toolchain.buildCommand ?? 'npm run build',
    testCommand: k.toolchain.testCommand ?? 'npm test',
    testFilesCommand: k.toolchain.testFilesCommand
      ?? `${k.toolchain.testCommand ?? 'npm test'} -- <涉及变更的测试文件>`,
    knownIssuesSection: knownIssueLines.length > 0
      ? knownIssueLines.join('\n')
      : '- 无已知预存问题',
    codeStyleDescription: codeStyleParts.join('、'),
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
  if (s?.requirements) parts.push(`### 补充需求说明\n${s.requirements}`);
  if (s?.acceptanceCriteria) parts.push(`### 验收标准\n${s.acceptanceCriteria}`);
  if (s?.scope) parts.push(`### 变更范围\n${s.scope}`);
  if (s?.constraints) parts.push(`### 约束条件\n${s.constraints}`);
  if (s?.references) parts.push(`### 参考链接\n${s.references}`);
  if (s?.freeText) parts.push(`### 其他补充\n${s.freeText}`);
  return {
    title: demand.title,
    description: demand.description,
    displayId: demand.sourceRef.displayId ?? demand.demandId,
    supplementText: parts.length ? `## 补充信息\n\n${parts.join('\n\n')}` : '',
  };
}

export function planModeVerifyPrompt(ctx: PromptContext): string {
  const pd = planDir(ctx.issueIid);
  const kv = getKnowledgeForPrompt();
  const base = t('prompt.planModeVerify', {
    number: ctx.issueIid,
    title: ctx.issueTitle,
    planDir: pd,
    ...kv,
  });
  return base;
}

export function planPrompt(ctx: PromptContext): string {
  const supplementSection = ctx.supplementText ? `\n\n${ctx.supplementText}` : '';
  const pd = planDir(ctx.issueIid);

  const outputInstruction = '请制定一份完整的实施计划，内容包括：';
  const outputConstraint = PLAN_OUTPUT_CONSTRAINT;

  const base = t('prompt.plan', {
    number: ctx.issueIid,
    title: ctx.issueTitle,
    description: ctx.issueDescription,
    supplement: supplementSection,
    planDir: pd,
    outputInstruction,
    outputConstraint,
  });
  return base;
}

export function buildPrompt(ctx: PromptContext): string {
  const pd = planDir(ctx.issueIid);
  const kv = getKnowledgeForPrompt();
  const base = t('prompt.build', {
    number: ctx.issueIid,
    title: ctx.issueTitle,
    planDir: pd,
    ...kv,
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

/** Plan-snapshot 注入上限（字符数），防止 prompt 过长压爆上下文。 */
export const REJECTED_PLAN_SNAPSHOT_MAX_CHARS = 8000;

/** 把 snapshot 安全截断后包裹在 `<rejected-plan>` 块中。截断时附加省略提示。 */
function buildRejectedPlanSection(snapshot: string | undefined): string {
  if (!snapshot) return '';
  let body = snapshot;
  let truncatedNote = '';
  if (body.length > REJECTED_PLAN_SNAPSHOT_MAX_CHARS) {
    body = body.slice(0, REJECTED_PLAN_SNAPSHOT_MAX_CHARS);
    truncatedNote = `\n<!-- 旧方案过长，已截断至 ${REJECTED_PLAN_SNAPSHOT_MAX_CHARS} 字符 -->`;
  }
  return `\n\n## 上一轮被驳回的实施计划（请基于此做实质性修改，避免与原方案高度雷同）\n\n<rejected-plan>\n${body}\n</rejected-plan>${truncatedNote}`;
}

/** 计划保持只读；驳回时携带上一轮快照和审核反馈。 */
export function buildReviewFeedbackResumePrompt(
  history: ReviewRoundForPrompt[],
  supplementText?: string,
): string {
  if (history.length === 0) return '';
  const latest = history[history.length - 1];
  const allRoundsLines = history.map(
    r => t('prompt.rePlanRound', { round: r.round, timestamp: r.timestamp, feedback: r.feedback }),
  ).join('\n\n');
  const supplementSection = supplementText ? `\n\n${supplementText}` : '';
  const prompt = t('prompt.rePlanResume', {
    historyCount: history.length,
    latestFeedback: latest.feedback,
    allRoundsLines,
    supplement: supplementSection,
  });
  return `${prompt}\n\n${PLAN_OUTPUT_CONSTRAINT}`;
}

export function rePlanPrompt(ctx: PromptContext, history: ReviewRoundForPrompt[]): string {
  const supplementSection = ctx.supplementText ? `\n\n${ctx.supplementText}` : '';
  const pd = planDir(ctx.issueIid);
  const feedbackLines = history.map(
    r => t('prompt.rePlanRound', { round: r.round, timestamp: r.timestamp, feedback: r.feedback })
  ).join('\n\n');

  const latestSnapshot = history.length > 0 ? history[history.length - 1].planSnapshot : undefined;
  const rejectedPlanSection = buildRejectedPlanSection(latestSnapshot);

  const rePlanReadInstruction = (rejectedPlanSection
        ? '请先阅读:\n- AGENTS.md (项目架构)\n\n上文已直接给出上一轮被驳回的方案全文，请基于该方案对照反馈做修改。'
        : '请先阅读:\n- AGENTS.md (项目架构)\n\n参考之前的审核反馈历史来改进计划。');
  const rePlanOutputInstruction = '请基于上一轮被驳回的实施计划做实质性修改：\n- 针对每条审核反馈给出可验证的调整（说明改了什么、为什么、影响范围）\n- 不要原样照搬被驳回方案，也不要只做措辞润色\n- 避免空洞口号（如"提升健壮性"），代之以具体的设计/接口/步骤/验收标准\n\n请输出修改后的完整新版实施计划，保持相同的文档结构。';
  const outputConstraint = PLAN_OUTPUT_CONSTRAINT;

  const base = t('prompt.rePlan', {
    number: ctx.issueIid,
    title: ctx.issueTitle,
    description: ctx.issueDescription,
    supplement: supplementSection,
    historyCount: history.length,
    feedbackLines,
    planDir: pd,
    rePlanReadInstruction,
    rePlanOutputInstruction,
    outputConstraint,
    rejectedPlanSection,
  });
  return base;
}

export interface E2ePromptPorts {
  backendPort: number;
  frontendPort: number;
  host: string;
}

export interface ConflictResolveContext {
  issueIid: number;
  branchName: string;
  baseBranch: string;
  conflictFiles: string[];
}

export function conflictResolvePrompt(ctx: ConflictResolveContext): string {
  const conflictFilesList = ctx.conflictFiles.map(f => `- \`${f}\``).join('\n');
  return t('prompt.conflictResolve', {
    number: ctx.issueIid,
    branch: ctx.branchName,
    baseBranch: ctx.baseBranch,
    conflictFilesList,
  });
}

export function issueProgressComment(phase: string, status: string, detail?: string): string {
  const emoji: Record<string, string> = {
    analysis: '🔍', design: '📐', implement: '💻', verify: '✅',
    plan: '📋', review: '👀', build: '🔨', uat: '🧪',
  };
  const icon = emoji[phase] || '📋';
  const statusKey = status === 'completed' ? 'progress.completed' : status === 'failed' ? 'progress.failed' : 'progress.inProgress';
  const statusText = t(statusKey);
  let msg = t('progress.comment', { icon, phase, status: statusText });
  if (detail) {
    msg += `\n\n${detail}`;
  }
  return msg;
}

/** 浏览器测试由服务端执行，AI 只负责维护验收脚本。 */
export function e2eVerifyPromptSuffix(ctx: PromptContext, ports?: E2ePromptPorts): string {
 return '\n\n## 浏览器验收\n请用公开 Playwright Test 补齐 Chromium 测试，覆盖 Issue #'+ctx.issueIid+' 的验收标准。'+(ports?'\n预览地址：http://'+ports.host+':'+ports.frontendPort:'')+'\n服务端会独立运行测试，并依据实际退出码及报告判定通过。请勿用文字声明代替测试结果。';
}
