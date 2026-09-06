/**
 * 第一层：动作状态（对应 Fowler 的 Action 生命周期）
 */
export type ActionStatus =
  | 'idle'       // 尚未开始 (Pending)
  | 'ready'      // 前置已满足，可开始 (BranchCreated, PhaseDone, PhaseApproved)
  | 'running'    // 正在执行 (PhaseRunning)
  | 'waiting'    // 等待外部输入 (PhaseWaiting)
  | 'done'       // 最终完成 (Completed)
  | 'failed'     // 失败 (Failed)
  | 'skipped'    // 跳过 (Skipped)
  | 'paused';    // 用户主动中止 (Paused)

/**
 * 第二层：动作名（由 PhaseSpec.name 驱动，加上 'init' 和 'conflict'）
 */
export type Action = string;

/**
 * 组合状态：action + status
 */
export interface ActionState {
  action: Action;
  status: ActionStatus;
}

/**
 * 状态分类（替代 IssueTracker 的 3 个 Set 常量）
 */
export type StateCategory = 'terminal' | 'in_progress' | 'phase_done' | 'blocked';
