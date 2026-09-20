<script setup lang="ts">
import TaskGraphPanel from "./TaskGraphPanel.vue";
import { ref, computed } from 'vue';
import type { IssueRecord, SupplementInfo, AgentLogEntry, SystemStatus, ReviewRound } from '@/types';
import type { VerifyFixLoopState } from '@/composables/repairProgress';
import { getIssueIid, getIssueTitle, getReviewApprovalSource } from '@/types';
import { usePipeline } from '@/composables/usePipeline';
import { formatTime } from '@/utils/formatters';
import * as api from '@/api/client';
import PipelineProgress from './PipelineProgress.vue';
import ReviewGatePanel from './ReviewGatePanel.vue';
import SupplementEditor from './SupplementEditor.vue';
import AgentLogViewer from './AgentLogViewer.vue';
import PlanDocViewer from './PlanDocViewer.vue';
import E2eArtifactsViewer from './E2eArtifactsViewer.vue';

const props = defineProps<{
  issue: IssueRecord;
  systemStatus: SystemStatus | null;
  verifyFixLoop?: VerifyFixLoopState;
  agentLogs: AgentLogEntry[];
  agentAutoScroll: boolean;
  agentDebugMode: boolean;
  // Supplement
  supplement: SupplementInfo;
  supplementForm: SupplementInfo;
  supplementLoading: boolean;
  supplementError?: string;
  supplementEditing: boolean;
  supplementSaving: boolean;
  hasSupplementData: boolean;
  detailVersion: number;
  // Review
  reviewFeedback: string;
  reviewSubmitting: boolean;
  reviewHistory: ReviewRound[];
  planDocContent?: string;
}>();

const emit = defineEmits<{
  close: [];
  start: [number: number];
  retry: [number: number];
  restart: [number: number];
  cancel: [number: number];
  abort: [number: number];
  continue: [number: number];
  redo: [number: number];
  stopPreview: [number: number];
  restartPreview: [number: number];
  retryFromPhase: [number: number, phase: string];
  // Release-gate (连线胶囊批准)
  // Review
  approve: [number: number];
  reject: [number: number];
  skip: [number: number];
  'update:reviewFeedback': [value: string];
  // Supplement
  supplementEdit: [];
  supplementSave: [];
  supplementCancel: [];
  'update:supplementForm': [value: SupplementInfo];
  // Agent logs
  'update:agentAutoScroll': [value: boolean];
  'update:agentDebugMode': [value: boolean];
  clearLogs: [];
  // Interactive dialog
}>();

const { stateLabel, stateClass, getPlanDocs, isEditableDoc } = usePipeline();
const retryCount = computed(() => Object.values(props.issue.run?.retryUsed ?? {}).reduce((sum, value) => sum + value, 0));
const issueError = computed(() => props.issue.lifecycle.kind === 'failed' ? props.issue.lifecycle.error.message : undefined);

function issueUrl(): string {
  if (!props.systemStatus) return '#';
  const base = props.systemStatus.config.githubBaseUrl;
  const proj = props.systemStatus.config.repository;
  return `${base}/${proj}/issues/${getIssueIid(props.issue)}`;
}

const noteSyncLocal = ref<boolean | undefined>(props.issue.issueNoteSyncEnabled);
const noteSyncSaving = ref(false);

const noteSyncDisplay = computed(() => {
  if (noteSyncLocal.value === true) return 'on';
  if (noteSyncLocal.value === false) return 'off';
  return 'system';
});

async function cycleNoteSync() {
  const order: Array<boolean | undefined> = [undefined, true, false];
  const idx = order.indexOf(noteSyncLocal.value);
  const next = order[(idx + 1) % order.length];
  noteSyncLocal.value = next;
  noteSyncSaving.value = true;
  try {
    await api.setIssueNoteSync(getIssueIid(props.issue), next === undefined ? null : next);
  } catch (e) {
    console.error('Failed to toggle note sync', e);
  } finally {
    noteSyncSaving.value = false;
  }
}

function openDetailPage() {
  window.open(`/detail?issue=${getIssueIid(props.issue)}`, '_blank');
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex">
      <div class="absolute inset-0 bg-black/30" @click="emit('close')" />
      <div class="relative ml-auto w-full max-w-2xl bg-white shadow-xl overflow-y-auto">
        <div class="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
          <div class="flex items-center space-x-2">
            <h2 class="text-lg font-bold text-gray-800">Issue #{{ getIssueIid(issue) }}</h2>
            <a
              :href="issueUrl()" target="_blank" rel="noopener"
              class="inline-flex items-center px-2 py-0.5 text-xs font-medium text-blue-600 bg-blue-50 rounded hover:bg-blue-100 hover:text-blue-800 transition-colors"
            >
              {{ $t('detail.viewInGitHub') }}
              <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </a>
            <button
              class="inline-flex items-center px-2 py-0.5 text-xs font-medium text-gray-600 bg-gray-100 rounded hover:bg-gray-200 hover:text-gray-800 transition-colors"
              @click="openDetailPage()"
            >
              {{ $t('detail.openFullPage') }}
              <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m7-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m7 5v-4m0 4h-4m4 0l-5-5"/></svg>
            </button>
          </div>
          <button class="text-gray-400 hover:text-gray-600 text-2xl leading-none" @click="emit('close')">&times;</button>
        </div>

        <div class="px-6 py-4 space-y-6">
          <!-- Basic Info -->
          <div>
            <h3 class="text-base font-semibold text-gray-700 mb-2">{{ $t('detail.basicInfo') }}</h3>
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div><span class="text-gray-500">{{ $t('detail.title') }}</span> <span class="text-gray-800">{{ getIssueTitle(issue) }}</span></div>
              <div><span class="text-gray-500">{{ $t('detail.branch') }}</span> <code class="text-xs bg-gray-100 px-1 py-0.5 rounded">{{ issue.branchName }}</code></div>
              <div>
                <span class="text-gray-500">{{ $t('detail.state') }}</span>
                <span class="px-2 py-0.5 rounded-full text-xs font-medium" :class="stateClass(issue.lifecycle)">{{ stateLabel(issue.lifecycle) }}</span>
              </div>
              <div><span class="text-gray-500">{{ $t('detail.createdAt') }}</span> {{ formatTime(issue.createdAt) }}</div>
              <div><span class="text-gray-500">{{ $t('detail.retries') }}</span> {{ retryCount }}</div>
              <div><span class="text-gray-500">{{ $t('detail.updatedAt') }}</span> {{ formatTime(issue.updatedAt) }}</div>
            </div>
          </div>

          <TaskGraphPanel :issue-number="getIssueIid(issue)" :state-version="issue.run?.version" />

          <!-- Note Sync Toggle -->
          <div class="flex items-center justify-between text-sm bg-gray-50 rounded-lg px-4 py-2.5 border border-gray-200">
            <span class="text-gray-600">{{ $t('detail.noteSync') }}</span>
            <button
              class="px-3 py-1 rounded text-xs font-medium transition-colors"
              :class="{
                'bg-green-100 text-green-700 hover:bg-green-200': noteSyncDisplay === 'on',
                'bg-red-100 text-red-600 hover:bg-red-200': noteSyncDisplay === 'off',
                'bg-gray-200 text-gray-600 hover:bg-gray-300': noteSyncDisplay === 'system',
              }"
              :disabled="noteSyncSaving"
              @click="cycleNoteSync()"
            >
              {{ noteSyncDisplay === 'on' ? $t('detail.enabled') : noteSyncDisplay === 'off' ? $t('detail.disabled') : $t('detail.followSystem') }}
            </button>
          </div>

          <!-- E2E UI Toggle -->
          <div class="flex items-center justify-between text-sm bg-gray-50 rounded-lg px-4 py-2.5 border border-gray-200">
            <span class="text-gray-600">{{ $t('detail.e2eTitle') }}</span>
            <span class="text-green-700">验收为必需阶段</span>
          </div>

          <!-- PR Link -->
          <div v-if="issue.prUrl" class="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center space-x-2">
            <span class="text-sm text-green-700 font-medium">{{ $t('detail.mrLabel') }}</span>
            <a
              :href="issue.prUrl" target="_blank" rel="noopener"
              class="text-sm text-green-600 hover:text-green-800 underline break-all"
            >{{ issue.prUrl }}</a>
          </div>




          <!-- Preview URL -->
          <div v-if="issue.preview?.running && issue.preview?.previewUrl" class="bg-indigo-50 border border-indigo-200 rounded-lg p-4 flex items-center space-x-2">
            <span class="text-sm text-indigo-700 font-medium">{{ $t('detail.previewLabel') }}</span>
            <a
              :href="issue.preview.previewUrl" target="_blank" rel="noopener"
              class="text-sm text-indigo-600 hover:text-indigo-800 underline break-all"
            >{{ issue.preview.previewUrl }}</a>
          </div>

          <!-- Agent interactive dialog -->


          <!-- Error -->
          <div v-if="issueError" class="bg-red-50 border border-red-200 rounded-lg p-4">
            <h3 class="text-sm font-semibold text-red-700 mb-1">{{ $t('detail.errorInfo') }}</h3>
            <p class="text-sm text-red-600 whitespace-pre-wrap break-words">{{ issueError }}</p>
          </div>

          <!-- Pipeline -->
          <PipelineProgress
            :issue="issue"
            :verify-fix-loop="verifyFixLoop"
            @retry-from-phase="(phase: string) => emit('retryFromPhase', getIssueIid(issue), phase)"
          />

          <!-- Review Gate -->
          <ReviewGatePanel
            v-if="issue.lifecycle.kind === 'waiting' || issue.run?.review || reviewHistory.length > 0 || getReviewApprovalSource(issue)"
            :review-submitting="reviewSubmitting"
            :review-feedback="reviewFeedback"
            :review-history="reviewHistory"
            :approval-source="getReviewApprovalSource(issue)"
            :lifecycle="issue.lifecycle"
            :review-decision="issue.run?.review?.decision"
            :plan-doc-content="planDocContent"
            @update:review-feedback="emit('update:reviewFeedback', $event)"
            @approve="emit('approve', getIssueIid(issue))"
            @reject="emit('reject', getIssueIid(issue))"
            @skip="emit('skip', getIssueIid(issue))"
          />

          <!-- Supplement -->
          <SupplementEditor
            :supplement="supplement"
            :supplement-form="supplementForm"
            :loading="supplementLoading"
            :error="supplementError"
            :editing="supplementEditing"
            :saving="supplementSaving"
            :has-data="hasSupplementData"
            @edit="emit('supplementEdit')"
            @save="emit('supplementSave')"
            @cancel="emit('supplementCancel')"
            @update:supplement-form="emit('update:supplementForm', $event)"
          />

          <!-- Plan Docs -->
          <PlanDocViewer
            :issue-iid="getIssueIid(issue)"
            :plan-docs="getPlanDocs(issue)"
            :is-editable-doc="isEditableDoc"
            :detail-version="detailVersion"
          />

          <!-- E2E Artifacts -->
          <E2eArtifactsViewer :issue-iid="getIssueIid(issue)" />





          <!-- Agent Logs -->
          <AgentLogViewer
            :logs="agentLogs"
            :lifecycle="issue.lifecycle"
            :auto-scroll="agentAutoScroll"
            :debug-mode="agentDebugMode"
            @update:auto-scroll="emit('update:agentAutoScroll', $event)"
            @update:debug-mode="emit('update:agentDebugMode', $event)"
            @clear="emit('clearLogs')"
          />

          <!-- Actions -->
          <div class="flex flex-wrap gap-3 pt-2 border-t border-gray-200">
            <button
              v-if="issue.lifecycle.kind === 'skipped'"
              class="px-4 py-2 bg-green-500 text-white text-sm rounded-lg hover:bg-green-600"
              @click="emit('start', getIssueIid(issue))"
            >{{ $t('detail.start') }}</button>
            <button
              v-if="issue.lifecycle.kind === 'failed'"
              class="px-4 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600"
              @click="emit('retry', getIssueIid(issue))"
            >{{ $t('detail.retry') }}</button>

            <button
              v-if="['running', 'waiting', 'ready'].includes(issue.lifecycle.kind)"
              class="px-4 py-2 bg-amber-100 text-amber-700 text-sm rounded-lg hover:bg-amber-200"
              @click="emit('abort', getIssueIid(issue))"
            >{{ $t('detail.abort') }}</button>
            <button
              v-if="issue.lifecycle.kind === 'paused'"
              class="px-4 py-2 bg-green-500 text-white text-sm rounded-lg hover:bg-green-600"
              @click="emit('continue', getIssueIid(issue))"
            >{{ $t('detail.continue') }}</button>
            <button
              v-if="issue.lifecycle.kind === 'paused'"
              class="px-4 py-2 bg-orange-500 text-white text-sm rounded-lg hover:bg-orange-600"
              @click="emit('redo', getIssueIid(issue))"
            >{{ $t('detail.redo') }}</button>
            <button
              v-if="issue.preview?.running"
              class="px-4 py-2 bg-orange-100 text-orange-700 text-sm rounded-lg hover:bg-orange-200"
              @click="emit('stopPreview', getIssueIid(issue))"
            >{{ $t('detail.stopPreview') }}</button>
            <button
              v-if="!['pending', 'skipped'].includes(issue.lifecycle.kind) && !issue.preview?.running"
              class="px-4 py-2 bg-indigo-100 text-indigo-700 text-sm rounded-lg hover:bg-indigo-200"
              @click="emit('restartPreview', getIssueIid(issue))"
            >{{ $t('detail.restartPreview') }}</button>
            <button
              v-if="issue.lifecycle.kind !== 'skipped'"
              class="px-4 py-2 bg-yellow-100 text-yellow-700 text-sm rounded-lg hover:bg-yellow-200"
              @click="emit('restart', getIssueIid(issue))"
            >{{ $t('detail.restart') }}</button>
            <button
              class="px-4 py-2 bg-red-100 text-red-600 text-sm rounded-lg hover:bg-red-200"
              @click="emit('cancel', getIssueIid(issue))"
            >{{ $t('detail.cancelTrack') }}</button>
          </div>
        </div>
      </div>
    </div>
</template>
