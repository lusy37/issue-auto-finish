import { formatLifecycleLabel } from '../../../../shared/runtime/lifecycle.js';
import type { IssueLifecycle } from '@/types';
import { t } from '@/i18n/index';

const CATEGORY_CLASS_MAP: Record<string, string> = {
  idle: 'bg-gray-100 text-gray-600',
  skipped: 'bg-orange-100 text-orange-600',
  ready: 'bg-blue-100 text-blue-600',
  running: 'bg-blue-100 text-blue-600',
  waiting: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-600',
  paused: 'bg-amber-100 text-amber-700',
};

function lifecycleCategory(lifecycle: IssueLifecycle): string {
  switch (lifecycle.kind) {
    case 'pending':
      return 'idle';
    case 'skipped':
    case 'cancelled':
      return 'skipped';
    case 'ready':
    case 'delivering':
      return 'ready';
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'done';
  }
}

export function usePipeline() {
  function stateLabel(lifecycle: IssueLifecycle): string {
    return formatLifecycleLabel(lifecycle, t);
  }

  function stateClass(lifecycle: IssueLifecycle): string {
    return CATEGORY_CLASS_MAP[lifecycleCategory(lifecycle)] ?? CATEGORY_CLASS_MAP.idle;
  }

  function isTerminalState(lifecycle: IssueLifecycle): boolean {
    return ['completed', 'failed', 'skipped', 'cancelled'].includes(lifecycle.kind);
  }

  return { stateLabel, stateClass, isTerminalState };
}
