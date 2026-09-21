<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { SystemStatus } from '@/types';
import { toWorkbenchRows } from '@/adapters/issueflowViewModel';
import { getIssueIid } from '@/types';
import * as api from '@/api/client';
import { usePipeline, loadPipelineMeta } from '@/composables/usePipeline';
import { useSSE } from '@/composables/useSSE';
import { useTasks } from '@/composables/useTasks';
import { useIssueDetail } from '@/composables/useIssueDetail';
import { repairProgress } from '@/composables/repairProgress';
import { useAgentLogs } from '@/composables/useAgentLogs';
import { useBrowse } from '@/composables/useBrowse';
import { useUrlSync } from '@/composables/useUrlSync';
import HeaderBar from '@/components/HeaderBar.vue';
import StatsCards from '@/components/StatsCards.vue';
import IssueTable from '@/components/IssueTable.vue';
import BrowsePanel from '@/components/BrowsePanel.vue';
import KnowledgePanel from '@/components/KnowledgePanel.vue';
import DistillPanel from '@/components/DistillPanel.vue';
import StartDialog from '@/components/StartDialog.vue';
import DetailModal from '@/components/DetailModal.vue';
import DraftsPanel from '@/components/DraftsPanel.vue';
import AnalyticsPanel from '@/components/AnalyticsPanel.vue';
import SettingsPanel from '@/components/SettingsPanel.vue';

const systemStatus = ref<SystemStatus | null>(null);
const mainTab = ref('tracked');
const tabs = [{id:'tracked',label:'任务工作台'},{id:'drafts',label:'需求草稿'},{id:'knowledge',label:'知识与经验'},{id:'distill',label:'蒸馏'},{id:'analytics',label:'任务统计'},{id:'settings',label:'设置'}];

const { pipelineMode } = usePipeline();
const { tasks, filter, query, filteredTasks, activeCount, completedCount, failedCount, loading: tasksLoading, error: tasksError, refresh: rawRefreshIssues } = useTasks('issue');
const workbenchRows = computed(() => toWorkbenchRows(filteredTasks.value));
const reviewCount = computed(() => tasks.value.filter(task => task.stateCategory === 'blocked').length);
const runningTask = computed(() => tasks.value.find(task => task.stateCategory === 'active'));
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
const currentVerifyFixLoop = computed(() => repairProgress(detail.selectedIssue.value, systemStatus.value?.config.verifyFixMaxIterations ?? 0));

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
  loadPipelineMeta(); // 后台加载，失败时使用默认值，不阻塞页面。
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
  <div class="app-shell">
    <aside class="app-sidebar" aria-label="工作空间导航">
      <a class="brand-lockup" href="/" aria-label="返回任务工作台">
        <span class="brand-mark">IF</span>
        <span><strong>IssueFlow</strong><small>AI ISSUE WORKSPACE</small></span>
      </a>
      <div class="repository-card"><span class="repository-dot"></span><div><strong>issue-auto-finish</strong><small>LangGraph Native</small></div></div>
      <div class="sidebar-label">工作空间</div>
      <nav class="sidebar-nav">
        <button v-for="tab in tabs" :key="tab.id" type="button" :class="{ 'is-active': mainTab === tab.id }" @click="mainTab = tab.id">
          <span class="sidebar-nav-icon" aria-hidden="true">{{ tab.id === 'tracked' ? '◈' : tab.id === 'drafts' ? '□' : tab.id === 'knowledge' ? '◇' : tab.id === 'distill' ? '✦' : tab.id === 'analytics' ? '⌁' : '⚙' }}</span>
          <span>{{ tab.label }}</span>
          <span v-if="tab.id === 'tracked'" class="sidebar-count">{{ tasks.length }}</span>
          <span v-else-if="tab.id === 'drafts'" class="sidebar-count">—</span>
        </button>
        <button type="button" :class="{ 'is-active': mainTab === 'browse' }" @click="switchToBrowse"><span class="sidebar-nav-icon" aria-hidden="true">＋</span><span>浏览平台 Issue</span></button>
      </nav>
      <div class="sidebar-tip"><strong>从需求到交付</strong><p>保持每个 Issue 的执行脉络清晰可见。</p></div>
      <div class="sidebar-footer"><span class="user-avatar">L</span><div><strong>本地工作空间</strong><small>单仓库 · 单实例</small></div></div>
    </aside>

    <div class="app-main">
      <HeaderBar :connected="connected" :system-status="systemStatus" @open-settings="mainTab = 'settings'" />

      <main id="main-content" class="main-content" tabindex="-1">
        <section class="page-heading">
          <div><div class="page-eyebrow">YOUR WORK, IN FLOW</div><h1>任务工作台</h1><p>从需求到交付，掌握每个 Issue 的执行脉络。</p></div>
          <div class="page-heading-actions"><button type="button" class="secondary-button" @click="refreshIssues">刷新数据</button><button type="button" class="primary-button" @click="switchToBrowse">新建需求</button></div>
        </section>

        <StatsCards :total="tasks.length" :active="activeCount" :review="reviewCount" :completed="completedCount" />

        <div class="workbench-columns">
          <div class="workbench-primary">
            <section v-if="reviewCount" class="review-notice" role="status">
              <div class="review-notice-icon">!</div><div><strong>{{ reviewCount }} 份实施计划等待审核</strong><p>确认任务范围与验收标准后，AI 将开始构建。</p></div>
            </section>
            <nav class="workspace-tabs" aria-label="工作台内容导航">
              <button v-for="tab in tabs" :key="tab.id" type="button" :class="{ 'is-active': mainTab === tab.id }" @click="mainTab = tab.id">{{ tab.label }}</button>
              <button type="button" :class="{ 'is-active': mainTab === 'browse' }" @click="switchToBrowse">平台 Issue</button>
            </nav>

            <IssueTable
              v-if="mainTab === 'tracked'"
              :issues="workbenchRows"
              :filter="filter"
              :query="query"
              :system-status="systemStatus"
              :loading="tasksLoading"
              :error="tasksError"
              @update:filter="filter = $event as typeof filter"
              @update:query="query = $event"
              @select="(number) => openIssueByIid(number)"
              @start="(number) => detail.doStartIssue(number, refreshIssues)"
              @retry="(number) => detail.doRetryIssue(number, refreshIssues)"
              @restart="(number) => detail.doRestartIssue(number, refreshIssues)"
              @cancel="(number) => detail.doCancelIssue(number, refreshIssues)"
            />
            <DraftsPanel v-else-if="mainTab === 'drafts'" @created="switchToBrowse" />
            <KnowledgePanel v-else-if="mainTab === 'knowledge'" :knowledge-enabled="systemStatus?.config.knowledgeEnabled" />
            <DistillPanel v-else-if="mainTab === 'distill'" />
            <AnalyticsPanel v-else-if="mainTab === 'analytics'" />
            <SettingsPanel v-else-if="mainTab === 'settings'" :system-status="systemStatus" />
            <BrowsePanel
              v-else-if="mainTab === 'browse'"
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
          </div>

          <aside v-if="mainTab === 'tracked' || mainTab === 'browse'" class="workbench-aside">
            <section class="aside-card">
              <div class="aside-card-heading"><h2>运行概况</h2><span class="healthy-pill"><span></span>正常</span></div>
              <div class="capacity-summary"><span>活跃 Issue</span><strong>{{ activeCount }} <small>/ {{ tasks.length || 0 }}</small></strong></div>
              <div class="capacity-track"><span :style="{ width: `${tasks.length ? Math.min(100, activeCount / tasks.length * 100) : 0}%` }"></span></div>
              <p class="capacity-hint">{{ tasks.length - activeCount }} 个任务等待处理</p>
              <dl class="aside-data"><div><dt>待审核</dt><dd>{{ reviewCount }} 个 Issue</dd></div><div><dt>失败待处理</dt><dd>{{ failedCount }} 个 Issue</dd></div><div><dt>当前执行器</dt><dd>{{ systemStatus?.config.aiMode ?? '—' }}</dd></div></dl>
              <button v-if="runningTask" type="button" class="current-run-card" @click="openIssueByIid(Number(runningTask.taskId))"><span>正在推进 #{{ runningTask.taskId }}</span><strong>{{ runningTask.title }}</strong><small>打开执行详情 →</small></button>
              <p v-else class="aside-empty">当前没有执行中的任务</p>
            </section>
            <section class="aside-card activity-card"><div class="aside-card-heading"><h2>实时连接</h2><span class="connection-state" :class="connected ? 'is-connected' : 'is-disconnected'"><span></span>{{ connected ? 'SSE 已连接' : '等待连接' }}</span></div><p>页面会根据 Issue、审核门禁和流水线进度事件自动刷新。</p><small>系统运行 {{ systemStatus ? Math.round(systemStatus.uptime / 1000) : 0 }} 秒</small></section>
          </aside>
        </div>
      </main>
    </div>

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
      :system-status="systemStatus"
      :verify-fix-loop="currentVerifyFixLoop"
      :agent-logs="logs.filteredLogs.value"
      :agent-auto-scroll="logs.agentAutoScroll.value"
      :agent-debug-mode="logs.debugMode.value"
      :supplement="detail.detailSupplement.value"
      :supplement-form="detail.detailSupplementForm.value"
      :supplement-loading="detail.detailSupplementLoading.value"
      :supplement-error="detail.detailSupplementError.value"
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
