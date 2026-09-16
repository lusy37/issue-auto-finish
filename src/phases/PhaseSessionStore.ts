/** 阶段执行层只关心会话恢复所需的最小进度投影。 */
export interface PhaseSessionProgress {
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'gate_waiting';
  sessionId?: string;
}

/**
 * 阶段会话持久化端口。
 *
 * 具体存储由编排层注入；阶段层不依赖 IssueTracker，也不拥有业务生命周期。
 */
export interface PhaseSessionStore {
  getPhaseProgress(issueIid: number, phase: string): PhaseSessionProgress | undefined;
  updatePhaseProgress(issueIid: number, phase: string, update: { sessionId?: string }): void;
}
