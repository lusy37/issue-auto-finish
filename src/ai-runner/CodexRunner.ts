import { codexSessionId, parseCodexSessionId } from './SessionId.js';
import path from 'node:path';
import { Codex, type ThreadOptions, type ThreadItem } from '@openai/codex-sdk';
import type { AIRunner, RunOptions, RunResult } from './AIRunner.js';
import { isShuttingDown } from '../shutdown/ShutdownSignal.js';
import { findExecutable } from '../utils/process.js';

/** 留空时由 SDK 定位随依赖安装的原生程序；Windows 不接受脚本启动器。 */
export function createCodexClient(binary = ''): Codex {
  if (!binary) return new Codex();
  const executable = findExecutable(binary);
  if (!executable) throw new Error(`找不到 Codex 程序：${binary}`);
  if (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')) {
    throw new Error('CODEX_BINARY 需要指向原生 codex.exe；留空可使用 SDK 内置程序');
  }
  return new Codex({ codexPathOverride: executable });
}

function workDirKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** SDK 负责启动、流解析和中止；适配器仅保留工作台的日志、超时与结果约定。 */
export class CodexRunner implements AIRunner {
  private readonly active = new Map<AbortController, string>();

  constructor(
    private readonly binary = '',
    private readonly model?: string,
  ) {}

  /** 会话标识是不透明值；仅接受本执行器命名空间内的非空标识。 */
  canResumeSession(sessionId: string): boolean {
    return parseCodexSessionId(sessionId) !== undefined;
  }

  async run(options: RunOptions): Promise<RunResult> {
    if (isShuttingDown()) {
      return { success: false, output: '', errorMessage: '服务正在关闭', exitCode: null };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.active.set(controller, workDirKey(options.workDir));
    let output = '';
    let sessionId = options.continueSession ? options.sessionId : undefined;
    let completed = false;
    let errorMessage: string | undefined;
    let timeoutType: RunResult['timeoutType'];
    let lastActivity = Date.now();
    let lastItemActivity: number | undefined;
    let extensions = 0;
    let wasActiveAtTimeout = false;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const emit = (type: string, content: unknown) =>
      options.onStreamEvent?.({
        type,
        content,
        sessionId,
        timestamp: new Date().toISOString(),
      });
    const abortForTimeout = (kind: NonNullable<RunResult['timeoutType']>) => {
      if (controller.signal.aborted) return;
      timeoutType = kind;
      errorMessage = kind === 'idle' ? 'Codex 长时间未返回事件，已超时终止' : 'Codex 执行超时';
      controller.abort();
    };
    const scheduleWallTimeout = (delay: number) => {
      wallTimer = setTimeout(() => {
        if (controller.signal.aborted) return;
        wasActiveAtTimeout =
          lastItemActivity !== undefined &&
          Date.now() - lastItemActivity < (options.timeoutGraceMs ?? 60000);
        if (!completed && wasActiveAtTimeout && extensions < (options.timeoutMaxExtensions ?? 0)) {
          extensions++;
          emit('system', `Codex 仍有输出，延长执行时间（第 ${extensions} 次）`);
          scheduleWallTimeout(options.timeoutExtensionMs ?? 600000);
        } else {
          abortForTimeout('wall-clock');
        }
      }, delay);
    };
    const refreshIdleTimeout = () => {
      clearTimeout(idleTimer);
      if (options.idleTimeoutMs && options.idleTimeoutMs > 0) {
        idleTimer = setTimeout(() => abortForTimeout('idle'), options.idleTimeoutMs);
      }
    };

    try {
      if (sessionId && !this.canResumeSession(sessionId)) {
        throw new Error('无法恢复其他执行器的会话，请使用完整任务重新开始');
      }
      const client = createCodexClient(this.binary);
      const threadOptions: ThreadOptions = {
        workingDirectory: path.resolve(options.workDir),
        sandboxMode: options.mode === 'plan' ? 'read-only' : 'workspace-write',
        // 构建阶段需要下载依赖；文件写入范围仍由工作区沙箱限制。
        networkAccessEnabled: options.mode !== 'plan',
        approvalPolicy: 'never',
        model: options.model || this.model || undefined,
      };
      const thread = sessionId
        ? client.resumeThread(parseCodexSessionId(sessionId)!, threadOptions)
        : client.startThread(threadOptions);
      scheduleWallTimeout(options.timeoutMs);
      refreshIdleTimeout();
      const { events } = await thread.runStreamed(options.prompt, { signal: controller.signal });
      for await (const event of events) {
        if (controller.signal.aborted) break;
        lastActivity = Date.now();
        refreshIdleTimeout();
        switch (event.type) {
          case 'thread.started':
            sessionId = codexSessionId(event.thread_id);
            emit('system', 'Codex 会话已启动');
            break;
          case 'turn.started':
            emit('system', 'Codex 开始执行任务');
            break;
          case 'item.started':
          case 'item.updated':
          case 'item.completed':
            lastItemActivity = lastActivity;
            if (event.item.type === 'agent_message' && event.type === 'item.completed') {
              // 与 SDK 的 finalResponse 一致，只取最后一条完整回复。
              output = event.item.text;
            }
            this.emitItem(event.item, event.type, emit);
            break;
          case 'turn.completed':
            completed = true;
            emit('result', { result: output, usage: event.usage });
            break;
          case 'turn.failed':
            errorMessage = event.error.message;
            emit('error', errorMessage);
            break;
          case 'error':
            errorMessage = event.message;
            emit('error', errorMessage);
            break;
        }
        if (errorMessage) break;
      }
      // 必须读完事件流：turn.completed 之后的非零进程退出也不能判成功。
      if (!controller.signal.aborted && !errorMessage) {
        if (!completed) errorMessage = 'Codex 事件流结束，但未确认任务完成';
        else if (!output.trim()) errorMessage = 'Codex 未返回有效结果';
      }
    } catch (error) {
      errorMessage ??= error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(wallTimer);
      clearTimeout(idleTimer);
      this.active.delete(controller);
      options.signal?.removeEventListener('abort', abort);
    }
    if (controller.signal.aborted && !timeoutType) errorMessage = 'Codex 执行已取消';
    const success = completed && !errorMessage && !controller.signal.aborted;
    return {
      success,
      output,
      errorMessage,
      sessionId,
      // SDK 不公开子进程退出码；0 表示成功，失败保留未知。
      exitCode: success ? 0 : null,
      timeoutType,
      wasActiveAtTimeout: timeoutType === 'wall-clock' && wasActiveAtTimeout,
    };
  }

  killAll(): void {
    for (const controller of this.active.keys()) controller.abort();
  }

  killByWorkDir(targetWorkDir: string): number {
    let count = 0;
    const target = workDirKey(targetWorkDir);
    for (const [controller, dir] of this.active) {
      if (dir !== target || controller.signal.aborted) continue;
      controller.abort();
      count++;
    }
    return count;
  }

  private emitItem(
    item: ThreadItem,
    eventType: string,
    emit: (type: string, content: unknown) => void,
  ): void {
    switch (item.type) {
      case 'agent_message':
        emit('assistant', item.text);
        break;
      case 'reasoning':
        emit('thinking', item.text);
        break;
      case 'command_execution':
        emit(
          eventType === 'item.started' ? 'tool_use' : 'tool_result',
          eventType === 'item.started'
            ? { name: 'shell', input: { command: item.command } }
            : { content: item.aggregated_output, exitCode: item.exit_code },
        );
        break;
      case 'file_change':
        emit(
          'system',
          `文件变更（${item.status}）：${item.changes.map((c) => `${c.kind} ${c.path}`).join('、')}`,
        );
        break;
      case 'mcp_tool_call':
        emit(
          eventType === 'item.completed' ? 'tool_result' : 'tool_use',
          eventType === 'item.completed'
            ? { content: item.error?.message ?? item.result }
            : { name: `${item.server}.${item.tool}`, input: item.arguments },
        );
        break;
      case 'web_search':
        emit('tool_use', { name: 'web_search', input: { command: item.query } });
        break;
      case 'todo_list':
        emit('system', item.items.map((i) => `${i.completed ? '✓' : '○'} ${i.text}`).join('\n'));
        break;
      case 'error':
        emit('system', item.message);
        break;
    }
  }
}
