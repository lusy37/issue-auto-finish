<script setup lang="ts">
import { computed, ref } from 'vue';
import type { IssueLifecycle, ReviewRound } from '@/types';
import { computeReviewGateStatus } from '@/utils/reviewGateStatus';

const props = defineProps<{
  reviewSubmitting: boolean;
  reviewHistory: ReviewRound[];
  lifecycle?: IssueLifecycle;
  reviewDecision?: 'waiting' | 'approved' | 'rejected';
  /** 流水线中 kind='gate' 阶段名，默认 'review'（plan-mode）。 */
  gatePhaseName?: string;
  planDocContent?: string;
  planDiff?: { diff: string; hasChanges: boolean };
  approvalSource?: 'manual' | 'label' | 'configuration';
}>();

const reviewFeedback = defineModel<string>('reviewFeedback', { required: true });

const emit = defineEmits<{
  approve: [];
  reject: [];
  skip: [];
}>();

const planPreviewCollapsed = ref(false);
const planDiffCollapsed = ref(false);
const hasPlanContent = computed(() => !!props.planDocContent && props.planDocContent.trim().length > 0);
const hasPlanDiff = computed(() => !!props.planDiff?.hasChanges && !!props.planDiff?.diff);

interface DiffLine { text: string; cls: string }
const planDiffLines = computed<DiffLine[]>(() => {
  const text = props.planDiff?.diff ?? '';
  if (!text) return [];
  return text.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return { text: line, cls: 'text-gray-500' };
    if (line.startsWith('@@')) return { text: line, cls: 'text-purple-600 bg-purple-50' };
    if (line.startsWith('+')) return { text: line, cls: 'text-green-700 bg-green-50' };
    if (line.startsWith('-')) return { text: line, cls: 'text-red-700 bg-red-50' };
    return { text: line, cls: 'text-gray-600' };
  });
});

const reviewStatus = computed(() =>
  computeReviewGateStatus(
    props.lifecycle,
    props.gatePhaseName ?? 'review',
    props.reviewHistory.length,
    props.reviewDecision,
  ),
);

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}
</script>

<template>
  <!-- Pending review: show full action panel -->
  <div v-if="reviewStatus === 'waiting'" class="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-4">
    <h3 class="text-base font-semibold text-yellow-800 mb-3">{{ $t('review.title') }}</h3>
    <p class="text-sm text-yellow-700 mb-3">
      {{ $t('review.description') }}
      <span v-if="reviewHistory.length > 0" class="text-yellow-600 font-medium">
        {{ $t('review.currentRound', { round: reviewHistory.length + 1 }) }}
      </span>
    </p>

    <!-- Plan content preview (待审的 plan 内容直接内嵌展示) -->
    <div class="mb-4">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-semibold text-yellow-700">{{ $t('review.planPreview') }}</span>
        <button
          type="button"
          class="text-xs px-2 py-0.5 rounded bg-yellow-200 text-yellow-800 hover:bg-yellow-300"
          @click="planPreviewCollapsed = !planPreviewCollapsed"
        >{{ planPreviewCollapsed ? $t('review.expand') : $t('review.collapse') }}</button>
      </div>
      <div
        v-if="!planPreviewCollapsed"
        class="border border-yellow-200 rounded-lg bg-white/80 p-3 max-h-96 overflow-y-auto"
      >
        <div v-if="hasPlanContent" class="plan-doc text-sm text-gray-700" v-html="props.planDocContent" />
        <p v-else class="text-sm text-gray-400">{{ $t('review.planPreviewEmpty') }}</p>
      </div>
    </div>

    <!-- Review History Timeline -->
    <div class="mb-4">
      <div class="flex items-center mb-2">
        <span class="text-xs font-semibold text-yellow-700">{{ $t('review.history') }}</span>
        <span
          v-if="reviewHistory.length > 0"
          class="ml-2 px-1.5 py-0.5 text-xs bg-yellow-200 text-yellow-800 rounded-full"
        >{{ $t('review.roundLabel', { n: reviewHistory.length }) }}</span>
      </div>
      <div
        v-if="reviewHistory.length > 0"
        class="space-y-2 max-h-48 overflow-y-auto border border-yellow-200 rounded-lg bg-white/60 p-3"
      >
        <div
          v-for="item in reviewHistory"
          :key="item.round"
          class="relative pl-5 pb-2 border-l-2"
          :class="item.round === reviewHistory.length ? 'border-yellow-500' : 'border-yellow-200'"
        >
          <div
            class="absolute left-[-5px] top-1 w-2 h-2 rounded-full"
            :class="item.round === reviewHistory.length ? 'bg-yellow-500' : 'bg-yellow-300'"
          />
          <div class="flex items-baseline space-x-2 mb-0.5">
            <span class="text-xs font-semibold text-yellow-700">{{ $t('review.roundPrefix', { round: item.round }) }}</span>
            <span class="text-xs text-gray-400">{{ formatTimestamp(item.timestamp) }}</span>
          </div>
          <p class="text-sm text-gray-700 whitespace-pre-wrap break-words">{{ item.feedback }}</p>
        </div>
      </div>
      <p
        v-else
        class="text-xs text-yellow-600 border border-dashed border-yellow-300 rounded-lg bg-white/40 p-3"
      >{{ $t('review.noHistoryFirstRound') }}</p>
    </div>

    <!--
      Plan Diff: 本轮相对上一轮被驳回时的改进对比。
      仅当 plan-diff API 返回真实差异（hasPlanDiff）时显示，避免在
      "无上轮快照 / 内容相同 / 未生成完" 时给出误导性的空提示。
    -->
    <div v-if="hasPlanDiff" class="mb-4">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-semibold text-yellow-700">{{ $t('review.improvementsTitle') }}</span>
        <button
          type="button"
          class="text-xs px-2 py-0.5 rounded bg-yellow-200 text-yellow-800 hover:bg-yellow-300"
          @click="planDiffCollapsed = !planDiffCollapsed"
        >{{ planDiffCollapsed ? $t('review.improvementsExpand') : $t('review.improvementsCollapse') }}</button>
      </div>
      <div
        v-if="!planDiffCollapsed"
        class="border border-yellow-200 rounded-lg bg-white/80 max-h-96 overflow-y-auto font-mono text-xs leading-5"
      >
        <div
          v-for="(line, idx) in planDiffLines"
          :key="idx"
          class="px-3 whitespace-pre-wrap break-words"
          :class="line.cls"
        >{{ line.text || '\u00a0' }}</div>
      </div>
    </div>

    <div class="flex items-center space-x-3 mb-3">
      <button
        class="px-4 py-2 bg-green-500 text-white text-sm rounded-lg hover:bg-green-600 font-medium disabled:opacity-50"
        :disabled="reviewSubmitting"
        @click="emit('approve')"
      >{{ reviewSubmitting ? $t('review.submitting') : $t('review.approve') }}</button>
      <button
        class="px-4 py-2 bg-gray-400 text-white text-sm rounded-lg hover:bg-gray-500 font-medium disabled:opacity-50"
        :disabled="reviewSubmitting"
        @click="emit('skip')"
      >{{ $t('review.skip') }}</button>
    </div>
    <div class="space-y-2">
      <label class="block text-xs font-medium text-yellow-700">{{ $t('review.feedbackLabel') }}</label>
      <textarea
        v-model="reviewFeedback"
        rows="3"
        class="w-full border border-yellow-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
        :placeholder="$t('review.feedbackPlaceholder')"
      />
      <button
        class="px-4 py-2 bg-red-500 text-white text-sm rounded-lg hover:bg-red-600 font-medium disabled:opacity-50"
        :disabled="reviewSubmitting || !reviewFeedback.trim()"
        @click="emit('reject')"
      >{{ $t('review.reject') }}</button>

    </div>
  </div>

  <!-- Re-planning after rejection: show history + progress indicator -->
  <div v-else-if="reviewStatus === 'replanning'" class="bg-blue-50 border border-blue-200 rounded-lg p-4">
    <div class="flex items-center gap-2 mb-3">
      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-700">
        <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M4 12a8 8 0 018-8m0 16a8 8 0 01-8-8" /></svg>
        {{ $t('review.replanning') }}
      </span>
    </div>
    <p class="text-sm text-blue-600 mb-3">{{ $t('review.replanningHint') }}</p>

    <div class="flex items-center mb-2">
      <span class="text-xs font-semibold text-blue-700">{{ $t('review.history') }}</span>
      <span class="ml-2 px-1.5 py-0.5 text-xs bg-blue-200 text-blue-800 rounded-full">{{ $t('review.roundLabel', { n: reviewHistory.length }) }}</span>
    </div>
    <div class="space-y-2 max-h-48 overflow-y-auto border border-blue-100 rounded-lg bg-white/60 p-3">
      <div
        v-for="item in reviewHistory"
        :key="item.round"
        class="relative pl-5 pb-2 border-l-2"
        :class="item.round === reviewHistory.length ? 'border-blue-400' : 'border-blue-200'"
      >
        <div
          class="absolute left-[-5px] top-1 w-2 h-2 rounded-full"
          :class="item.round === reviewHistory.length ? 'bg-blue-400' : 'bg-blue-200'"
        />
        <div class="flex items-baseline space-x-2 mb-0.5">
          <span class="text-xs font-semibold text-blue-700">{{ $t('review.roundPrefix', { round: item.round }) }}</span>
          <span class="text-xs text-gray-400">{{ formatTimestamp(item.timestamp) }}</span>
        </div>
        <p class="text-sm text-gray-700 whitespace-pre-wrap break-words">{{ item.feedback }}</p>
      </div>
    </div>

    <!--
      Replanning 期间 worktree 中的 01-plan.md 正在被 AI 重写，
      此时展示的任何 diff 都是中间态。统一显示"生成中"提示，
      等进入 PhaseWaiting 后用户再到 waiting 分支查看完整对比。
    -->
    <div class="mt-4">
      <p class="text-xs text-blue-600 border border-dashed border-blue-300 rounded-lg bg-white/40 p-3">
        {{ $t('review.improvementsRegenerating') }}
      </p>
    </div>
  </div>

  <!-- Review not yet reached -->
  <div v-else-if="reviewStatus === 'not_started'" class="bg-white border border-gray-200 rounded-lg p-4">
    <div class="flex items-center gap-2 mb-3">
      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-500">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path stroke-linecap="round" d="M12 8v4l2.5 2.5" /></svg>
        {{ $t('review.notStarted') }}
      </span>
    </div>
    <p class="text-sm text-gray-400">{{ $t('review.notStartedHint') }}</p>
  </div>

  <!-- Review already resolved: show read-only status -->
  <div v-else class="bg-white border border-gray-200 rounded-lg p-4">
    <div class="flex items-center gap-2 mb-3">
      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium bg-green-100 text-green-700">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
        {{ $t('review.approved') }}
      </span>
    </div>

    <p v-if="approvalSource" class="text-sm text-gray-600 mb-3">
      {{ approvalSource === 'configuration' ? '按配置自动通过（计划审核已关闭）' : approvalSource === 'label' ? '按标签规则自动通过' : '人工审核通过' }}
    </p>
    <!-- Review History (read-only) -->
    <div v-if="reviewHistory.length > 0">
      <div class="flex items-center mb-2">
        <span class="text-xs font-semibold text-gray-500">{{ $t('review.history') }}</span>
        <span class="ml-2 px-1.5 py-0.5 text-xs bg-gray-100 text-gray-600 rounded-full">{{ $t('review.roundLabel', { n: reviewHistory.length }) }}</span>
      </div>
      <div class="space-y-2 max-h-48 overflow-y-auto border border-gray-100 rounded-lg bg-gray-50/60 p-3">
        <div
          v-for="item in reviewHistory"
          :key="item.round"
          class="relative pl-5 pb-2 border-l-2 border-gray-200"
        >
          <div class="absolute left-[-5px] top-1 w-2 h-2 rounded-full bg-gray-300" />
          <div class="flex items-baseline space-x-2 mb-0.5">
            <span class="text-xs font-semibold text-gray-500">{{ $t('review.roundPrefix', { round: item.round }) }}</span>
            <span class="text-xs text-gray-400">{{ formatTimestamp(item.timestamp) }}</span>
          </div>
          <p class="text-sm text-gray-600 whitespace-pre-wrap break-words">{{ item.feedback }}</p>
        </div>
      </div>
    </div>

    <p v-else class="text-sm text-gray-400">{{ $t('review.noHistory') }}</p>
  </div>
</template>
