/** 阶段执行结果意图 */
export type PhaseResult = CompletedIntent | FailedIntent | RequestRetryFromIntent;

/** 阶段成功完成 */
export interface CompletedIntent {
  readonly kind: 'completed';
  /** 阶段输出摘要（用于评论/日志） */
  readonly output: string;
  /** AI 会话 ID（用于下次 resume） */
  readonly sessionId?: string;
  /** 阶段产出的产物文件引用列表 */
  readonly artifacts?: readonly ArtifactRef[];
}

/** 阶段失败 */
export interface FailedIntent {
  readonly kind: 'failed';
  readonly error: PhaseError;
  /** AI 会话 ID（即使失败也记录，供调试） */
  readonly sessionId?: string;
}

/** 阶段请求回退到指定阶段（如 verify 失败请求回到 build） */
export interface RequestRetryFromIntent {
  readonly kind: 'requestRetryFrom';
  /** 要回退到的目标阶段 ID */
  readonly targetPhaseId: string;
  /** 回退原因（用于日志和事件） */
  readonly reason: string;
  /** 携带的修复上下文（如 verify 失败的报告） */
  readonly context?: Record<string, unknown>;
  /** AI 会话 ID（即使请求回退也记录） */
  readonly sessionId?: string;
}

/**
 * 阶段失败结构化错误信息。
 *
 * `retryable` 三态：
 * - `soft`：超时但 AI 仍在活跃输出 — 同样消耗有限重试预算，下次尝试可以续跑
 * - `hard`：常规失败 — 消耗 retry budget，达到上限后转 manual
 * - `hard-no-auto`：非自动可恢复（如 verify-fix 反复失败）— 不消耗 budget，但必须用户介入
 */
export interface PhaseError {
  readonly message: string;
  readonly retryable: 'soft' | 'hard' | 'hard-no-auto';
  /** 完整 AI 输出（供调试） */
  readonly rawOutput?: string;
}

/** 展示层的审核原因；用户介入由图的 interrupt 管理。 */
export type GateReason = string;

/** 阶段产物的引用 — 仅文件名，由编排器解析到具体路径 */
export interface ArtifactRef {
  readonly filename: string;
  readonly label?: string;
}
