import { describe, it, expect } from 'vitest';
import type {
  PhaseIntent,
  CompletedIntent,
  FailedIntent,
  AwaitGateIntent,
  AwaitAsyncIntent,
  RequestRetryFromIntent,
  PhaseError,
} from '../../orchestration/Intent.js';

/**
 * Intent 类型契约（INV-3）
 *
 * 这些测试通过 TypeScript 类型系统在编译期保证：
 * - PhaseIntent 是 discriminated union（用 kind 字段区分）
 * - 每个 Intent 子类型必须含有正确的字段
 * - PhaseOutcome.data 中的阶段专属字段不能再出现
 *
 * 编译期类型保证为主，运行时 expect 仅做 sanity check。
 */
describe('PhaseIntent discriminated union (INV-3)', () => {
  it('CompletedIntent 必须含有 kind=completed + output', () => {
    const intent: CompletedIntent = {
      kind: 'completed',
      output: 'plan completed',
      sessionId: 'sess-1',
      artifacts: [{ filename: '01-plan.md', label: '实施计划' }],
    };
    expect(intent.kind).toBe('completed');
    expect(intent.output).toBe('plan completed');
  });

  it('FailedIntent 必须含有 kind=failed + error', () => {
    const error: PhaseError = {
      message: 'AI execution failed',
      retryable: 'hard',
    };
    const intent: FailedIntent = { kind: 'failed', error };
    expect(intent.kind).toBe('failed');
    expect(intent.error.retryable).toBe('hard');
  });

  it('AwaitGateIntent 必须含有 kind=awaitGate + reason', () => {
    const intent: AwaitGateIntent = {
      kind: 'awaitGate',
      reason: 'release-confirm',
      payload: { hasReleaseCapability: true },
    };
    expect(intent.kind).toBe('awaitGate');
    expect(intent.reason).toBe('release-confirm');
  });

  it('AwaitAsyncIntent 必须含有 kind=awaitAsync + awaiter Promise', async () => {
    const fakeAwaiter: Promise<PhaseIntent> = Promise.resolve({
      kind: 'completed',
      output: 'async done',
    });
    const intent: AwaitAsyncIntent = { kind: 'awaitAsync', awaiter: fakeAwaiter };
    expect(intent.kind).toBe('awaitAsync');
    const final = await intent.awaiter;
    expect(final.kind).toBe('completed');
  });

  it('RequestRetryFromIntent 必须含有 kind=requestRetryFrom + targetPhaseId', () => {
    const intent: RequestRetryFromIntent = {
      kind: 'requestRetryFrom',
      targetPhaseId: 'build',
      reason: 'verify-failed',
      context: { failures: ['test x failed'] },
    };
    expect(intent.kind).toBe('requestRetryFrom');
    expect(intent.targetPhaseId).toBe('build');
  });

  it('switch (intent.kind) 必须穷尽所有 5 种类型（编译期 never check）', () => {
    function processIntent(intent: PhaseIntent): string {
      switch (intent.kind) {
        case 'completed':
          return `done: ${intent.output}`;
        case 'failed':
          return `failed: ${intent.error.message}`;
        case 'awaitGate':
          return `gate: ${intent.reason}`;
        case 'awaitAsync':
          return 'async';
        case 'requestRetryFrom':
          return `retry-from: ${intent.targetPhaseId}`;
      }
      // 如果未来增加新 Intent 类型，此处会报 never 错误（编译期保证穷尽）
    }

    expect(processIntent({ kind: 'completed', output: 'x' })).toBe('done: x');
    expect(processIntent({ kind: 'failed', error: { message: 'err', retryable: 'hard' } })).toBe('failed: err');
    expect(processIntent({ kind: 'awaitGate', reason: 'human-review' })).toBe('gate: human-review');
    expect(processIntent({ kind: 'awaitAsync', awaiter: Promise.resolve({ kind: 'completed', output: 'a' }) })).toBe('async');
    expect(processIntent({ kind: 'requestRetryFrom', targetPhaseId: 'build', reason: 'r' })).toBe('retry-from: build');
  });

  it('PhaseError.retryable 三态枚举', () => {
    const soft: PhaseError = { message: 'x', retryable: 'soft' };
    const hard: PhaseError = { message: 'x', retryable: 'hard' };
    const noAuto: PhaseError = { message: 'x', retryable: 'hard-no-auto' };
    expect([soft.retryable, hard.retryable, noAuto.retryable]).toEqual(['soft', 'hard', 'hard-no-auto']);
  });
});
