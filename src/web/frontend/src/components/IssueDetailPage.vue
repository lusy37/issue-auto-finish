<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { SystemStatus } from '@/types';
import { getIssueIid, getIssueTitle } from '@/types';
import * as api from '@/api/client';
import { usePipeline, loadPipelineMeta } from '@/composables/usePipeline';
import { useSSE } from '@/composables/useSSE';
import { useIssueDetail } from '@/composables/useIssueDetail';
import { useAgentLogs } from '@/composables/useAgentLogs';
import { t } from '@/i18n/index';
import { formatTime } from '@/utils/formatters';
import PipelineProgress from './PipelineProgress.vue';
import ReviewGatePanel from './ReviewGatePanel.vue';
import SupplementEditor from './SupplementEditor.vue';
import AgentLogViewer from './AgentLogViewer.vue';
import PlanDocViewer from './PlanDocViewer.vue';
import E2eArtifactsViewer from './E2eArtifactsViewer.vue';

const systemStatus = ref<SystemStatus | null>(null);
const activeTab = ref<'docs' | 'review' | 'supplement' | 'logs' | 'e2e'>('docs');
const noteSyncSaving = ref(false);

const { pipelineMode, stateLabel, stateClass, getPlanDocs, isEditableDoc } = usePipeline();
const detail = useIssueDetail();
const logs = useAgentLogs();

const selectedIssueIid = computed(() => detail.selectedIssue.value ? getIssueIid(detail.selectedIssue.value) : undefined);
const currentVerifyFixLoop = computed(() => {
  const number = selectedIssueIid.value;
  return number != null ? logs.getVerifyFixLoop(number) : undefined;
});

const noteSyncDisplay = computed(() => {
  if (!detail.selectedIssue.value) return 'system';
  const v = detail.selectedIssue.value.issueNoteSyncEnabled;
  return v === true ? 'on' : v === false ? 'off' : 'system';
});

function issueUrl(): string {
  if (!detail.selectedIssue.value || !systemStatus.value) return '#';
  const base = systemStatus.value.config.githubBaseUrl;
  const proj = systemStatus.value.config.repository;
  return `${base}/${proj}/issues/${getIssueIid(detail.selectedIssue.value)}`;
}

function getIssueIidFromUrl(): number | undefined {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('issue');
  if (!raw) return undefined;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

async function loadIssue(number: number) {
  try {
    const record = await api.fetchIssueDetail(number);
    detail.selectIssue(record, logs.agentLogs);
  } catch {
    console.warn(`Issue #${number} not found`);
  }
}

async function refreshIssues() {
  // Detail page only manages a single issue; refresh via detail.refreshDetail()
}

async function cycleNoteSync() {
  if (!detail.selectedIssue.value) return;
  const cur = detail.selectedIssue.value.issueNoteSyncEnabled;
  const next = cur === true ? false : cur === false ? undefined : true;
  noteSyncSaving.value = true;
  try {
    await api.setIssueNoteSync(getIssueIid(detail.selectedIssue.value), next === undefined ? null : next);
    await detail.refreshDetail();
  } catch (e) {
    console.error('Failed to toggle note sync', e);
  } finally {
    noteSyncSaving.value = false;
  }
}

const { connected } = useSSE((eventName, rawPayload) => {
  const payload = rawPayload as { type: string; timestamp: string; data: Record<string, unknown> };

  if (eventName.startsWith('issue:') || eventName.startsWith('gate:')) {
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
          message = t('verify.loopStarted', { max: d.maxIterations as number });
        } else if (eventName === 'verify:iterationComplete') {
          message = d.passed
            ? t('verify.iterationPassed', { n: d.iteration as number })
            : t('verify.iterationFailed', { n: d.iteration as number, reasons: ((d.failures as string[]) ?? []).join('; ') });
        } else if (eventName === 'verify:loopExhausted') {
          message = t('verify.loopExhausted', { n: d.totalIterations as number });
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

let statusInterval: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  loadPipelineMeta();
  fetchStatus();
  statusInterval = setInterval(fetchStatus, 10000);

  const number = getIssueIidFromUrl();
  if (number) {
    await loadIssue(number);
  }
});

onUnmounted(() => {
  if (statusInterval) clearInterval(statusInterval);
});
</script>

<template>
  <div v-if="detail.selectedIssue.value" class="min-h-screen bg-gray-50 flex flex-col">
    <!-- Top bar -->
    <div class="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between sticky top-0 z-10">
      <div class="flex items-center gap-3 min-w-0">
        <a href="/" class="text-sm text-blue-600 hover:text-blue-800 flex-shrink-0">{{ $t('detail.backToList') }}</a>
        <span class="text-gray-300">|</span>
        <h1 class="text-lg font-bold text-gray-800 truncate">Issue #{{ getIssueIid(detail.selectedIssue.value) }}</h1>
        <span class="text-gray-500 truncate hidden sm:inline">{{ getIssueTitle(detail.selectedIssue.value) }}</span>
        <span class="px-2.5 py-0.5 rounded-full text-xs font-medium flex-shrink-0" :class="stateClass(detail.selectedIssue.value.state)">
          {{ stateLabel(detail.selectedIssue.value.state, detail.selectedIssue.value.currentPhase) }}
        </span>
      </div>
      <div class="flex items-center gap-3 flex-shrink-0">
        <span v-if="connected" class="w-2 h-2 rounded-full bg-green-500" title="SSE connected"></span>
        <span v-else class="w-2 h-2 rounded-full bg-red-400" title="SSE disconnected"></span>
        <a
          :href="issueUrl()"
          target="_blank" rel="noopener"
          class="text-sm text-gray-500 hover:text-blue-600"
        >{{ $t('detail.viewInGitHub') }} ↗</a>
      </div>
    </div>

    <!-- Two-column layout -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Left sidebar -->
      <aside class="w-80 flex-shrink-0 border-r border-gray-200 bg-white overflow-y-auto">

        <!-- Pipeline Progress (vertical) -->
        <div class="p-4 border-b border-gray-100">
          <div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{{ $t('pipeline.title') }}</div>
          <PipelineProgress
            :issue="detail.selectedIssue.value"
            :progress="detail.detailProgress.value"
            :verify-fix-loop="currentVerifyFixLoop"
            vertical
            @retry-from-phase="(phase: string) => detail.doRetryFromPhase(getIssueIid(detail.selectedIssue.value!), phase, phase, refreshIssues)"
          />
        </div>

        <!-- Basic Info -->
        <div class="p-4 border-b border-gray-100">
          <div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{{ $t('detail.basicInfo') }}</div>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-400">{{ $t('detail.branch') }}</span>
              <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded truncate max-w-[180px]">{{ detail.selectedIssue.value.branchName }}</code>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">{{ $t('detail.retries') }}</span>
              <span>{{ detail.selectedIssue.value.attempts }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">{{ $t('detail.createdAt') }}</span>
              <span>{{ formatTime(detail.selectedIssue.value.createdAt) }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">{{ $t('detail.updatedAt') }}</span>
              <span>{{ formatTime(detail.selectedIssue.value.updatedAt) }}</span>
            </div>
          </div>
        </div>

        <!-- Settings (toggles) -->
        <div class="p-4 border-b border-gray-100">
          <div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{{ $t('detail.settings') }}</div>
          <div class="space-y-2">
            <div class="flex items-center justify-between text-sm">
              <span class="text-gray-600">{{ $t('detail.noteSync') }}</span>
              <button
                class="px-2.5 py-0.5 rounded text-xs font-medium transition-colors"
                :class="{
                  'bg-green-100 text-green-700 hover:bg-green-200': noteSyncDisplay === 'on',
                  'bg-red-100 text-red-600 hover:bg-red-200': noteSyncDisplay === 'off',
                  'bg-gray-200 text-gray-600 hover:bg-gray-300': noteSyncDisplay === 'system',
                }"
                :disabled="noteSyncSaving"
                @click="cycleNoteSync()"
              >{{ noteSyncDisplay === 'on' ? $t('detail.enabled') : noteSyncDisplay === 'off' ? $t('detail.disabled') : $t('detail.followSystem') }}</button>
            </div>
            <div class="flex items-center justify-between text-sm">
              <span class="text-gray-600">{{ $t('detail.e2eTitle') }}</span>
              <span class="text-green-700">验收为必需阶段</span>
            </div>
          </div>
        </div>

        <!-- PR Link -->
        <div v-if="detail.selectedIssue.value.prUrl" class="p-4 border-b border-gray-100">
          <div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{{ $t('detail.pullRequest') }}</div>
          <a
            v-if="detail.selectedIssue.value.prUrl"
            :href="detail.selectedIssue.value.prUrl" target="_blank" rel="noopener"
            class="text-sm text-green-600 hover:text-green-800 underline break-all"
          >{{ detail.selectedIssue.value.prUrl }}</a>

        </div>

        <!-- Preview URL -->
        <div v-if="detail.selectedIssue.value.preview?.running && detail.selectedIssue.value.preview?.previewUrl" class="p-4 border-b border-gray-100">
          <div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{{ $t('detail.previewLabel') }}</div>
          <a
            :href="detail.selectedIssue.value.preview.previewUrl" target="_blank" rel="noopener"
            class="text-sm text-indigo-600 hover:text-indigo-800 underline break-all"
          >{{ detail.selectedIssue.value.preview.previewUrl }}</a>
        </div>

        <!-- Worktree status -->
        <div
          v-if="detail.selectedIssue.value.worktree && (detail.selectedIssue.value.worktree.exists || detail.selectedIssue.value.worktree.cleanedAt)"
          class="p-4 border-b border-gray-100"
        >
          <div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{{ $t('detail.worktreeLabel') }}</div>
          <div v-if="detail.selectedIssue.value.worktree.exists" class="space-y-2">
            <div class="flex items-center gap-2 text-xs text-green-600">
              <span class="w-2 h-2 rounded-full bg-green-500"></span>
              <span>{{ $t('detail.worktreeReady') }}</span>
            </div>

          </div>
          <div v-else class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-2 text-xs text-gray-500">
              <span class="w-2 h-2 rounded-full bg-gray-400"></span>
              <span>{{ $t('detail.worktreeReclaimed') }}</span>
              <span v-if="detail.selectedIssue.value.worktree.cleanedAt" class="text-gray-400">
                · {{ formatTime(detail.selectedIssue.value.worktree.cleanedAt) }}
              </span>
            </div>
            <button
              class="px-3 py-1.5 bg-indigo-500 text-white text-xs rounded-lg hover:bg-indigo-600"
              @click="detail.doRebuildWorktree(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.rebuildWorktree') }}</button>
          </div>
        </div>

        <!-- Error -->
        <div v-if="detail.selectedIssue.value.lastError" class="p-4 border-b border-gray-100">
          <div class="bg-red-50 border border-red-200 rounded-lg p-3">
            <div class="text-xs font-semibold text-red-700 mb-1">{{ $t('detail.errorInfo') }}</div>
            <p class="text-xs text-red-600 whitespace-pre-wrap break-words">{{ detail.selectedIssue.value.lastError }}</p>
          </div>
        </div>

        <!-- Actions -->
        <div class="p-4">
          <div class="flex flex-wrap gap-2">
            <button
              v-if="detail.selectedIssue.value.state === 'skipped'"
              class="px-3 py-1.5 bg-green-500 text-white text-xs rounded-lg hover:bg-green-600"
              @click="detail.doStartIssue(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.start') }}</button>
            <button
              v-if="detail.selectedIssue.value.state === 'failed'"
              class="px-3 py-1.5 bg-blue-500 text-white text-xs rounded-lg hover:bg-blue-600"
              @click="detail.doRetryIssue(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.retry') }}</button>

            <button
              v-if="['phase_running', 'phase_done', 'phase_waiting', 'phase_approved'].includes(detail.selectedIssue.value.state)"
              class="px-3 py-1.5 bg-amber-100 text-amber-700 text-xs rounded-lg hover:bg-amber-200"
              @click="detail.doAbortIssue(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.abort') }}</button>
            <button
              v-if="detail.selectedIssue.value.state === 'paused'"
              class="px-3 py-1.5 bg-green-500 text-white text-xs rounded-lg hover:bg-green-600"
              @click="detail.doContinueIssue(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.continue') }}</button>
            <button
              v-if="detail.selectedIssue.value.state === 'paused'"
              class="px-3 py-1.5 bg-orange-500 text-white text-xs rounded-lg hover:bg-orange-600"
              @click="detail.doRedoPhase(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.redo') }}</button>
            <button
              v-if="detail.selectedIssue.value.preview?.running"
              class="px-3 py-1.5 bg-orange-100 text-orange-700 text-xs rounded-lg hover:bg-orange-200"
              @click="detail.doStopPreview(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.stopPreview') }}</button>
            <button
              v-if="!['pending', 'skipped'].includes(detail.selectedIssue.value.state) && !detail.selectedIssue.value.preview?.running"
              class="px-3 py-1.5 bg-indigo-100 text-indigo-700 text-xs rounded-lg hover:bg-indigo-200"
              @click="detail.doRestartPreview(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.restartPreview') }}</button>
            <button
              v-if="detail.selectedIssue.value.state !== 'skipped'"
              class="px-3 py-1.5 bg-yellow-100 text-yellow-700 text-xs rounded-lg hover:bg-yellow-200"
              @click="detail.doRestartIssue(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.restart') }}</button>
            <button
              class="px-3 py-1.5 bg-red-100 text-red-600 text-xs rounded-lg hover:bg-red-200"
              @click="detail.doCancelIssue(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            >{{ $t('detail.cancelTrack') }}</button>
          </div>
        </div>
      </aside>

      <!-- Right content area -->
      <div class="flex-1 flex flex-col min-w-0">
        <!-- Agent interactive dialog (above tabs, always visible) -->


        <!-- Tabs -->
        <div class="flex gap-0 border-b border-gray-200 bg-white px-4">
          <button
            v-for="tab in (['docs', 'review', 'supplement', 'logs', 'e2e'] as const)"
            :key="tab"
            class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors"
            :class="activeTab === tab ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'"
            @click="activeTab = tab"
          >{{ $t(`detail.tab.${tab}`) }}</button>
        </div>

        <!-- Tab content -->
        <div class="flex-1 flex flex-col overflow-hidden p-5">
          <!-- Docs -->
          <PlanDocViewer
            v-if="activeTab === 'docs'"
            class="flex-1 min-h-0"
            :issue-iid="getIssueIid(detail.selectedIssue.value)"
            :plan-docs="getPlanDocs(detail.selectedIssue.value)"
            :is-editable-doc="isEditableDoc"
            :detail-version="detail.detailVersion.value"
          />

          <!-- Review -->
          <div v-if="activeTab === 'review'" class="flex-1 overflow-y-auto min-h-0 space-y-4">
            <ReviewGatePanel
              :review-submitting="detail.reviewSubmitting.value"
              :review-feedback="detail.reviewFeedback.value"
              :review-history="detail.reviewHistory.value"
              :issue-state="detail.selectedIssue.value.state"
              :current-phase="detail.selectedIssue.value.currentPhase"
              :plan-doc-content="detail.planDocContent.value"
              :plan-diff="detail.planDiff.value"
              @update:review-feedback="detail.reviewFeedback.value = $event"
              @approve="detail.doApprovePlan(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
              @reject="detail.doRejectPlan(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
              @skip="detail.doSkipReview(getIssueIid(detail.selectedIssue.value!), refreshIssues)"
            />


          </div>

          <!-- Supplement -->
          <div v-if="activeTab === 'supplement'" class="flex-1 overflow-y-auto min-h-0">
            <SupplementEditor
              :supplement="detail.detailSupplement.value"
              :supplement-form="detail.detailSupplementForm.value"
              :loading="detail.detailSupplementLoading.value"
              :editing="detail.detailSupplementEditing.value"
              :saving="detail.detailSupplementSaving.value"
              :has-data="detail.hasSupplementData(detail.detailSupplement.value)"
              @edit="detail.enterSupplementEdit()"
              @save="detail.saveDetailSupplement(refreshIssues)"
              @cancel="detail.detailSupplementEditing.value = false"
              @update:supplement-form="detail.detailSupplementForm.value = $event"
            />
          </div>

          <!-- Logs -->
          <div v-if="activeTab === 'logs'" class="flex-1 overflow-y-auto min-h-0">
            <AgentLogViewer
              :logs="logs.filteredLogs.value"
              :issue-state="detail.selectedIssue.value.state"
              :current-phase="detail.selectedIssue.value.currentPhase"
              :auto-scroll="logs.agentAutoScroll.value"
              :debug-mode="logs.debugMode.value"
              @update:auto-scroll="logs.agentAutoScroll.value = $event"
              @update:debug-mode="logs.debugMode.value = $event"
              @clear="logs.clear()"
            />
          </div>

          <!-- E2E -->
          <div v-if="activeTab === 'e2e'" class="flex-1 overflow-y-auto min-h-0">
            <E2eArtifactsViewer
              :issue-iid="getIssueIid(detail.selectedIssue.value)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Loading / not found state -->
  <div v-else class="min-h-screen bg-gray-50 flex items-center justify-center">
    <div class="text-center">
      <div class="text-gray-400 text-lg mb-2">{{ $t('detail.loading') }}</div>
      <a href="/" class="text-sm text-blue-600 hover:text-blue-800">{{ $t('detail.backToList') }}</a>
    </div>
  </div>
</template>
