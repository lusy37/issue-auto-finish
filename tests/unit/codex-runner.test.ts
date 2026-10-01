import { ManagedCodexRunner } from '../../src/ai-runner/ManagedCodexRunner.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadEvent, TurnOptions } from '@openai/codex-sdk';
import { CodexRunner } from '../../src/ai-runner/CodexRunner.js';
import { createAIRunner, isRegisteredRunner } from '../../src/ai-runner/AIRunnerRegistry.js';
import type { StreamEvent } from '../../src/ai-runner/AIRunner.js';

const sdk = vi.hoisted(() => ({ startThread: vi.fn(), resumeThread: vi.fn(), runStreamed: vi.fn(), codexOptions: undefined as unknown }));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      sdk.codexOptions = options;
    }
    startThread = sdk.startThread;
    resumeThread = sdk.resumeThread;
  },
}));

const started: ThreadEvent = { type: 'thread.started', thread_id: 'thread-1' };
const message: ThreadEvent = { type: 'item.completed', item: { type: 'agent_message', id: 'reply', text: '任务已完成' } };
const completed: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
const options = { prompt: '实施需求', workDir: process.cwd(), timeoutMs: 1000 };

function events(values: ThreadEvent[], error?: Error) {
  sdk.runStreamed.mockImplementation(async () => ({ events: (async function* () {
    yield* values;
    if (error) throw error;
  })() }));
}

/** 模拟模型持续执行，只有 SDK 的 AbortSignal 才能释放调用。 */
function waitForAbort(values: ThreadEvent[] = [started]) {
  sdk.runStreamed.mockImplementation(async (_: string, turn: TurnOptions) => ({ events: (async function* () {
    yield* values;
    await new Promise((_, reject) => {
      if (turn.signal?.aborted) reject(new Error('aborted'));
      else turn.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  })() }));
}

beforeEach(() => {
  vi.resetAllMocks();
  sdk.codexOptions = undefined;
  sdk.startThread.mockReturnValue({ runStreamed: sdk.runStreamed });
  sdk.resumeThread.mockReturnValue({ runStreamed: sdk.runStreamed });
  events([started, message, completed]);
});
afterEach(() => vi.useRealTimers());

describe('Codex SDK 适配器', () => {
  it('仅内置 Codex，默认使用随 SDK 安装的程序', () => {
    expect(createAIRunner({ mode: 'codex', binary: '', phaseTimeoutMs: 1000 })).toBeInstanceOf(ManagedCodexRunner);
    expect(isRegisteredRunner('claude')).toBe(false);
  });

  it('默认使用 Windows 提权沙箱，并支持显式降级', async () => {
    await new CodexRunner().run(options);
    expect(sdk.codexOptions).toMatchObject({ config: { windows: { sandbox: 'elevated' } } });

    await new CodexRunner('', undefined, 'unelevated').run(options);
    expect(sdk.codexOptions).toMatchObject({ config: { windows: { sandbox: 'unelevated' } } });
  });
  it.each([['plan', 'read-only'], ['agent', 'workspace-write']])('阶段 %s 使用 %s 沙箱', async (mode, sandboxMode) => {
    const logs: StreamEvent[] = [];
    const result = await new CodexRunner('', '默认模型').run({ ...options, mode, model: '本次模型', onStreamEvent: e => logs.push(e) });
    expect(sdk.startThread).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode, networkAccessEnabled: mode !== 'plan', approvalPolicy: 'never', workingDirectory: process.cwd(), model: '本次模型' }));
    expect(result).toMatchObject({ success: true, output: '任务已完成', sessionId: 'codex:thread-1' });
    expect(logs[0].sessionId).toBe('codex:thread-1');
    expect(logs.some(e => e.type === 'assistant' && e.content === '任务已完成')).toBe(true);
  });

  it('只把线程原始 ID 交给 resumeThread，并保留只读限制', async () => {
    await new CodexRunner().run({ ...options, sessionId: 'codex:thread-1', continueSession: true, mode: 'plan' });
    expect(sdk.resumeThread).toHaveBeenCalledWith('thread-1', expect.objectContaining({ sandboxMode: 'read-only' }));
    expect(sdk.startThread).not.toHaveBeenCalled();
  });

  it('拒绝恢复未标记来源的旧会话', async () => {
    const result = await new CodexRunner().run({ ...options, sessionId: 'old-session', continueSession: true });
    expect(result.success).toBe(false);
    expect(sdk.runStreamed).not.toHaveBeenCalled();
  });

  it('最终结果只保留最后的完整回复，不混入进度说明', async () => {
    events([started, { ...message, item: { id: 'progress', type: 'agent_message', text: '正在分析' } }, message, completed]);
    expect((await new CodexRunner().run(options)).output).toBe('任务已完成');
  });

  it.each([
    ['缺少完成事件', [started, message], undefined],
    ['空结果', [started, completed], undefined],
    ['模型失败', [started, { type: 'turn.failed', error: { message: '模型不存在' } }], undefined],
    ['流错误', [started, { type: 'error', message: '登录失效' }], undefined],
    ['完成后进程异常', [started, message, completed], new Error('Codex Exec exited with code 7')],
    ['解析异常', [started], new Error('Failed to parse item')],
  ] as const)('%s 不能判成功', async (_, tape, error) => {
    events([...tape] as ThreadEvent[], error);
    const result = await new CodexRunner().run(options);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeTruthy();
    expect(result.sessionId).toBe('codex:thread-1');
  });

  it('工具执行失败可由模型修复，不能直接判整个任务失败', async () => {
    events([started, { type: 'item.completed', item: { id: 'cmd', type: 'command_execution', command: 'npm test', aggregated_output: '初次测试失败', exit_code: 1, status: 'failed' } }, message, completed]);
    const logs: StreamEvent[] = [];
    expect((await new CodexRunner().run({ ...options, onStreamEvent: e => logs.push(e) })).success).toBe(true);
    expect(logs).toContainEqual(expect.objectContaining({ type: 'tool_result', content: { content: '初次测试失败', exitCode: 1 } }));
  });

  it.each(['wall-clock', 'idle'] as const)('%s 超时通过 AbortSignal 结束并保留会话', async (kind) => {
    vi.useFakeTimers();
    waitForAbort();
    const resultPromise = new CodexRunner().run({ ...options, idleTimeoutMs: kind === 'idle' ? 100 : undefined });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await resultPromise).toMatchObject({ success: false, timeoutType: kind, sessionId: 'codex:thread-1' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('有输出时仅延长配置允许的次数', async () => {
    vi.useFakeTimers();
    waitForAbort([started, message]);
    const logs: StreamEvent[] = [];
    const pending = new CodexRunner().run({ ...options, timeoutMs: 100, timeoutExtensionMs: 100, timeoutMaxExtensions: 2, timeoutGraceMs: 1000, onStreamEvent: e => logs.push(e) });
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toMatchObject({ success: false, timeoutType: 'wall-clock', wasActiveAtTimeout: true });
    expect(logs.filter(e => String(e.content).includes('延长'))).toHaveLength(2);
  });

  it('按工作目录取消互不影响，结束后不残留运行记录或定时器', async () => {
    vi.useFakeTimers();
    waitForAbort();
    const runner = new CodexRunner();
    const first = runner.run({ ...options, workDir: 'fixture/a' });
    const second = runner.run({ ...options, workDir: 'fixture/b' });
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.killByWorkDir('fixture/a/.')).toBe(1);
    expect(await first).toMatchObject({ success: false, errorMessage: 'Codex 执行已取消' });
    expect(runner.killByWorkDir('fixture/a')).toBe(0);
    runner.killAll();
    expect(await second).toMatchObject({ success: false, errorMessage: 'Codex 执行已取消' });
    expect(runner.killByWorkDir('fixture/b')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
