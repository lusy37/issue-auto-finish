import type { ExecutionIdentity } from '../dag/contracts.js';
/** AI 执行扩展接口；当前提供 Codex SDK 适配器。 */
export type AICallPurpose =
  | 'plan'
  | 'verify'
  | 'task'
  | 'conflict-repair'
  | 'integration-repair'
  | 'uat-prepare'
  | 'uat-visual-review'
  | 'memory-distill'
  | 'rule-distill';

export type AIRunMode = 'plan' | 'agent';

/** 交给 SDK 的 JSON Schema；具体字段由各边界契约定义。 */
export type JsonSchema = Record<string, unknown>;

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
  mode?: AIRunMode;
  /** 当前调用的模型，优先于执行器默认值。 */
  model?: string;
  phaseName?: string;
  /** 有限延长仍在产生有效输出的调用。 */
  timeoutGraceMs?: number;
  timeoutExtensionMs?: number;
  timeoutMaxExtensions?: number;
  /** 视觉调用附加的本地图片；路径由服务端生成。 */
  imagePaths?: string[];
  /** 交给 Codex SDK turn 的普通 JSON Schema。 */
  outputSchema?: JsonSchema;
  /** 用于集中策略与审计的调用用途。 */
  purpose?: AICallPurpose;
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
