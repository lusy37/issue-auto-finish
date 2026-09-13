import type { StreamEvent } from '../ai-runner/index.js';

/**
 * 编排器传入的回调 — 阶段通过回调与外部通信，而非直接依赖 eventBus/hooks。
 *
 * 注：这是阶段对外通信的轻量协议，不应承载状态决策语义；
 * 状态转移应该通过 PhaseResult 表达。
 */
export interface PhaseCallbacks {
  /** AI 输出流式推送（编排器转发到 eventBus） */
  onStreamEvent?: (event: StreamEvent) => void;
}
