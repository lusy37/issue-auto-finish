/**
 * SessionTape — AI 会话录制/回放的共享数据格式。
 *
 * Tape 文件记录一次 AI Runner 调用的完整交互序列，
 * 支持录制（开发时）和回放（CI 自动化测试时）。
 */
import type { StreamEvent } from '../../src/ai-runner/index.js';

export type TapeEvent =
  | { type: 'stdout'; data: string; offsetMs: number }
  | { type: 'stderr'; data: string; offsetMs: number }
  | { type: 'stream-event'; event: StreamEvent; offsetMs: number }
  | { type: 'artifact-write'; filename: string; content: string; offsetMs: number }
  | { type: 'exit'; code: number | null; offsetMs: number };

export interface SessionTape {
  metadata: {
    runner: string;
    phase: string;
    model: string;
    recordedAt: string;
    promptHash: string;
    /** Total duration of the recorded session */
    durationMs: number;
  };
  events: TapeEvent[];
}

export function createEmptyTape(metadata: Partial<SessionTape['metadata']> = {}): SessionTape {
  return {
    metadata: {
      runner: metadata.runner ?? 'unknown',
      phase: metadata.phase ?? 'unknown',
      model: metadata.model ?? 'unknown',
      recordedAt: metadata.recordedAt ?? new Date().toISOString(),
      promptHash: metadata.promptHash ?? '',
      durationMs: metadata.durationMs ?? 0,
    },
    events: [],
  };
}
