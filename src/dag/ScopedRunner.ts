import { randomUUID } from 'node:crypto';
import type { AIRunner, RunOptions } from '../ai-runner/AIRunner.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import type { ExecutionIdentity } from './contracts.js';

/** 把每次 SDK 调用与父 Issue 的持久状态绑定，包括父阶段和内部修复调用。 */
export function scopedRunner(runner: AIRunner, tracker: IssueTracker, issueNumber: number, signal: AbortSignal, taskId = '$phase', attemptNo?: number): AIRunner {
  return {
    canResumeSession: id => runner.canResumeSession?.(id) ?? true,
    killAll: () => { throw new Error('单 Issue 不能执行全局中止'); },
    killByWorkDir: dir => runner.killByWorkDir(dir),
    async run(options: RunOptions) {
      const run = tracker.get(issueNumber)!.run!;
      signal.throwIfAborted();
      const identity: ExecutionIdentity = { issueNumber, planRevision: run.planRevision, buildGeneration: run.buildGeneration, dispatchId: run.dispatchId!, taskId, attemptNo: attemptNo ?? run.phaseExecutions[options.phaseName ?? 'plan'] ?? 1, callId: randomUUID() };
      tracker.transaction(issueNumber, record => {
        if (record.run!.stopIntent || record.run!.dispatchId !== identity.dispatchId) throw new Error('执行已停止');
        record.run!.activeCalls ??= {};
        record.run!.activeCalls[taskId] = identity.callId;
        record.run!.calls[identity.callId] = { identity, workDir: options.workDir, status: 'queued' };
        if (record.run!.tasks[taskId]) record.run!.tasks[taskId].identity = identity;
      });
      try {
        const result = await runner.run({ ...options, signal, identity,
          onWorkerStarted: pid => {
            tracker.assertIdentity(identity);
            tracker.transaction(issueNumber, record => { Object.assign(record.run!.calls[identity.callId], { pid, status: 'running', startedAt: new Date().toISOString() }); });
            options.onWorkerStarted?.(pid);
          },
          onStreamEvent: event => {
            try { tracker.assertIdentity(identity); } catch { return; }
            options.onStreamEvent?.({ ...event, identity });
          },
        });
        tracker.assertIdentity(identity);
        return { ...result, identity };
      } finally {
        // 退出凭证属于诊断及恢复证据，即使停止意图已保存也必须记录。
        tracker.transaction(issueNumber, record => {
          const call = record.run!.calls[identity.callId];
          if (call) { call.status = 'exited'; call.exitedAt = new Date().toISOString(); }
        });
      }
    },
  };
}
