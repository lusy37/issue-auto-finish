import { ARTIFACTS } from '../../../../shared/runtime/artifacts.js';
import { ref } from 'vue';
import type {
  IssueRecord,
  SupplementInfo,
  AgentLogEntry,
  ReviewRound,
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
  const selectedIssue = ref<IssueRecord | null>(null);
  const detailLoading = ref(false);
  const detailError = ref('');
  const detailVersion = ref(0);
  let detailRequest = 0;
  let selection = 0;
  const resourceRequests = new Map<string, number>();
  function resourceGuard(key: string, number: number) {
    const request = (resourceRequests.get(key) ?? 0) + 1;
    resourceRequests.set(key, request);
    const selected = selection;
    return () =>
      resourceRequests.get(key) === request &&
      selected === selection &&
      selectedIssue.value &&
      getIssueIid(selectedIssue.value) === number;
  }

  const detailSupplement = ref<SupplementInfo>(emptySupplementForm());
  const detailSupplementForm = ref<SupplementInfo>(emptySupplementForm());
  const detailSupplementLoading = ref(false);
  const detailSupplementError = ref('');
  const detailSupplementEditing = ref(false);
  const detailSupplementSaving = ref(false);

  const reviewFeedback = ref('');
  const reviewSubmitting = ref(false);
  const reviewHistory = ref<ReviewRound[]>([]);
  const planDocContent = ref('');
  const planDiff = ref<{ diff: string; hasChanges: boolean }>({ diff: '', hasChanges: false });

  async function selectIssue(number: number, agentLogs: { value: AgentLogEntry[] }) {
    const request = ++detailRequest;
    const selected = ++selection;
    detailLoading.value = true;
    detailError.value = '';
    selectedIssue.value = null;
    detailSupplementEditing.value = false;
    detailSupplement.value = emptySupplementForm();
    reviewFeedback.value = '';
    reviewHistory.value = [];
    planDocContent.value = '';
    planDiff.value = { diff: '', hasChanges: false };
    agentLogs.value = [];

    try {
      const [detail, logs] = await Promise.all([
        api.fetchIssueDetail(number),
        api.fetchIssueLogs(number),
      ]);
      if (request !== detailRequest) return;
      selectedIssue.value = detail;
      agentLogs.value = logs.reverse();
      fetchSupplement(number);
      fetchReviewHistory(number);
      fetchPlanDocContent(number);
      fetchPlanDiff(number);
    } catch (e) {
      if (request === detailRequest) detailError.value = (e as Error).message;
    } finally {
      if (selected === selection) detailLoading.value = false;
    }
  }

  async function refreshDetail(): Promise<void> {
    if (!selectedIssue.value) return;
    const number = getIssueIid(selectedIssue.value);
    const request = ++detailRequest;
    detailError.value = '';
    try {
      const fresh = await api.fetchIssueDetail(number);
      if (
        request !== detailRequest ||
        !selectedIssue.value ||
        getIssueIid(selectedIssue.value) !== number
      )
        return;
      if (fresh.run.version < selectedIssue.value.run.version) return;
      selectedIssue.value = fresh;
      detailVersion.value++;
    } catch (e) {
      if (request === detailRequest) detailError.value = (e as Error).message;
    }
    if (request !== detailRequest) return;
    fetchReviewHistory(number);
    fetchPlanDocContent(number);
    fetchPlanDiff(number);
  }

  async function fetchReviewHistory(number: number) {
    const current = resourceGuard('fetchReviewHistory', number);
    try {
      const value = await api.fetchReviewHistory(number);
      if (current()) reviewHistory.value = value;
    } catch {
      /* ignore - history may not exist */
    }
  }

  async function fetchPlanDocContent(number: number) {
    const current = resourceGuard('fetchPlanDocContent', number);
    try {
      const value = await api.loadPlanDoc(number, ARTIFACTS.plan.filename, 'html');
      if (current()) planDocContent.value = value;
    } catch {
      if (current()) planDocContent.value = '';
    }
  }

  async function fetchPlanDiff(number: number) {
    const current = resourceGuard('fetchPlanDiff', number);
    try {
      const value = await api.fetchPlanDiff(number, ARTIFACTS.plan.filename);
      if (current()) planDiff.value = value;
    } catch {
      if (current()) planDiff.value = { diff: '', hasChanges: false };
    }
  }

  async function fetchSupplement(number: number) {
    const current = resourceGuard('fetchSupplement', number);
    detailSupplementLoading.value = true;
    detailSupplementError.value = '';
    try {
      const value = await api.fetchSupplement(number);
      if (current()) detailSupplement.value = value ?? emptySupplementForm();
    } catch (error) {
      if (current()) detailSupplementError.value = (error as Error).message;
    } finally {
      if (current()) detailSupplementLoading.value = false;
    }
  }

  function enterSupplementEdit() {
    if (detailSupplementLoading.value || detailSupplementError.value) return;
    detailSupplementForm.value = { ...detailSupplement.value };
    detailSupplementEditing.value = true;
  }

  async function saveDetailSupplement(refreshIssues: () => Promise<void>) {
    if (!selectedIssue.value) return;
    detailSupplementSaving.value = true;
    try {
      const result = await api.saveSupplement(
        getIssueIid(selectedIssue.value),
        detailSupplementForm.value,
      );
      detailSupplement.value = result.data;
      detailSupplementEditing.value = false;
      if (confirm(t('confirm.supplementSaved'))) {
        await api.retryFromPhase(getIssueIid(selectedIssue.value), 'plan');
        await refreshIssues();
      }
    } finally {
      detailSupplementSaving.value = false;
    }
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
