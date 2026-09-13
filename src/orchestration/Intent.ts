/**
 * 阶段意图（Intent）— 阶段返回给编排器的意图。
 *
 * 设计原则：
 * - 阶段不读写 tracker / eventBus / git 等副作用对象。
 * - 阶段只表达「我做完了 / 失败了 / 请求 gate / 异步执行中 / 请求回退」5 种意图。
 * - 编排器消费 Intent + Pipeline.transitions 决定下一步状态转移。
 *
 * 这取代了之前的 PhaseOutcome（含 `data.hasReleaseCapability`、`data.verifyReport` 等
 * 阶段专属字段），让编排器无需「读懂」阶段领域语义。
 */

/** 阶段执行结果意图 */
export type PhaseIntent =
  | CompletedIntent
  | FailedIntent
  | AwaitGateIntent
  | AwaitAsyncIntent
  | RequestRetryFromIntent;

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

/** 阶段请求 gate 暂停（如 review、release-confirm、uat-confirm） */
export interface AwaitGateIntent {
  readonly kind: 'awaitGate';
  /** Gate 原因（统一标识 gate 类型） */
  readonly reason: GateReason;
  /** Gate 携带的领域数据（如 release detect 结果） */
  readonly payload?: Record<string, unknown>;
  /** 阶段已写入的产物（gate 期间可被前端展示） */
  readonly artifacts?: readonly ArtifactRef[];
  /** AI 会话 ID（用于 gate 通过后 resume） */
  readonly sessionId?: string;
}

/** 阶段进入异步执行（编排器 await 此句柄获取最终结果） */
export interface AwaitAsyncIntent {
  readonly kind: 'awaitAsync';
  /** 异步完成的 Promise — 编排器 await 后获得最终 Intent */
  readonly awaiter: Promise<PhaseIntent>;
  /** 当前会话 ID（异步开始时已知） */
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

/**
 * Gate 原因 — 统一标识 gate 类型。
 *
 * 内置 3 种，自定义流水线可扩展（接受任意字符串）：
 * - `human-review`：方案审核（review 阶段）
 * - `release-confirm`：发布确认（release 阶段检测到能力后）
 * - `uat-confirm`：UAT 确认（uat 阶段完成后）
 */
export type GateReason = 'human-review' | 'release-confirm' | 'uat-confirm' | (string & {});

/** 阶段产物的引用 — 仅文件名，由编排器解析到具体路径 */
export interface ArtifactRef {
  readonly filename: string;
  readonly label?: string;
}
