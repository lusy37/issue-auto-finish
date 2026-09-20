/**
 * SessionReplayer — 从 SessionTape 回放 AI 交互，实现 AIRunner 接口。
 *
 * CI 中用于替代真实 AI CLI：从 tape 文件加载预录制的会话，
 * 按时间序列回放 stream events、写入产物文件，最终返回 RunResult。
 * 支持时间压缩（默认 100x 加速）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AIRunner, RunOptions, RunResult } from '../../src/ai-runner/index.js';
import type { SessionTape, TapeEvent } from './session-tape.js';

export interface ReplayerOptions {
  /** Time compression ratio: 100 = 100x faster replay. Set 0 to skip delays. */
  speedFactor?: number;
  /** 是否把 artifact-write 事件写入显式指定的产物目录 */
  replayFileWrites?: boolean;
  /** 显式指定本次 Issue 的产物目录，禁止回放到项目 workDir。 */
  artifactDirectory?: string;
}

export class SessionReplayer implements AIRunner {
  private readonly tape: SessionTape;
  private readonly options: ReplayerOptions;

  readonly replayCalls: RunOptions[] = [];
  readonly killCalls: Array<{ method: 'killAll' | 'killByWorkDir'; workDir?: string }> = [];

  constructor(tape: SessionTape, options: ReplayerOptions = {}) {
    this.tape = tape;
    this.options = { speedFactor: 100, replayFileWrites: true, ...options };
  }

  static fromFile(tapePath: string, options?: ReplayerOptions): SessionReplayer {
    const raw = fs.readFileSync(tapePath, 'utf-8');
    const tape = JSON.parse(raw) as SessionTape;
    return new SessionReplayer(tape, options);
  }

  static fromTape(tape: SessionTape, options?: ReplayerOptions): SessionReplayer {
    return new SessionReplayer(tape, options);
  }

  async run(options: RunOptions): Promise<RunResult> {
    this.replayCalls.push(options);

    const events = this.tape.events;
    let output = '';
    let errorMessage: string | undefined;
    let exitCode: number | null = 0;
    let lastOffsetMs = 0;

    for (const event of events) {
      await this.delayForEvent(event, lastOffsetMs);
      lastOffsetMs = event.offsetMs;

      switch (event.type) {
        case 'stdout':
          output += event.data;
          break;

        case 'stderr':
          errorMessage = event.data;
          break;

        case 'stream-event':
          options.onStreamEvent?.(event.event);
          break;

        case 'artifact-write':
          if (this.options.replayFileWrites) {
            if (!this.options.artifactDirectory) throw new Error('回放产物必须指定 Issue 产物目录');
            if (!event.filename || event.filename === '.' || event.filename === '..' || /[/\\\0:]/.test(event.filename)) throw new Error('回放产物名称必须是单个文件名');
            const absPath = path.join(this.options.artifactDirectory, event.filename);
            const dir = path.dirname(absPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(absPath, event.content);
          }
          break;

        case 'exit':
          exitCode = event.code;
          break;
      }
    }

    const success = exitCode === 0 && !errorMessage;
    return {
      success,
      output,
      errorMessage,
      sessionId: this.tape.metadata.runner + '-replay',
      exitCode,
    };
  }

  killAll(): void {
    this.killCalls.push({ method: 'killAll' });
  }

  killByWorkDir(targetWorkDir: string): number {
    this.killCalls.push({ method: 'killByWorkDir', workDir: targetWorkDir });
    return 0;
  }

  private async delayForEvent(event: TapeEvent, previousOffsetMs: number): Promise<void> {
    const factor = this.options.speedFactor ?? 100;
    if (factor <= 0) return;

    const deltaMs = event.offsetMs - previousOffsetMs;
    if (deltaMs <= 0) return;

    const compressedMs = Math.ceil(deltaMs / factor);
    if (compressedMs > 0) {
      await new Promise(resolve => setTimeout(resolve, compressedMs));
    }
  }
}
