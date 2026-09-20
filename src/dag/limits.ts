/** 计划大小与持久化冲突修复预算，分别约束调度规模和累计 AI 调用。 */
export const MAX_PLAN_TASKS = 20;
export const MAX_CONFLICT_REPAIR_CALLS = 2;

/** 最长任务链至多占 N 个超步，另留 START 初始化与 END 收尾两个超步。 */
export function taskGraphRecursionLimit(taskCount: number): number {
  return taskCount + 2;
}

/** 框架防止意外路由循环；业务重试仍分别受阶段、集成修复与冲突预算约束。 */
export const ISSUE_WORKFLOW_RECURSION_LIMIT = 200;
