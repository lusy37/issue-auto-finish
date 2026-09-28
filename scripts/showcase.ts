import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../src/utils/atomicFile.js';
import { buildPlanModePipeline } from '../src/pipeline/PipelineMetadata.js';
import { IssueTracker } from '../src/tracker/IssueTracker.js';
import type { IssueLifecycle } from '../src/tracker/IssueLifecycle.js';
import type { PhaseProgress } from '../src/tracker/IssueRecord.js';
import { renderPlan, type PlanContent } from '../src/dag/contracts.js';
import { PlanPersistence } from '../src/persistence/PlanPersistence.js';
import { githubIssueToDemandSpec } from '../src/demand/adapters/GitHubAdapter.js';
import type { GitHubIssue } from '../src/clients/GitHubClient.js';
import type { UatResult } from '../src/shared/workbench.js';

const root = path.resolve(process.env.IAF_DEMO_DIR || '.iaf-mini/showcase-frontend-v6');
const dataDir = path.join(root, 'data');
const platformFile = path.join(root, 'platform.json');
const platformPort = process.env.IAF_DEMO_PLATFORM_PORT || '38081';
const phases = ['plan', 'review', 'build', 'verify', 'uat'] as const;
const now = new Date().toISOString();

const scenarios: Array<{
  number: number;
  title: string;
  description: string;
  lifecycle: IssueLifecycle;
  mergedTasks?: number;
  tasks?: PlanContent['tasks'];
  taskStates?: Record<string, 'pending' | 'running' | 'merged'>;
}> = [
  { number: 301, title: '[演示] 计划待审核：导入 CSV', description: '检查字段映射、错误处理与验收标准，再决定是否批准。', lifecycle: { kind: 'waiting', phase: 'review', planRevision: 1 }, mergedTasks: 0 },
  { number: 302, title: '[演示] 构建中：筛选与搜索', description: '任务依赖图中，首项已合并，第二项正在执行。', lifecycle: { kind: 'running', phase: 'build' }, mergedTasks: 1 },
  { number: 303, title: '[演示] 已暂停：等待验证', description: '保留已完成的构建进度，展示暂停和继续入口。', lifecycle: { kind: 'paused', phase: 'verify' }, mergedTasks: 3 },
  { number: 304, title: '[演示] 验收失败：移动端布局', description: '模拟浏览器断言不通过，等待人工确认修复。此记录不是真实 Playwright 结果。', lifecycle: { kind: 'failed', phase: 'uat', retry: 'manual', error: { message: '模拟断言失败：窄屏按钮被遮挡；仅作界面展示', retryable: 'hard-no-auto' } }, mergedTasks: 3 },
  { number: 305, title: '[演示] 已完成：计数器重置', description: '静态交付样例，仅展示完成状态，不代表真实 PR 或验收结果。', lifecycle: { kind: 'completed' }, mergedTasks: 3 },
  { number: 306, title: '[演示] 待启动：快捷键支持', description: '尚未进入计划阶段的需求，可查看空状态界面。', lifecycle: { kind: 'skipped' }, mergedTasks: 0 },
  { number: 307, title: '[演示] 已取消：旧版主题适配', description: '已取消任务样例，用于检查筛选和状态标签。', lifecycle: { kind: 'cancelled' }, mergedTasks: 0 },
  {
    number: 308,
    title: '[演示] 并行构建：工作台主题升级',
    description: '准备工作完成后，前端、后端和文档三个子任务可并发执行，最后汇合完成集成与验证。',
    lifecycle: { kind: 'running', phase: 'build' },
    tasks: [
      { id: 'prepare', title: '准备主题规范', instructions: '整理色板、组件约束和兼容范围。', acceptanceCriteria: ['形成可供各子任务使用的主题规范'], dependsOn: [] },
      { id: 'frontend', title: '更新前端组件', instructions: '按主题规范更新工作台组件和响应式样式。', acceptanceCriteria: ['主要页面使用新主题且保持可访问'], dependsOn: ['prepare'] },
      { id: 'backend', title: '补充主题配置接口', instructions: '提供主题配置读取和保存接口。', acceptanceCriteria: ['接口返回稳定的主题配置'], dependsOn: ['prepare'] },
      { id: 'docs', title: '编写迁移文档', instructions: '记录主题升级的配置方式和回滚步骤。', acceptanceCriteria: ['文档覆盖配置、迁移和回滚'], dependsOn: ['prepare'] },
      { id: 'integrate', title: '集成并联调', instructions: '汇合三个并行结果，处理跨模块兼容问题。', acceptanceCriteria: ['前后端和文档变更完成集成'], dependsOn: ['frontend', 'backend', 'docs'] },
      { id: 'verify', title: '执行回归验证', instructions: '运行测试并检查主题在主要视口下的表现。', acceptanceCriteria: ['回归测试和视口检查通过'], dependsOn: ['integrate'] },
    ],
    taskStates: { prepare: 'merged', frontend: 'running', backend: 'running', docs: 'running' },
  },
];

fs.mkdirSync(root, { recursive: true });
const platform: { issues: GitHubIssue[]; prs: unknown[]; notes: Record<string, unknown[]>; failedBranches: string[] } = fs.existsSync(platformFile)
  ? JSON.parse(fs.readFileSync(platformFile, 'utf8'))
  : { issues: [], prs: [], notes: {}, failedBranches: [] };
const pipeline = buildPlanModePipeline({ e2eEnabled: true });
const tracker = new IssueTracker(dataDir, new Map([[pipeline.mode, pipeline]]));

for (const scenario of scenarios) {
  const issue: GitHubIssue = {
    id: 10000 + scenario.number,
    number: scenario.number,
    title: scenario.title,
    description: scenario.description,
    state: 'open',
    labels: ['ui-showcase'],
    created_at: now,
    updated_at: now,
    author: { username: 'showcase', name: '界面演示' },
  };
  if (!platform.issues.some(existing => existing.number === scenario.number)) platform.issues.push(issue);
  if (tracker.get(scenario.number)) continue;

  tracker.create({
    lifecycle: { kind: 'skipped' },
    branchName: `showcase/issue-${scenario.number}`,
    pipelineMode: pipeline.mode,
    demandSpec: githubIssueToDemandSpec(issue),
  });
  if (scenario.lifecycle.kind === 'skipped' || scenario.lifecycle.kind === 'cancelled') {
    tracker.transaction(scenario.number, record => { record.lifecycle = scenario.lifecycle; });
    continue;
  }

  const plan: PlanContent = {
    title: scenario.title,
    description: scenario.description,
    acceptanceCriteria: ['功能符合需求范围', '运行单元测试和浏览器验收'],
    tasks: scenario.tasks ?? [
      { id: 'design', title: '梳理交互与边界', instructions: '整理用户操作流程和异常路径。', acceptanceCriteria: ['状态和错误信息清晰可见'], dependsOn: [] },
      { id: 'implement', title: '实现核心功能', instructions: '按计划实现界面与服务逻辑。', acceptanceCriteria: ['功能交互可用'], dependsOn: ['design'] },
      { id: 'test', title: '补齐自动化验证', instructions: '编写单元和浏览器交互测试。', acceptanceCriteria: ['关键路径有可重复执行的断言'], dependsOn: ['implement'] },
    ],
  };
  const savedPlan = tracker.store.savePlan(scenario.number, plan, tracker.get(scenario.number)!.run.version);
  const artifactStore = new PlanPersistence(path.join(root, 'worktrees', `issue-${scenario.number}`), scenario.number, dataDir, tracker);
  artifactStore.writePlan(renderPlan(savedPlan));
  artifactStore.writeIssueMeta({ id: issue.id, number: issue.number, title: issue.title, labels: issue.labels, state: issue.state });
  tracker.initPhaseProgress(scenario.number, pipeline);
  tracker.transaction(scenario.number, record => {
    record.lifecycle = scenario.lifecycle;
    record.run.review = { revision: savedPlan.revision, decision: scenario.lifecycle.kind === 'waiting' ? 'waiting' : 'approved' };
    record.run.buildGeneration = scenario.lifecycle.kind === 'waiting' ? 0 : 1;
    const currentPhase = 'phase' in scenario.lifecycle ? scenario.lifecycle.phase : undefined;
    const currentIndex = currentPhase ? phases.indexOf(currentPhase) : phases.length;
    for (const [index, phase] of phases.entries()) {
      const progress: PhaseProgress = index < currentIndex
        ? { status: 'completed', startedAt: now, completedAt: now }
        : index > currentIndex ? { status: 'pending' }
          : { status: scenario.lifecycle.kind === 'failed' ? 'failed' : phase === 'review' ? 'gate_waiting' : 'in_progress', startedAt: now };
      record.phaseProgress![phase] = progress;
    }
    const mergedTasks = scenario.mergedTasks ?? 0;
    for (const [index, task] of savedPlan.tasks.entries()) {
      const runTask = record.run.tasks[task.id];
      const requestedStatus = scenario.taskStates?.[task.id];
      if (requestedStatus === 'merged' || (!requestedStatus && index < mergedTasks)) {
        const identity = { issueNumber: scenario.number, planRevision: savedPlan.revision, buildGeneration: 1, dispatchId: 'showcase', taskId: task.id, attemptNo: 1, callId: `showcase-${task.id}` };
        const commit = 'a'.repeat(40);
        Object.assign(runTask, {
          status: 'merged', attemptNo: 1,
          success: { identity, completedAt: now, resultCommit: commit, noChange: false },
          merge: { operationId: `showcase-${task.id}`, stage: 'merged', preRebaseCommit: commit, integrationBefore: commit, postRebaseCommit: commit, integrationAfter: commit },
        });
      } else if (requestedStatus === 'running' || (!requestedStatus && scenario.lifecycle.kind === 'running' && index === mergedTasks)) {
        Object.assign(runTask, { status: 'running', attemptNo: 1 });
      }
    }
    if (scenario.lifecycle.kind === 'completed') record.completedAt = now;
  });
}

writeJsonAtomicSync(platformFile, platform);
const logDir = path.join(dataDir, 'agent-logs');
fs.mkdirSync(logDir, { recursive: true });
for (const [number, phase, messages] of [
  [302, 'build', ['模拟演示：交互设计任务已完成', '模拟演示：正在实现筛选与搜索，不会真正调用 AI']],
  [304, 'uat', ['模拟演示：验证阶段已完成', '模拟演示：移动端按钮遮挡，浏览器验收卡片供界面检查']],
] as const) {
  const logFile = path.join(logDir, `${number}.jsonl`);
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, messages.map(summary => JSON.stringify({ type: 'system', phase, timestamp: now, summary })).join('\n') + '\n');
  }
}
const uatRunId = '00000000-0000-4000-8000-000000000304';
const uatSummaryFile = path.join(dataDir, 'uat', uatRunId, 'summary.json');
if (!fs.existsSync(uatSummaryFile)) {
  const sample: UatResult = {
    runId: uatRunId, issueIid: 304, startedAt: now, finishedAt: now,
    passed: false, passedTests: 0, failedTests: 1, skippedTests: 0,
    reportAvailable: false, error: '仅供界面展示的模拟失败记录，不是实际 Playwright 运行或验收证据。',
  };
  writeJsonAtomicSync(uatSummaryFile, sample);
}
process.env.IAF_DEMO_DIR = root;
process.env.IAF_DEMO_PORT ||= '3312';
process.env.IAF_DEMO_PLATFORM_PORT = platformPort;
process.env.IAF_DEMO_SHOWCASE = 'true';
console.log(`多状态界面演示：http://127.0.0.1:${process.env.IAF_DEMO_PORT}（仅本地模拟，不处理真实 Issue）`);
await import('./demo.js');
