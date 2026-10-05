import { assertWorkflowStorageInvariants } from '../orchestration/WorkflowState.js';
import type { IssueRun, PlanContent } from './contracts.js';

/** 计划图的跨字段业务约束；字段形状由输入 Codec 负责。 */
export function assertPlanInvariants(plan: PlanContent): void {
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  if (tasks.size !== plan.tasks.length) throw new Error('任务 ID 重复');

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`任务图存在循环：${id}`);
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (!task) throw new Error(`依赖引用了不存在的任务：${id}`);
    if (new Set(task.dependsOn).size !== task.dependsOn.length) {
      throw new Error(`任务 ${id} 的依赖重复`);
    }
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
}

/**
 * 聚合运行数据的跨字段和父子身份约束。
 * 这里不负责字段类型检查，避免将业务凭证规则编码成难以阅读的 Zod refine。
 */
export function assertIssueRunInvariants(run: IssueRun, issueNumber: number): void {
  assertWorkflowStorageInvariants(run.workflow);
  if (run.planRevision > 0 && !run.planDigest) throw new Error('计划引用缺少摘要');
  if (run.review && run.review.revision !== run.planRevision) {
    throw new Error('审核版本与计划引用不一致');
  }
  for (const [id, task] of Object.entries(run.tasks)) {
    if (task.taskId !== id) throw new Error('任务索引与身份不一致');
    if (
      task.success &&
      (task.success.identity.issueNumber !== issueNumber ||
        task.success.identity.planRevision !== run.planRevision ||
        task.success.identity.buildGeneration !== run.buildGeneration ||
        task.success.identity.taskId !== id)
    )
      throw new Error('成功凭证的计划或构建轮次不匹配');
    if (['waiting-merge', 'merging', 'merged'].includes(task.status) && !task.success) {
      throw new Error('待合并任务缺少成功凭证');
    }
    if (
      task.merge &&
      (!task.success || (task.merge.stage !== 'rebasing' && !task.merge.postRebaseCommit))
    ) {
      throw new Error('合并操作缺少结果提交');
    }
    if (
      task.status === 'merged' &&
      (task.merge?.stage !== 'merged' ||
        task.merge.integrationAfter !== task.merge.postRebaseCommit)
    ) {
      throw new Error('已合并任务缺少完整集成凭证');
    }
  }
  for (const [id, call] of Object.entries(run.calls)) {
    if (id !== call.identity.callId || call.identity.issueNumber !== issueNumber) {
      throw new Error('调用索引或所属 Issue 不匹配');
    }
  }
  if (run.delivery && run.delivery.issueNumber !== issueNumber) {
    throw new Error('交付身份与父 Issue 不匹配');
  }
  if (run.uatExecution && run.uatExecution.runId === run.uat?.runId && run.uat) {
    throw new Error('已签发 UAT 凭证仍保留执行中状态');
  }
  for (const repair of run.repairs) {
    if (!repair.visualDecision) continue;
    const context = repair.visual;
    if (
      !context
      || repair.visualDecision.sourceRunId !== context.sourceRunId
      || repair.visualDecision.candidateCommit !== context.candidateCommit
      || repair.visualDecision.planRevision !== context.planRevision
      || repair.visualDecision.planDigest !== context.planDigest
      || repair.visualDecision.buildGeneration !== context.buildGeneration
      || repair.visualDecision.gapIndex !== context.gap.gapIndex
    )
      throw new Error('视觉修复决定与缺口上下文身份不一致');
  }
}
