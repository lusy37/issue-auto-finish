import { resolveIssueArtifactsDir, resolveIssueArtifactPath } from '../../src/persistence/ArtifactPaths.js';
/**
 * 场景仿真测试 — 使用 SessionReplayer 从 tape 回放 AI 交互。
 *
 * 验证 Recorder/Replayer 基础设施和各场景 tape 的完整性。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SessionReplayer } from '../helpers/session-replayer.js';
import { SessionRecorder } from '../helpers/session-recorder.js';
import { createMockAIRunner } from '../helpers/mock-factories.js';
import type { SessionTape } from '../helpers/session-tape.js';
import type { RunOptions, StreamEvent } from '../../src/ai-runner/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAPES_DIR = path.join(__dirname, '..', 'fixtures', 'tapes');

function loadTape(name: string): SessionTape {
  return JSON.parse(fs.readFileSync(path.join(TAPES_DIR, name), 'utf-8'));
}

function createRunOptions(workDir: string, overrides?: Partial<RunOptions>): RunOptions {
  return {
    prompt: 'test prompt',
    workDir,
    timeoutMs: 30000,
    ...overrides,
  };
}

describe('SessionReplayer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'replay-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('录制回放只记录文件名，产物写入显式指定的数据目录', async () => {
    const source = resolveIssueArtifactsDir(42);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(resolveIssueArtifactPath(42, '02-verify-report.md'), '本次验证结果');
    const tapeFile = path.join(tmpDir, 'recording.json');
    await new SessionRecorder(createMockAIRunner(), tapeFile, 'mock', source).run(createRunOptions(tmpDir));
    const tape = JSON.parse(fs.readFileSync(tapeFile, 'utf8')) as SessionTape;
    expect(tape.events).toContainEqual(expect.objectContaining({ type: 'artifact-write', filename: '02-verify-report.md', content: '本次验证结果' }));
    expect(JSON.stringify(tape)).not.toContain(source);
    const replayer = SessionReplayer.fromTape(tape, { speedFactor: 0, artifactDirectory: resolveIssueArtifactsDir(99) });
    await replayer.run(createRunOptions(tmpDir));
    expect(fs.readFileSync(resolveIssueArtifactPath(99, '02-verify-report.md'), 'utf8')).toBe('本次验证结果');
  });

  it('未指定产物目录时拒绝回放文件，不降级到项目目录', async () => {
    const replayer = new SessionReplayer(loadTape('verify-fix-loop.json'), { speedFactor: 0 });
    await expect(replayer.run(createRunOptions(tmpDir))).rejects.toThrow('必须指定 Issue 产物目录');
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  describe('happy path: plan 阶段', () => {
    it('应成功回放 plan tape 并写入产物文件', async () => {
      const tape = loadTape('happy-path-plan.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });
      const options = createRunOptions(tmpDir);

      const result = await replayer.run(options);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Plan created successfully');
    });

    it('应将产物文件写入独立数据目录', async () => {
      const tape = loadTape('happy-path-plan.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });
      const options = createRunOptions(tmpDir);

      await replayer.run(options);

      const planPath = resolveIssueArtifactPath(42, '01-plan.md');
      expect(fs.existsSync(planPath)).toBe(true);
      const content = fs.readFileSync(planPath, 'utf-8');
      expect(content).toContain('## Tasks');
      expect(fs.readdirSync(tmpDir)).toEqual([]);
      expect(content).toContain('- [ ] 创建服务类');
    });

    it('应触发 stream events', async () => {
      const tape = loadTape('happy-path-plan.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });
      const events: StreamEvent[] = [];
      const options = createRunOptions(tmpDir, {
        onStreamEvent: (e) => events.push(e),
      });

      await replayer.run(options);

      expect(events.length).toBeGreaterThan(0);
      const types = events.map(e => e.type);
      expect(types).toContain('system');
      expect(types).toContain('assistant');
    });

    it('应记录 run 调用', async () => {
      const tape = loadTape('happy-path-plan.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });

      await replayer.run(createRunOptions(tmpDir));

      expect(replayer.replayCalls).toHaveLength(1);
      expect(replayer.replayCalls[0].workDir).toBe(tmpDir);
    });
  });

  describe('超时场景: wall-clock timeout', () => {
    it('应返回失败结果和错误信息', async () => {
      const tape = loadTape('timeout-wall-clock.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });

      const result = await replayer.run(createRunOptions(tmpDir));

      expect(result.success).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.errorMessage).toContain('timed out');
    });
  });

  describe('verify-fix-loop: verify 报告包含待修复项', () => {
    it('应写入 verify 报告产物', async () => {
      const tape = loadTape('verify-fix-loop.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });

      await replayer.run(createRunOptions(tmpDir));

      const reportPath = resolveIssueArtifactPath(42, '02-verify-report.md');
      expect(fs.existsSync(reportPath)).toBe(true);
      const content = fs.readFileSync(reportPath, 'utf-8');
      expect(content).toContain('待修复');
      expect(content).toContain('- [ ] 修复 calculateTotal');
    });

    it('verify 报告可被 TodolistExtractor 解析', async () => {
      const tape = loadTape('verify-fix-loop.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });

      await replayer.run(createRunOptions(tmpDir));

      const reportPath = resolveIssueArtifactPath(42, '02-verify-report.md');
      const content = fs.readFileSync(reportPath, 'utf-8');

      const { extractTodolist } = await import('../helpers/todolist-extractor.js');
      const summary = extractTodolist(content);
      expect(summary.total).toBe(2);
      expect(summary.pending).toBe(2);
    });
  });

  describe('格式异常: 截断 JSON / 连接中断', () => {
    it('应返回失败且 exitCode 非 0', async () => {
      const tape = loadTape('format-error.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });

      const result = await replayer.run(createRunOptions(tmpDir));

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain('Connection reset');
    });

    it('截断的 stdout 仍被捕获', async () => {
      const tape = loadTape('format-error.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });

      const result = await replayer.run(createRunOptions(tmpDir));

      expect(result.output).toContain('system');
    });
  });

  describe('session resume: 从中断恢复', () => {
    it('应返回成功结果', async () => {
      const tape = loadTape('session-resume.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });

      const result = await replayer.run(createRunOptions(tmpDir, { continueSession: true }));

      expect(result.success).toBe(true);
      expect(result.output).toContain('resumed and completed');
    });

    it('stream events 应包含 resume 相关内容', async () => {
      const tape = loadTape('session-resume.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0 });
      const events: StreamEvent[] = [];

      await replayer.run(createRunOptions(tmpDir, {
        onStreamEvent: (e) => events.push(e),
      }));

      const assistantEvents = events.filter(e => e.type === 'assistant');
      expect(assistantEvents.length).toBeGreaterThan(0);
      const resumeEvent = assistantEvents.find(e =>
        typeof e.content === 'string' && e.content.includes('Resuming'),
      );
      expect(resumeEvent).toBeDefined();
    });
  });

  describe('replayFileWrites: false 不写文件', () => {
    it('应跳过文件写入', async () => {
      const tape = loadTape('happy-path-plan.json');
      const replayer = new SessionReplayer(tape, { artifactDirectory: resolveIssueArtifactsDir(42), speedFactor: 0, replayFileWrites: false });

      await replayer.run(createRunOptions(tmpDir));

      const planPath = resolveIssueArtifactPath(42, '01-plan.md');
      expect(fs.existsSync(planPath)).toBe(false);
    });
  });

  describe('killAll / killByWorkDir', () => {
    it('应记录 kill 调用', () => {
      const tape = loadTape('happy-path-plan.json');
      const replayer = new SessionReplayer(tape);

      replayer.killAll();
      replayer.killByWorkDir('/some/dir');

      expect(replayer.killCalls).toHaveLength(2);
      expect(replayer.killCalls[0].method).toBe('killAll');
      expect(replayer.killCalls[1].method).toBe('killByWorkDir');
    });
  });
});
