import type { AllowedAction } from '@/adapters/issueflowViewModel';
import { ref, computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { queryClient } from '../api/queryClient.js';
import type {
  IssueRecord,
  AgentLogEntry,
} from '@/types';
import { getIssueIid } from '@/types';
import * as api from '@/api/client';
import { t } from '@/i18n/index';

export function useIssueDetail() {
  const number = ref(0);
  const detail = useQuery({
    queryKey: computed(() => ['issue', number.value, 'detail']),
    queryFn: async ({ signal }) => {
      const id = number.value;
      const value = await api.fetchIssueDetail(id, signal);
      if (getIssueIid(value) !== id) throw new Error('详情不属于当前 Issue');
      const previous = queryClient.getQueryData<IssueRecord>(['issue', id, 'detail']);
      return previous && previous.run.version > value.run.version ? previous : value;
    },
    enabled: computed(() => number.value > 0),
  }, queryClient);
  const selectedIssue = computed(() => {
    const value = detail.data.value;
    return value && getIssueIid(value) === number.value ? value : null;
  });
  const logs = useQuery({
    queryKey: computed(() => ['issue', number.value, 'logs']),
    queryFn: ({ signal }) => api.fetchIssueLogs(number.value, signal),
    enabled: false,
  }, queryClient);
  const detailLoading = computed(() => detail.isFetching.value || logs.isFetching.value);
  const detailError = computed(() =>
    detail.error.value?.message ?? logs.error.value?.message ?? '');
  const reviewFeedback = ref('');
  const reviewSubmitting = ref(false);

  async function selectIssue(id: number, agentLogs: { value: AgentLogEntry[] }) {
    number.value = id;
    reviewFeedback.value = '';
    agentLogs.value = [];
    const [, result] = await Promise.all([
      detail.refetch({ cancelRefetch: false }), logs.refetch({ cancelRefetch: false }),
    ]);
    if (number.value === id && selectedIssue.value)
      agentLogs.value = [...(result.data ?? [])].reverse();
  }
  async function refreshDetail(): Promise<void> {
    if (!selectedIssue.value) return;
    await detail.refetch({ cancelRefetch: false });
  }

  async function runIssueAction(
    number: number,
    action: (number: number) => Promise<unknown>,
    refreshIssues: () => Promise<void>,
    confirmation?: string,
  ) {
    if (confirmation && !confirm(confirmation)) return;
    await action(number);
    await refreshIssues();
  }

  const actions: Record<AllowedAction, { run: (id: number) => Promise<unknown>; confirmation?: string }> = {
    start: { run: api.startSkippedIssue, confirmation: 'confirm.start' },
    retry: { run: api.retryIssue, confirmation: 'confirm.retry' },
    cancel: { run: api.cancelIssue, confirmation: 'confirm.cancel' },
    restart: { run: api.restartIssue, confirmation: 'confirm.restart' },
    abort: { run: api.abortIssue, confirmation: 'confirm.abort' },
    continue: { run: api.continueIssue, confirmation: 'confirm.continue' },
    'redo-phase': { run: api.redoPhase, confirmation: 'confirm.redo' },
    'restart-preview': { run: api.restartPreview },
    'stop-preview': { run: api.stopPreview },
  };

  function executeAction(action: AllowedAction, number: number, refreshIssues: () => Promise<void>) {
    const { run, confirmation } = actions[action];
    return runIssueAction(number, run, refreshIssues,
      confirmation ? t(confirmation, { number }) : undefined);
  }

  async function submitReview(
    number: number,
    action: (revision: number) => Promise<void>,
    refreshIssues: () => Promise<void>,
    confirmation?: string,
  ) {
    const issue = selectedIssue.value;
    if (!issue || getIssueIid(issue) !== number) throw new Error('请先加载当前 Issue 的计划');
    reviewSubmitting.value = true;
    try {
      await runIssueAction(
        number, () => action(issue.run.planRevision), refreshIssues, confirmation,
      );
    } finally {
      reviewSubmitting.value = false;
    }
  }

  function doApprovePlan(number: number, refreshIssues: () => Promise<void>) {
    return submitReview(number, (revision) => api.approvePlan(number, revision), refreshIssues,
      t('confirm.approve', { number }));
  }

  async function doRejectPlan(number: number, refreshIssues: () => Promise<void>) {
    if (!reviewFeedback.value.trim()) throw new Error(t('confirm.reject.noFeedback'));
    const feedback = reviewFeedback.value;
    await submitReview(number, async (revision) => {
      await api.rejectPlan(number, feedback, revision);
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number)
        reviewFeedback.value = '';
    }, refreshIssues);
  }

  return {
    selectedIssue,
    reviewFeedback,
    reviewSubmitting,
    detailLoading,
    detailError,
    selectIssue,
    refreshDetail,
    executeAction,
    doApprovePlan,
    doRejectPlan,
  };
}
