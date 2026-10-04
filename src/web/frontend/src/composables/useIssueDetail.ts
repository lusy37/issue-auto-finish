import { ARTIFACTS } from '../../../../shared/runtime/artifacts.js';
import { ref, computed } from 'vue';
import { useQuery, useMutation } from '@tanstack/vue-query';
import { queryClient } from '../api/queryClient.js';
import type {
  IssueRecord,
  SupplementInfo,
  AgentLogEntry,
} from '@/types';
import { getIssueIid } from '@/types';
import * as api from '@/api/client';
import { t } from '@/i18n/index';

function emptySupplementForm(): SupplementInfo {
  return {
    requirements: '',
    acceptanceCriteria: '',
    scope: '',
    constraints: '',
    references: '',
    freeText: '',
  };
}

export function useIssueDetail() {
  const number = ref(0);
  const detailVersion = ref(0);
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
  function resource<T>(name: string, load: (id: number, signal?: AbortSignal) => Promise<T>) {
    return useQuery({
      queryKey: computed(() => ['issue', number.value, name]),
      queryFn: ({ signal }) => load(number.value, signal),
      enabled: computed(() => selectedIssue.value !== null),
    }, queryClient);
  }
  const supplement = resource('supplement', api.fetchSupplement);
  const history = resource('review-history', api.fetchReviewHistory);
  const plan = resource('plan', (id, signal) =>
    api.loadPlanDoc(id, ARTIFACTS.plan.filename, 'html', signal));
  const diff = resource('plan-diff', (id, signal) =>
    api.fetchPlanDiff(id, ARTIFACTS.plan.filename, signal));
  const logs = useQuery({
    queryKey: computed(() => ['issue', number.value, 'logs']),
    queryFn: ({ signal }) => api.fetchIssueLogs(number.value, signal),
    enabled: false,
  }, queryClient);
  const detailLoading = computed(() => detail.isFetching.value || logs.isFetching.value);
  const detailError = computed(() =>
    detail.error.value?.message ?? logs.error.value?.message ?? '');
  const detailSupplement = computed(() => supplement.data.value ?? emptySupplementForm());
  const detailSupplementForm = ref<SupplementInfo>(emptySupplementForm());
  const detailSupplementLoading = supplement.isFetching;
  const detailSupplementError = computed(() => supplement.error.value?.message ?? '');
  const detailSupplementEditing = ref(false);
  const detailSupplementSaving = ref(false);
  const reviewFeedback = ref('');
  const reviewSubmitting = ref(false);
  const reviewHistory = computed(() => history.data.value ?? []);
  const planDocContent = computed(() => plan.data.value ?? '');
  const planDiff = computed(() => diff.data.value ?? { diff: '', hasChanges: false });
  const action = useMutation({
    mutationFn: (input: { number: number; run: (id: number) => Promise<unknown> }) =>
      input.run(input.number),
  }, queryClient);

  async function selectIssue(id: number, agentLogs: { value: AgentLogEntry[] }) {
    number.value = id;
    detailSupplementEditing.value = false;
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
    const id = number.value;
    const result = await detail.refetch({ cancelRefetch: false });
    if (number.value !== id || result.isError) return;
    detailVersion.value++;
    await Promise.all([supplement, history, plan, diff].map((query) =>
      query.refetch({ cancelRefetch: false })));
  }

  function enterSupplementEdit() {
    if (detailSupplementLoading.value || detailSupplementError.value) return;
    detailSupplementForm.value = { ...detailSupplement.value };
    detailSupplementEditing.value = true;
  }

  async function saveDetailSupplement(refreshIssues: () => Promise<void>) {
    if (!selectedIssue.value) return;
    const id = getIssueIid(selectedIssue.value);
    detailSupplementSaving.value = true;
    try {
      const result = await api.saveSupplement(
        id,
        detailSupplementForm.value,
      );
      queryClient.setQueryData(['issue', id, 'supplement'], result.data);
      if (number.value !== id) return;
      detailSupplementEditing.value = false;
      if (confirm(t('confirm.supplementSaved'))) {
        await api.retryFromPhase(id, 'plan');
        await refreshIssues();
      }
    } finally {
      detailSupplementSaving.value = false;
    }
  }

  async function actionMutation(id: number, run: (id: number) => Promise<unknown>) {
    await action.mutateAsync({ number: id, run });
  }

  async function runIssueAction(
    number: number,
    action: (number: number) => Promise<unknown>,
    refreshIssues: () => Promise<void>,
    confirmation?: string,
  ) {
    if (confirmation && !confirm(confirmation)) return;
    await actionMutation(number, action);
    await refreshIssues();
  }

  function doStartIssue(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.startSkippedIssue, refreshIssues,
      t('confirm.start', { number }));
  }

  function doRetryIssue(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.retryIssue, refreshIssues,
      t('confirm.retry', { number }));
  }

  function doCancelIssue(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.cancelIssue, refreshIssues,
      t('confirm.cancel', { number }));
  }

  function doRestartIssue(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.restartIssue, refreshIssues,
      t('confirm.restart', { number }));
  }

  function doRetryFromPhase(
    number: number,
    phase: string,
    phaseLabel: string,
    refreshIssues: () => Promise<void>,
  ) {
    return runIssueAction(number, () => api.retryFromPhase(number, phase), refreshIssues,
      t('confirm.retryFromPhase', { phaseLabel, number }));
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

  function doSkipReview(number: number, refreshIssues: () => Promise<void>) {
    return submitReview(number, (revision) => api.skipReview(number, revision), refreshIssues,
      t('confirm.skip', { number }));
  }

  function doAbortIssue(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.abortIssue, refreshIssues,
      t('confirm.abort', { number }));
  }

  function doContinueIssue(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.continueIssue, refreshIssues,
      t('confirm.continue', { number }));
  }

  function doRedoPhase(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.redoPhase, refreshIssues,
      t('confirm.redo', { number }));
  }

  function doRestartPreview(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.restartPreview, refreshIssues);
  }

  function doStopPreview(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.stopPreview, refreshIssues);
  }

  function doRebuildWorktree(number: number, refreshIssues: () => Promise<void>) {
    return runIssueAction(number, api.rebuildWorktree, refreshIssues);
  }

  function hasSupplementData(s: SupplementInfo | null): boolean {
    if (!s) return false;
    return !!(
      s.requirements ||
      s.acceptanceCriteria ||
      s.scope ||
      s.constraints ||
      s.references ||
      s.freeText
    );
  }

  return {
    selectedIssue,
    detailVersion,
    detailSupplement,
    detailSupplementForm,
    detailSupplementLoading,
    detailSupplementError,
    detailSupplementEditing,
    detailSupplementSaving,
    reviewFeedback,
    reviewSubmitting,
    reviewHistory,
    planDocContent,
    detailLoading,
    detailError,
    planDiff,
    selectIssue,
    refreshDetail,
    enterSupplementEdit,
    saveDetailSupplement,
    doStartIssue,
    doRetryIssue,
    doCancelIssue,
    doRestartIssue,
    doRetryFromPhase,
    doApprovePlan,
    doRejectPlan,
    doSkipReview,
    doAbortIssue,
    doContinueIssue,
    doRedoPhase,
    doRestartPreview,
    doStopPreview,
    doRebuildWorktree,
    hasSupplementData,
  };
}
