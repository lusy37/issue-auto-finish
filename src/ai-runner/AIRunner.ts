import type { ExecutionIdentity } from '../dag/contracts.js';
/** AI 执行扩展接口；当前提供 Codex SDK 适配器。 */
export interface StreamEvent {
  identity?: ExecutionIdentity;
  type: string;
  content: unknown;
  timestamp: string;
  /** 执行器生成的不透明会话标识，供中断恢复使用。 */
  sessionId?: string;
}
export interface RunOptions {
  identity?: ExecutionIdentity;
  signal?: AbortSignal;
  onWorkerStarted?: (pid: number) => void;
  prompt: string;
  workDir: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  sessionId?: string;
  continueSession?: boolean;
  mode?: string;
  /** 当前调用的模型，优先于执行器默认值。 */
  model?: string;
  phaseName?: string;
  /** 有限延长仍在产生有效输出的调用。 */
  timeoutGraceMs?: number;
  timeoutExtensionMs?: number;
  timeoutMaxExtensions?: number;
  onStreamEvent?: (event: StreamEvent) => void;
}
export interface RunResult {
  identity?: ExecutionIdentity;
  success: boolean;
  output: string;
  errorMessage?: string;
  sessionId?: string;
  exitCode: number | null;
  timeoutType?: 'wall-clock' | 'idle';
  wasActiveAtTimeout?: boolean;
}
export interface AIRunner {
  waitForIdle?(): Promise<void>;
  canResumeSession?(sessionId: string): boolean;
  run(options: RunOptions): Promise<RunResult>;
  killAll(): void;
  killByWorkDir(targetWorkDir: string): number;
}
