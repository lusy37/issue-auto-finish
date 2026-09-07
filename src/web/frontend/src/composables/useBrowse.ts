import { ref } from 'vue';
import type { GitHubIssue, SupplementInfo } from '@/types';
import * as api from '@/api/client';
import { t } from '@/i18n/index';

function emptySupplementForm(): SupplementInfo {
  return {
    requirements: '', acceptanceCriteria: '', scope: '',
    constraints: '', references: '', freeText: '',
  };
}

export function useBrowse(refreshIssues: () => Promise<void>) {
  const browseSearch = ref('');
  const browseIssues = ref<GitHubIssue[]>([]);
  const browseTrackedIids = ref(new Set<number>());
  const browseTotal = ref(0);
  const browsePage = ref(1);
  const browsePerPage = 20;
  const browseLoading = ref(false);
  const browseError = ref('');

  const startDialogIssue = ref<GitHubIssue | null>(null);
  const startSupplement = ref<SupplementInfo>(emptySupplementForm());
  const startProcessing = ref(false);

  async function fetchGitHubIssues() {
    browseLoading.value = true;
    browseError.value = '';
    try {
      const data = await api.fetchGitHubIssues({
        search: browseSearch.value.trim() || undefined,
        page: browsePage.value,
        perPage: browsePerPage,
      });
      browseIssues.value = data.issues;
      browseTotal.value = data.total;
      browseTrackedIids.value = new Set(data.trackedIids);
    } catch (e) {
      browseError.value = (e as Error).message;
    } finally {
      browseLoading.value = false;
    }
  }

  function openStartDialog(gi: GitHubIssue) {
    startDialogIssue.value = gi;
    startSupplement.value = emptySupplementForm();
    startProcessing.value = false;
  }

  function hasSupplementData(s: SupplementInfo): boolean {
    return !!(s.requirements || s.acceptanceCriteria || s.scope || s.constraints || s.references || s.freeText);
  }

  async function doStartProcessing(switchToTracked: () => void) {
    if (!startDialogIssue.value) return;
    startProcessing.value = true;
    try {
      const gi = startDialogIssue.value;
      const params: api.StartIssueParams = {
        issueId: gi.id,
        issueIid: gi.number,
        issueTitle: gi.title,
      };
      if (hasSupplementData(startSupplement.value)) {
        params.supplement = startSupplement.value;
      }
      await api.startIssue(params);
      startDialogIssue.value = null;
      await refreshIssues();
      browseTrackedIids.value.add(gi.number);
      switchToTracked();
    } catch (e) {
      alert(t('alert.startFailed') + (e as Error).message);
    } finally {
      startProcessing.value = false;
    }
  }

  return {
    browseSearch,
    browseIssues,
    browseTrackedIids,
    browseTotal,
    browsePage,
    browsePerPage,
    browseLoading,
    browseError,
    startDialogIssue,
    startSupplement,
    startProcessing,
    fetchGitHubIssues,
    openStartDialog,
    doStartProcessing,
    hasSupplementData,
  };
}
