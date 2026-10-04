import { randomUUID } from 'node:crypto';
import type { AIRunner, RunOptions } from '../ai-runner/AIRunner.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import type { ExecutionIdentity } from './contracts.js';

/** 把每次 SDK 调用与父 Issue 的持久状态绑定，包括父阶段和内部修复调用。 */
export function scopedRunner(
  runner: AIRunner,
  tracker: IssueTracker,
  issueNumber: number,
  signal: AbortSignal,
  taskId = '$phase',
  attemptNo?: number,
): AIRunner {
  const composeSignals = (local?: AbortSignal): { signal: AbortSignal; cleanup: () => void } => {
    if (!local || local === signal) return { signal, cleanup: () => undefined };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    local.addEventListener('abort', abort, { once: true });
    if (signal.aborted || local.aborted) controller.abort();
    return {
      signal: controller.signal,
      cleanup: () => {
        signal.removeEventListener('abort', abort);
        local.removeEventListener('abort', abort);
      },
    };
  };
  return {
    canResumeSession: (id) => runner.canResumeSession?.(id) ?? true,
    // 运行器已经被限定到单个 Issue，不能让调用方绕过边界终止其他 Issue 的任务。
    killAll: () => {
      throw new Error('单 Issue 不能执行全局中止');
    },
    killByWorkDir: (dir) => runner.killByWorkDir(dir),
    async run(options: RunOptions) {
      const run = tracker.get(issueNumber)!.run;
      signal.throwIfAborted();
      const identity: ExecutionIdentity = {
        issueNumber,
        planRevision: run.planRevision,
        buildGeneration: run.buildGeneration,
        dispatchId: run.dispatchId!,
        taskId,
        attemptNo: attemptNo ?? run.phaseExecutions[options.phaseName ?? 'plan'] ?? 1,
        callId: randomUUID(),
      };
      // 先登记调用再启动 worker。这样重启、取消或新一轮重试都能识别这次调用属于哪一轮执行。
      tracker.transaction(issueNumber, (record) => {
        if (record.run.stopIntent || record.run.dispatchId !== identity.dispatchId)
          throw new Error('执行已停止');
        record.run.activeCalls ??= {};
        record.run.activeCalls[taskId] = identity.callId;
        record.run.calls[identity.callId] = {
          identity,
          workDir: options.workDir,
          status: 'queued',
        };
        if (record.run.tasks[taskId]) record.run.tasks[taskId].identity = identity;
      });
      // 执行阶段：启动并等待 Worker；这里的异常继续交给上层处理。
      const combined = composeSignals(options.signal);
      try {
        const result = await runner.run({
          ...options,
          signal: combined.signal,
          identity,
          onWorkerStarted: (pid) => {
            // Worker 启动可能晚于新一轮调度，先确认它仍属于当前执行。
            tracker.assertIdentity(identity);
            tracker.transaction(issueNumber, (record) => {
              Object.assign(record.run.calls[identity.callId], {
                pid,
                status: 'running',
                startedAt: new Date().toISOString(),
              });
            });
            options.onWorkerStarted?.(pid);
          },
          onStreamEvent: (event) => {
            // 流式输出阶段：旧调用的迟到输出可以丢弃，但不能覆盖当前调用。
            try {
              tracker.assertIdentity(identity);
            } catch {
              return;
            }
            options.onStreamEvent?.({ ...event, identity });
          },
        });
        // 结果阶段：只有身份仍有效，AI 成功结果才可以交给业务层采用。
        tracker.assertIdentity(identity);
        return { ...result, identity };
      } finally {
        combined.cleanup();
        // 收尾阶段：无论成功、失败还是取消，都登记调用已退出。
        tracker.transaction(issueNumber, (record) => {
          const call = record.run.calls[identity.callId];
          if (call) {
            call.status = 'exited';
            call.exitedAt = new Date().toISOString();
          }
        });
      }
    },
  };
}
