<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAlert } from 'naive-ui/es/alert';
import { NButton } from 'naive-ui/es/button';
import { NCheckbox } from 'naive-ui/es/checkbox';
import { NCollapse, NCollapseItem } from 'naive-ui/es/collapse';
import { NInput } from 'naive-ui/es/input';
import { NModal } from 'naive-ui/es/modal';
import { NTag } from 'naive-ui/es/tag';
import { Check, FileCheck2, GitBranch, LockKeyhole, MessageSquare, ArrowRight } from '@lucide/vue';
import type { IssueRecord } from '@/types';
import { isReviewWaiting } from '@/adapters/issueflowViewModel';
import { useIssueGraphs } from '@/composables/useIssueGraphs';

const props = defineProps<{
  issue: IssueRecord;
  issueNumber: number;
  stateVersion?: number;
  reviewSubmitting: boolean;
}>();
const emit = defineEmits<{ approve: []; reject: [feedback: string]; skip: [] }>();
const { graph, loading, error, refresh } = useIssueGraphs(props);
const checked = ref(false);
const showFeedback = ref(false);
const feedback = ref('');
const feedbackError = ref('');

const tasks = computed(() => graph.value?.tasks ?? []);
const firstTask = computed(() => tasks.value[0]?.id);
const hasPlan = computed(() => (props.issue.run.planRevision) > 0);
const isPaused = computed(() => props.issue.lifecycle.kind === 'paused');
const acceptance = computed(() => {
  const values = tasks.value.flatMap((task) => task.acceptanceCriteria);
  const stable = [...new Set(values)];
  return [...stable, '所有前置任务合并后再执行下游', '浏览器验收使用本轮有效报告'].slice(0, 4);
});
const isWaitingReview = computed(() => isReviewWaiting(props.issue.lifecycle));

function submitReject() {
  if (!feedback.value.trim()) {
    feedbackError.value = '请说明需要调整的范围、依赖或验收标准。';
    return;
  }
  emit('reject', feedback.value.trim());
  showFeedback.value = false;
  feedback.value = '';
  feedbackError.value = '';
}
</script>

<template>
  <section class="native-plan-panel surface">
    <header class="native-plan-head">
      <div class="native-plan-title">
        <FileCheck2 :size="19" />
        <h2>实施计划</h2>
        <NTag
          size="small"
          :bordered="false"
        >
          v{{ issue.run.planRevision }}
        </NTag>
      </div>
      <span class="native-plan-readonly">
        <LockKeyhole :size="13" />
        只读快照
      </span>
    </header>
    <div class="native-plan-content">
      <NAlert
        v-if="isWaitingReview"
        type="warning"
        title="实施计划已就绪，等待你的审核"
      >
        确认范围、任务依赖和验收标准后，AI 才会进入构建阶段。
      </NAlert>
      <NAlert
        v-else-if="isPaused && !hasPlan"
        type="warning"
        title="任务已暂停，实施计划尚未生成"
      >
        当前任务在规划阶段被暂停，继续执行后才会生成内部计划与任务拆分。
      </NAlert>
      <NAlert
        v-else-if="isPaused"
        type="info"
        title="任务已暂停"
      >
        当前实施计划已保留，继续执行后将从暂停阶段恢复。
      </NAlert>
      <NAlert
        v-else-if="loading"
        type="info"
        title="正在读取实施计划"
      >
        请稍候，正在加载本轮任务拆分。
      </NAlert>
      <NAlert
        v-else-if="error"
        type="error"
        title="实施计划读取失败"
      >
        {{ error }}
        <NButton
          text
          size="small"
          @click="refresh"
        >
          重新读取
        </NButton>
      </NAlert>

      <section class="native-plan-section">
        <span class="prototype-eyebrow">01 / 目标与范围</span>
        <h3>{{ issue.demandSpec.title }}</h3>
        <p>{{ issue.demandSpec.description }}</p>
      </section>
      <section class="native-plan-section">
        <span class="prototype-eyebrow">02 / 任务拆分</span>
        <NCollapse
          v-if="tasks.length"
          :default-expanded-names="firstTask ? [firstTask] : []"
          class="native-plan-tasks"
        >
          <NCollapseItem
            v-for="task in tasks"
            :key="task.id"
            :name="task.id"
          >
            <template #header>
              <span class="native-plan-task-title">
                <span class="prototype-task-id">{{ task.id }}</span>
                {{ task.title }}
              </span>
            </template>
            <p>{{ task.instructions }}</p>
            <div class="native-plan-dependency">
              <GitBranch :size="14" />
              前置依赖：{{ task.dependsOn.join('、') || '无，可首先执行' }}
            </div>
            <ul class="native-plan-criteria">
              <li
                v-for="criterion in task.acceptanceCriteria"
                :key="criterion"
              >
                <Check :size="14" />
                {{ criterion }}
              </li>
            </ul>
          </NCollapseItem>
        </NCollapse>
        <div
          v-else
          class="native-plan-empty"
        >
          当前计划尚未生成内部任务。
        </div>
      </section>
      <section class="native-plan-section">
        <span class="prototype-eyebrow">03 / 交付要求</span>
        <div class="native-plan-acceptance-grid">
          <div
            v-for="item in acceptance"
            :key="item"
          >
            <Check :size="17" />
            <span>{{ item }}</span>
          </div>
        </div>
      </section>
    </div>
    <footer
      v-if="isWaitingReview"
      class="native-plan-actions"
    >
      <NCheckbox v-model:checked="checked">我已确认任务范围与验收标准</NCheckbox>
      <div>
        <NButton
          :disabled="reviewSubmitting"
          @click="showFeedback = true"
        >
          <template #icon><MessageSquare :size="16" /></template>
          提出修改意见
        </NButton>
        <NButton
          type="primary"
          :disabled="!checked || reviewSubmitting"
          :loading="reviewSubmitting"
          @click="emit('approve')"
        >
          <template #icon><Check :size="17" /></template>
          批准并开始构建
        </NButton>
      </div>
    </footer>
  </section>
  <NModal
    v-model:show="showFeedback"
    preset="card"
    title="提出计划修改意见"
    class="native-feedback-modal"
  >
    <p class="prototype-modal-description">
      修改意见将与完整的计划 v{{ issue.run.planRevision }} 一起保留，用于下一轮规划。
    </p>
    <NInput
      v-model:value="feedback"
      type="textarea"
      placeholder="例如：补充失败重试和浏览器验收标准。"
      :autosize="{ minRows: 5, maxRows: 10 }"
      :status="feedbackError ? 'error' : undefined"
    />
    <p
      v-if="feedbackError"
      class="native-feedback-error"
    >
      {{ feedbackError }}
    </p>
    <div class="native-modal-actions">
      <NButton @click="showFeedback = false">取消</NButton>
      <NButton
        type="primary"
        @click="submitReject"
      >
        提交并重新规划
        <ArrowRight :size="15" />
      </NButton>
    </div>
  </NModal>
</template>
