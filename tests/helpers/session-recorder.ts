/**
 * SessionRecorder — 包装真实 AIRunner，拦截交互并录制为 tape 文件。
 *
 * 开发时一次性使用：用真实 AI CLI 跑一次流水线阶段，
 * 将 stdout/stderr/stream-event/artifact-write/exit 全部序列化为 SessionTape JSON。
 * 之后在 CI 中用 SessionReplayer 回放，无需真实 AI。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AIRunner, RunOptions, RunResult } from '../../src/ai-runner/index.js';
import type { SessionTape, TapeEvent } from './session-tape.js';

export class SessionRecorder implements AIRunner {
  private readonly inner: AIRunner;
  private readonly outputPath: string;
  private readonly runnerName: string;

  constructor(inner: AIRunner, outputPath: string, runnerName: string = 'unknown', private readonly artifactDirectory?: string) {
    this.inner = inner;
    this.outputPath = outputPath;
    this.runnerName = runnerName;
  }

  async run(options: RunOptions): Promise<RunResult> {
    const events: TapeEvent[] = [];
    const startTime = Date.now();
    const promptHash = crypto.createHash('sha256').update(options.prompt).digest('hex').slice(0, 16);

    const wrappedOptions: RunOptions = {
      ...options,
      onStreamEvent: (event) => {
        events.push({
          type: 'stream-event',
          event,
          offsetMs: Date.now() - startTime,
        });
        options.onStreamEvent?.(event);
      },
    };

    const result = await this.inner.run(wrappedOptions);

    events.push({
      type: 'exit',
      code: result.exitCode,
      offsetMs: Date.now() - startTime,
    });

    if (result.output) {
      events.unshift({
        type: 'stdout',
        data: result.output,
        offsetMs: 0,
      });
    }

    if (result.errorMessage) {
      events.push({
        type: 'stderr',
        data: result.errorMessage,
        offsetMs: Date.now() - startTime,
      });
    }

    this.scanArtifacts(startTime, events);

    const tape: SessionTape = {
      metadata: {
        runner: this.runnerName,
        phase: options.phaseName ?? options.mode ?? 'unknown',
        model: 'unknown',
        recordedAt: new Date().toISOString(),
        promptHash,
        durationMs: Date.now() - startTime,
      },
      events,
    };

    const dir = path.dirname(this.outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.outputPath, JSON.stringify(tape, null, 2));

    return result;
  }

  killAll(): void {
    this.inner.killAll();
  }

  killByWorkDir(targetWorkDir: string): number {
    return this.inner.killByWorkDir(targetWorkDir);
  }

  /** 只录制调用方指定的 Issue 产物目录，文件名相对于该目录。 */
  private scanArtifacts(startTime: number, events: TapeEvent[]): void {
    if (!this.artifactDirectory || !fs.existsSync(this.artifactDirectory)) return;
    for (const entry of fs.readdirSync(this.artifactDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      events.push({
        type: 'artifact-write',
        filename: entry.name,
        content: fs.readFileSync(path.join(this.artifactDirectory, entry.name), 'utf8'),
        offsetMs: Date.now() - startTime,
      });
    }
  }
}
