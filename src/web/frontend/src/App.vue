<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { SystemStatus } from '@/types';
import { getIssueIid } from '@/types';
import * as api from '@/api/client';
import { usePipeline, loadPipelineMeta } from '@/composables/usePipeline';
import { useSSE } from '@/composables/useSSE';
import { useTasks } from '@/composables/useTasks';
import { useIssueDetail } from '@/composables/useIssueDetail';
import { useAgentLogs } from '@/composables/useAgentLogs';
import { useBrowse } from '@/composables/useBrowse';
import { useUrlSync } from '@/composables/useUrlSync';
import { t } from '@/i18n/index';
import HeaderBar from '@/components/HeaderBar.vue';
import StatsCards from '@/components/StatsCards.vue';
import IssueTable from '@/components/IssueTable.vue';
import BrowsePanel from '@/components/BrowsePanel.vue';
import KnowledgePanel from '@/components/KnowledgePanel.vue';
import DistillPanel from '@/components/DistillPanel.vue';
import StartDialog from '@/components/StartDialog.vue';
import DetailModal from '@/components/DetailModal.vue';
import IssueDetailPage from '@/components/IssueDetailPage.vue';
import DraftsPanel from '@/components/DraftsPanel.vue';
import AnalyticsPanel from '@/components/AnalyticsPanel.vue';
import SettingsPanel from '@/components/SettingsPanel.vue';

const systemStatus = ref<SystemStatus | null>(null);
const isDetailPage = ref(window.location.pathname === '/detail');
const mainTab = ref('tracked');
const tabs = [{id:'tracked',label:'任务工作台'},{id:'drafts',label:'需求拆分'},{id:'knowledge',label:'知识与经验'},{id:'distill',label:'蒸馏'},{id:'analytics',label:'任务统计'},{id:'settings',label:'设置'}];

const { pipelineMode } = usePipeline();
const { tasks, filter, filteredTasks, activeCount, completedCount, failedCount, refresh: rawRefreshIssues } = useTasks('issue');
const detail = useIssueDetail();

let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
async function refreshIssues() {
  if (refreshDebounceTimer) return;
  await rawRefreshIssues();
  refreshDebounceTimer = setTimeout(() => { refreshDebounceTimer = null; }, 400);
}
const logs = useAgentLogs();
const browse = useBrowse(refreshIssues);

const selectedIssueIid = computed(() => detail.selectedIssue.value ? getIssueIid(detail.selectedIssue.value) : undefined);
const currentVerifyFixLoop = computed(() => {
  const number = selectedIssueIid.value;
  return number != null ? logs.getVerifyFixLoop(number) : undefined;
});

async function openIssueByIid(number: number) {
  try {
    const record = await api.fetchIssueDetail(number);
    detail.selectIssue(record, logs.agentLogs);
  } catch {
    console.warn(`Issue #${number} not found, ignoring URL param`);
  }
}

const { readIssueIidFromUrl } = useUrlSync({
  selectedIssueIid,
  onOpenIssue: openIssueByIid,
});

const { connected } = useSSE((eventName, rawPayload) => {
  const payload = rawPayload as { type: string; timestamp: string; data: Record<string, unknown> };

  if (eventName.startsWith('issue:') || eventName.startsWith('gate:')) {
    refreshIssues();
    const d = payload.data;
    if (d?.issueIid && detail.selectedIssue.value && getIssueIid(detail.selectedIssue.value) === d.issueIid) {
      detail.refreshDetail();
    }
  }

  if (eventName === 'agent:output') {
    const d = payload.data;
    if (d?.event) {
      logs.pushAgentStreamEvent(
        d.issueIid as number,
        selectedIssueIid,
        d.phase as string | undefined,
        d.event as { type?: string; content?: unknown; timestamp?: string },
      );
    }
  }

  if (eventName === 'pipeline:progress') {
    const d = payload.data;
    if (d && detail.selectedIssue.value && getIssueIid(detail.selectedIssue.value) === d.issueIid) {
      detail.refreshDetail();
      logs.pushSystemLog(
        d.issueIid as number,
        selectedIssueIid,
        d.step as string | undefined,
        (d.message as string) ?? '',
        payload.timestamp,
      );
    }
  }

  if (eventName.startsWith('verify:')) {
    const d = payload.data;
    const number = d?.issueIid as number | undefined;
    if (number) {
      logs.updateVerifyFixLoop(number, eventName, d as Record<string, unknown>);
      if (detail.selectedIssue.value && getIssueIid(detail.selectedIssue.value) === number) {
        let message = '';
        if (eventName === 'verify:loopStarted') {
          message = t('verify.loopStarted', { max: Number(d.maxIterations) });
        } else if (eventName === 'verify:iterationComplete') {
          message = d.passed
            ? t('verify.iterationPassed', { n: Number(d.iteration) })
            : t('verify.iterationFailed', { n: Number(d.iteration), reasons: ((d.failures as string[]) ?? []).join('; ') });
        } else if (eventName === 'verify:loopExhausted') {
          message = t('verify.loopExhausted', { n: Number(d.totalIterations) });
        }
        if (message) {
          logs.pushSystemLog(number, selectedIssueIid, 'verify', message, payload.timestamp);
        }
      }
    }
  }
});

async function fetchStatus() {
  try {
    systemStatus.value = await api.fetchSystemStatus();
    if (systemStatus.value?.config?.pipelineMode) {
      pipelineMode.value = systemStatus.value.config.pipelineMode;
    }
  } catch (e) {
    console.error('Fetch status failed', e);
  }
}

function switchToBrowse() {
  mainTab.value = 'browse';
  if (browse.browseIssues.value.length === 0) browse.fetchGitHubIssues();
}

let statusInterval: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  loadPipelineMeta(); // fire-and-forget, 降级不阻塞
  await refreshIssues();
  fetchStatus();
  statusInterval = setInterval(fetchStatus, 10000);

  const urlIid = readIssueIidFromUrl();
  if (urlIid) {
    openIssueByIid(urlIid);
  }
});

onUnmounted(() => {
  if (statusInterval) clearInterval(statusInterval);
});
</script>

<template>
  <!-- Full-page detail view -->
  <IssueDetailPage v-if="isDetailPage" />

  <!-- Normal dashboard view -->
  <div v-else>
    <HeaderBar :connected="connected" :system-status="systemStatus" @open-settings="mainTab = 'settings'" />

    <main class="max-w-7xl mx-auto px-4 py-6">
      <StatsCards
        :total="tasks.length"
        :active="activeCount"
        :completed="completedCount"
        :failed="failedCount"
      />

      <nav class="mb-4 flex flex-wrap gap-2 border-b pb-3" aria-label="工作台导航"><button v-for="tab in tabs" :key="tab.id" class="px-4 py-2 rounded" :class="mainTab===tab.id || (mainTab==='browse' && tab.id==='tracked') ? 'bg-gray-800 text-white' : 'bg-white text-gray-600'" @click="mainTab=tab.id">{{tab.label}}</button></nav>
      <div v-if="mainTab==='tracked' || mainTab==='browse'" class="mb-4 flex gap-4"><button @click="mainTab='tracked'">已跟踪任务</button><button @click="switchToBrowse">浏览平台 Issue</button></div>
      <DraftsPanel v-if="mainTab==='drafts'" @created="switchToBrowse" />
      <AnalyticsPanel v-if="mainTab==='analytics'" />
      <!-- Tracked Issues Tab -->
      <IssueTable
        v-if="mainTab === 'tracked'"
        :issues="filteredTasks"
        :filter="filter"
        :system-status="systemStatus"
        @update:filter="filter = $event as typeof filter"
        @select="(number) => openIssueByIid(number)"
        @start="(number) => detail.doStartIssue(number, refreshIssues)"
        @retry="(number) => detail.doRetryIssue(number, refreshIssues)"
        @restart="(number) => detail.doRestartIssue(number, refreshIssues)"
        @cancel="(number) => detail.doCancelIssue(number, refreshIssues)"
      />

      <!-- Knowledge Tab -->
      <KnowledgePanel v-if="mainTab === 'knowledge'" />

      <!-- Distill Tab -->
      <DistillPanel v-if="mainTab === 'distill'" />

      <!-- Settings Tab -->
      <SettingsPanel v-if="mainTab === 'settings'" :system-status="systemStatus" />

      <!-- Browse Tab -->
      <BrowsePanel
        v-if="mainTab === 'browse'"
        :issues="browse.browseIssues.value"
        :tracked-iids="browse.browseTrackedIids.value"
        :total="browse.browseTotal.value"
        :page="browse.browsePage.value"
        :per-page="browse.browsePerPage"
        :loading="browse.browseLoading.value"
        :error="browse.browseError.value"
        :search="browse.browseSearch.value"
        :system-status="systemStatus"
        @update:search="browse.browseSearch.value = $event"
        @update:page="browse.browsePage.value = $event"
        @search="browse.fetchGitHubIssues()"
        @start="browse.openStartDialog($event)"
      />
    </main>

    <!-- Start Dialog -->
    <StartDialog
      :issue="browse.startDialogIssue.value"
      :supplement="browse.startSupplement.value"
      :processing="browse.startProcessing.value"
      @close="browse.startDialogIssue.value = null"
      @update:supplement="browse.startSupplement.value = $event"
      @start="browse.doStartProcessing(() => { mainTab = 'tracked'; })"
    />

    <!-- Detail Modal -->
    <DetailModal
      v-if="detail.selectedIssue.value"
      :issue="detail.selectedIssue.value"
      :progress="detail.detailProgress.value"
      :system-status="systemStatus"
      :verify-fix-loop="currentVerifyFixLoop"
      :agent-logs="logs.filteredLogs.value"
      :agent-auto-scroll="logs.agentAutoScroll.value"
      :agent-debug-mode="logs.debugMode.value"
      :supplement="detail.detailSupplement.value"
      :supplement-form="detail.detailSupplementForm.value"
      :supplement-loading="detail.detailSupplementLoading.value"
      :supplement-editing="detail.detailSupplementEditing.value"
      :supplement-saving="detail.detailSupplementSaving.value"
      :has-supplement-data="detail.hasSupplementData(detail.detailSupplement.value)"
      :detail-version="detail.detailVersion.value"
      :review-feedback="detail.reviewFeedback.value"
      :review-submitting="detail.reviewSubmitting.value"
      :review-history="detail.reviewHistory.value"
      :plan-doc-content="detail.planDocContent.value"
      @close="detail.selectedIssue.value = null"
      @start="(number) => detail.doStartIssue(number, refreshIssues)"
      @retry="(number) => detail.doRetryIssue(number, refreshIssues)"
      @restart="(number) => detail.doRestartIssue(number, refreshIssues)"
      @cancel="(number) => detail.doCancelIssue(number, refreshIssues)"
      @stop-preview="(number) => detail.doStopPreview(number, refreshIssues)"
      @restart-preview="(number) => detail.doRestartPreview(number, refreshIssues)"
      @retry-from-phase="(number, phase) => detail.doRetryFromPhase(number, phase, phase, refreshIssues)"
      @approve="(number) => detail.doApprovePlan(number, refreshIssues)"
      @reject="(number) => detail.doRejectPlan(number, refreshIssues)"
      @skip="(number) => detail.doSkipReview(number, refreshIssues)"
      @update:review-feedback="detail.reviewFeedback.value = $event"
      @supplement-edit="detail.enterSupplementEdit()"
      @supplement-save="detail.saveDetailSupplement(refreshIssues)"
      @supplement-cancel="detail.detailSupplementEditing.value = false"
      @update:supplement-form="detail.detailSupplementForm.value = $event"
      @update:agent-auto-scroll="logs.agentAutoScroll.value = $event"
      @update:agent-debug-mode="logs.debugMode.value = $event"
      @clear-logs="logs.clear()"
    />
  </div>
</template>
