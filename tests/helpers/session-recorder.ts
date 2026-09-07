/**
 * SessionRecorder — 包装真实 AIRunner，拦截交互并录制为 tape 文件。
 *
 * 开发时一次性使用：用真实 AI CLI 跑一次流水线阶段，
 * 将 stdout/stderr/stream-event/file-write/exit 全部序列化为 SessionTape JSON。
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

  constructor(inner: AIRunner, outputPath: string, runnerName: string = 'unknown') {
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

    this.scanArtifacts(options.workDir, startTime, events);

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

  /**
   * Scan the workDir for artifact files created during the AI run.
   * Records file-write events for any .claude-plan/ files found.
   */
  private scanArtifacts(workDir: string, startTime: number, events: TapeEvent[]): void {
    const planDir = path.join(workDir, '.claude-plan');
    if (!fs.existsSync(planDir)) return;

    const walkDir = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          const relPath = path.relative(workDir, fullPath);
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            events.push({
              type: 'file-write',
              path: relPath,
              content,
              offsetMs: Date.now() - startTime,
            });
          } catch {
            // skip unreadable files
          }
        }
      }
    };

    walkDir(planDir);
  }
}
