// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { usePipeline } from '../../src/web/frontend/src/composables/usePipeline.js';
import type { IssueLifecycle } from '../../src/web/frontend/src/types/index.js';

describe('页面生命周期展示', () => {
  it.each([
    [{ kind: 'pending' }, false, '待处理'],
    [{ kind: 'skipped' }, true, '已跳过'],
    [{ kind: 'ready' }, false, '等待执行'],
    [{ kind: 'running', phase: 'build' }, false, '实施中'],
    [{ kind: 'waiting', phase: 'review' }, false, '待审核'],
    [{ kind: 'paused', phase: 'build' }, false, '已暂停'],
    [{ kind: 'failed', retry: 'manual', error: { message: '失败', retryable: 'hard' } }, true, '失败'],
    [{ kind: 'delivering' }, false, '正在交付'],
    [{ kind: 'completed' }, true, '已完成'],
    [{ kind: 'cancelled' }, true, '已取消'],
  ] as const)('状态 %j 保留文案、样式与终态分类', (lifecycle, terminal, label) => {
    const pipeline = usePipeline();
    expect(pipeline.stateLabel(lifecycle as IssueLifecycle)).toBe(label);
    expect(pipeline.stateClass(lifecycle as IssueLifecycle)).toContain('text-');
    expect(pipeline.isTerminalState(lifecycle as IssueLifecycle)).toBe(terminal);
  });
});
