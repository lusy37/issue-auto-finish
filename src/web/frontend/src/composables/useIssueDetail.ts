import { ARTIFACTS } from '../../../../shared/runtime/artifacts.js';
import { ref, type Ref } from 'vue';
import type { IssueRecord, SupplementInfo, AgentLogEntry, ReviewRound, ExecutableTask } from '@/types';
import { getIssueIid } from '@/types';
import * as api from '@/api/client';
import { t } from '@/i18n/index';

function emptySupplementForm(): SupplementInfo {
  return {
    requirements: '', acceptanceCriteria: '', scope: '',
    constraints: '', references: '', freeText: '',
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
    return () => resourceRequests.get(key) === request && selected === selection && selectedIssue.value && getIssueIid(selectedIssue.value) === number;
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


  async function selectIssue(issue: IssueRecord, agentLogs: { value: AgentLogEntry[] }) {
    const request = ++detailRequest;
    selection++;
    detailLoading.value = true;
    detailError.value = '';
    selectedIssue.value = issue;
    detailSupplementEditing.value = false;
    detailSupplement.value = emptySupplementForm();
    reviewHistory.value = [];
    planDocContent.value = '';
    planDiff.value = { diff: '', hasChanges: false };
    agentLogs.value = [];

    try {
      const [detail, logs] = await Promise.all([
        api.fetchIssueDetail(getIssueIid(issue)),
        api.fetchIssueLogs(getIssueIid(issue)),
      ]);
      if (request !== detailRequest || !selectedIssue.value || getIssueIid(selectedIssue.value) !== getIssueIid(issue)) return;
      if ((detail.run?.version ?? 0) >= (selectedIssue.value.run?.version ?? 0)) selectedIssue.value = detail;
      agentLogs.value = logs.reverse();
    } catch (e) {
      if (request === detailRequest) detailError.value = (e as Error).message;
      console.error('Fetch detail failed', e);
    }

    if (request !== detailRequest) return;
    fetchSupplement(getIssueIid(issue));
    fetchReviewHistory(getIssueIid(issue));
    fetchPlanDocContent(getIssueIid(issue));
    fetchPlanDiff(getIssueIid(issue));
    detailLoading.value = false;
  }

  async function refreshDetail(): Promise<void> {
    if (!selectedIssue.value) return;
    const number = getIssueIid(selectedIssue.value);
    const request = ++detailRequest;
    try {
      const fresh = await api.fetchIssueDetail(number);
      if (request !== detailRequest || !selectedIssue.value || getIssueIid(selectedIssue.value) !== number) return;
      if ((fresh.run?.version ?? 0) < (selectedIssue.value.run?.version ?? 0)) return;
      selectedIssue.value = fresh;
      detailVersion.value++;
    } catch (e) {
      detailError.value = (e as Error).message;
      console.error('Refresh detail failed', e);
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
    } catch { /* ignore - history may not exist */ }
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
      if (current()) detailSupplement.value = value;
    } catch (error) {
      if (current()) detailSupplementError.value = (error as Error).message;
    }
    finally { if (current()) detailSupplementLoading.value = false; }
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
      const result = await api.saveSupplement(getIssueIid(selectedIssue.value), detailSupplementForm.value);
      detailSupplement.value = result.data ?? detailSupplementForm.value;
      detailSupplementEditing.value = false;
      if (confirm(t('confirm.supplementSaved'))) {
        await api.retryFromPhase(getIssueIid(selectedIssue.value), 'plan');
        await refreshIssues();
      }
    } catch (e) {
      alert(t('alert.saveFailed') + (e as Error).message);
    } finally {
      detailSupplementSaving.value = false;
    }
  }

  async function doStartIssue(number: number, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.start', { number }))) return;
    try {
      await api.startSkippedIssue(number);
      await refreshIssues();
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number) {
        await selectIssue(selectedIssue.value, { value: [] });
      }
    } catch (e) { alert(t('alert.startFailed') + (e as Error).message); }
  }

  async function doRetryIssue(number: number, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.retry', { number }))) return;
    try {
      await api.retryIssue(number);
      await refreshIssues();
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number) {
        await selectIssue(selectedIssue.value, { value: [] });
      }
    } catch (e) { alert(t('alert.retryFailed') + (e as Error).message); }
  }

  async function doCancelIssue(number: number, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.cancel', { number }))) return;
    try {
      await api.cancelIssue(number);
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number) selectedIssue.value = null;
      await refreshIssues();
    } catch (e) { alert(t('alert.cancelFailed') + (e as Error).message); }
  }

  async function doRestartIssue(number: number, refreshIssues: () => Promise<void>, tasks?: Ref<ExecutableTask[]>) {
    if (!confirm(t('confirm.restart', { number }))) return;
    try {
      await api.restartIssue(number);
      // 乐观更新：立即重置列表中对应 task 的进度，消除时序差
      if (tasks?.value) {
        tasks.value = tasks.value.map(task =>
          task.taskId === String(number)
            ? {
                ...task,
                lifecycle: { kind: 'pending' },
                stateCategory: 'idle',
                status: 'idle' as const,
                attempts: 0,
                lastError: undefined,
                phaseProgress: task.phaseProgress?.map(p => ({ ...p, status: 'pending' as const })),
              }
            : task,
        );
      }
      await refreshIssues();
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number) {
        await selectIssue(selectedIssue.value, { value: [] });
      }
    } catch (e) { alert(t('alert.restartFailed') + (e as Error).message); }
  }

  async function doRetryFromPhase(number: number, phase: string, phaseLabel: string, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.retryFromPhase', { phaseLabel, number }))) return;
    try {
      await api.retryFromPhase(number, phase);
      await refreshIssues();
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number) {
        await selectIssue(selectedIssue.value, { value: [] });
      }
    } catch (e) { alert(t('alert.retryFromPhaseFailed') + (e as Error).message); }
  }

  async function doApprovePlan(number: number, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.approve', { number }))) return;
    reviewSubmitting.value = true;
    try {
      await api.approvePlan(number, selectedIssue.value?.run?.planRevision ?? 0);
      await refreshIssues();
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number) {
        await selectIssue(selectedIssue.value, { value: [] });
      }
    } catch (e) { alert(t('alert.approveFailed') + (e as Error).message); }
    finally { reviewSubmitting.value = false; }
  }

  async function doRejectPlan(number: number, refreshIssues: () => Promise<void>) {
    if (!reviewFeedback.value.trim()) { alert(t('confirm.reject.noFeedback')); return; }
    reviewSubmitting.value = true;
    try {
      await api.rejectPlan(number, reviewFeedback.value, selectedIssue.value?.run?.planRevision ?? 0);
      reviewFeedback.value = '';
      await refreshIssues();
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number) {
        await selectIssue(selectedIssue.value, { value: [] });
      }
    } catch (e) { alert(t('alert.rejectFailed') + (e as Error).message); }
    finally { reviewSubmitting.value = false; }
  }

  async function doSkipReview(number: number, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.skip', { number }))) return;
    reviewSubmitting.value = true;
    try {
      await api.skipReview(number, selectedIssue.value?.run?.planRevision ?? 0);
      await refreshIssues();
      if (selectedIssue.value && getIssueIid(selectedIssue.value) === number) {
        await selectIssue(selectedIssue.value, { value: [] });
      }
    } catch (e) { alert(t('alert.skipFailed') + (e as Error).message); }
    finally { reviewSubmitting.value = false; }
  }

  async function doAbortIssue(number: number, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.abort', { number }))) return;
    try {
      await api.abortIssue(number);
      await refreshIssues();
      await refreshDetail();
    } catch (e) { alert(t('alert.abortFailed') + (e as Error).message); }
  }

  async function doContinueIssue(number: number, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.continue', { number }))) return;
    try {
      await api.continueIssue(number);
      await refreshIssues();
      await refreshDetail();
    } catch (e) { alert(t('alert.continueFailed') + (e as Error).message); }
  }

  async function doRedoPhase(number: number, refreshIssues: () => Promise<void>) {
    if (!confirm(t('confirm.redo', { number }))) return;
    try {
      await api.redoPhase(number);
      await refreshIssues();
      await refreshDetail();
    } catch (e) { alert(t('alert.redoFailed') + (e as Error).message); }
  }

  async function doRestartPreview(number: number, refreshIssues: () => Promise<void>) {
    try {
      await api.restartPreview(number);
      await refreshIssues();
      await refreshDetail();
    } catch (e) { alert(t('alert.restartPreviewFailed') + (e as Error).message); }
  }

  async function doStopPreview(number: number, refreshIssues: () => Promise<void>) {
    try {
      await api.stopPreview(number);
      await refreshIssues();
      await refreshDetail();
    } catch (e) { alert(t('alert.stopPreviewFailed') + (e as Error).message); }
  }

  async function doRebuildWorktree(number: number, refreshIssues: () => Promise<void>) {
    try {
      await api.rebuildWorktree(number);
      await refreshIssues();
      await refreshDetail();
    } catch (e) { alert(t('alert.rebuildWorktreeFailed') + (e as Error).message); }
  }

  function hasSupplementData(s: SupplementInfo | null): boolean {
    if (!s) return false;
    return !!(s.requirements || s.acceptanceCriteria || s.scope || s.constraints || s.references || s.freeText);
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
