<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NAlert } from 'naive-ui/es/alert';
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NEmpty } from 'naive-ui/es/empty';
import { NProgress } from 'naive-ui/es/progress';
import { NStep, NSteps } from 'naive-ui/es/steps';
import { NTag } from 'naive-ui/es/tag';
import {
  ArrowLeft,
  Check,
  FileText,
  GitBranch,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Terminal,
  Workflow,
} from '@lucide/vue';
import type { SystemStatus } from '@/types';
import { getIssueIid, getIssueTitle } from '@/types';
import { getAllowedActions, type AllowedAction } from '@/adapters/issueflowViewModel';
import { useAction } from '@/composables/useAction';
import { useIssueDetail } from '@/composables/useIssueDetail';
import { useAgentLogs } from '@/composables/useAgentLogs';
import { usePipeline } from '@/composables/usePipeline';
import type { IssueGraphs } from '../../../../shared/workflowGraphs.js';
import { useSSE } from '@/composables/useSSE';
import TaskGraphPanel from './TaskGraphPanel.vue';
import NativePlanPanel from './NativePlanPanel.vue';
import NativeLogPanel from './NativeLogPanel.vue';
import NativeVerificationPanel from './NativeVerificationPanel.vue';
import NativeInterventionPanel from './NativeInterventionPanel.vue';

const props = defineProps<{ issueNumber: number; systemStatus: SystemStatus | null }>();
const detail = useIssueDetail();
const logs = useAgentLogs();
const activeTab = ref<'graph' | 'plan' | 'logs' | 'verification' | 'review'>('graph');
const { busy: actionBusy, error: actionError, run: runAction } = useAction();
const selectedTask = ref<IssueGraphs['tasks'][number] | undefined>();
const { stateLabel, stateClass } = usePipeline();
const issue = computed(() => detail.selectedIssue.value);
const actions = computed(() => new Set(issue.value ? getAllowedActions(issue.value) : []));
const can = (action: AllowedAction) => actions.value.has(action);
const issueError = computed(() =>
  issue.value?.lifecycle.kind === 'failed' ? issue.value.lifecycle.error.message : '',
);
const phaseKeys = ['plan', 'review', 'build', 'verify', 'uat', 'deliver'] as const;
const displayPhases = computed(() =>
  phaseKeys.map(
    (key) =>
      [
        key,
        issue.value?.phaseProgress?.[key] ?? {
          status:
            key === 'deliver' && issue.value?.lifecycle.kind === 'completed'
              ? 'completed'
              : 'pending',
        },
      ] as const,
  ),
);
const workflowCurrent = computed(() => {
  const firstIncomplete = displayPhases.value.findIndex(
    ([, value]) => value.status !== 'completed',
  );
  return firstIncomplete >= 0 ? firstIncomplete + 1 : displayPhases.value.length;
});
const workflowStatus = computed<'process' | 'error' | 'wait'>(() => {
  if (issue.value?.lifecycle.kind === 'failed') return 'error';
  if (issue.value?.lifecycle.kind === 'paused') return 'wait';
  return 'process';
});
const workflowPhaseLabel = computed(() => {
  const current = displayPhases.value.find(([, value]) => value.status !== 'completed');
  return current ? `当前阶段：${current[0]}` : '已完成交付';
});
const taskRuns = computed(() => Object.values(issue.value?.run.tasks ?? {}));
const mergedTaskCount = computed(
  () => taskRuns.value.filter((task) => task.status === 'merged').length,
);
const taskTotal = computed(() => taskRuns.value.length);
const taskProgress = computed(() =>
  taskTotal.value ? Math.round((mergedTaskCount.value / taskTotal.value) * 100) : 0,
);
const reviewFeedback = computed({
  get: () => detail.reviewFeedback.value,
  set: (value) => {
    detail.reviewFeedback.value = value;
  },
});

function selectIssue() {
  actionError.value = '';
  return detail.selectIssue(props.issueNumber, logs.agentLogs);
}
const refreshIssues = detail.refreshDetail;
function submitPlanReject(feedback: string) {
  reviewFeedback.value = feedback;
  return runAction(() => detail.doRejectPlan(props.issueNumber, refreshIssues));
}
function goBack() {
  window.location.hash = '#/workbench';
}
function setTab(value: string) {
  if (
    value === 'graph' ||
    value === 'plan' ||
    value === 'logs' ||
    value === 'verification' ||
    value === 'review'
  )
    activeTab.value = value;
}
function issueAction(action: AllowedAction) {
  return detail.executeAction(action, props.issueNumber, refreshIssues);
}
const { connected } = useSSE(() => {});
watch(() => props.issueNumber, selectIssue, { immediate: true });
onUnmounted(() => logs.clear());
</script>

<template>
  <section class="prototype-detail-page">
    <div
      v-if="!issue"
      class="prototype-detail-empty"
      role="status"
      :aria-busy="detail.detailLoading.value"
    >
      <NEmpty
        :description="
          detail.detailLoading.value
            ? '正在读取 Issue 详情…'
            : detail.detailError.value || '暂时无法读取 Issue 详情'
        "
      >
        <template #extra>
          <NButton @click="selectIssue">重新加载</NButton>
          <NButton @click="goBack">返回工作台</NButton>
        </template>
      </NEmpty>
    </div>
    <template v-else>
      <NButton
        text
        class="prototype-detail-back"
        @click="goBack"
      >
        <template #icon><ArrowLeft :size="16" /></template>
        返回任务工作台
      </NButton>
      <header class="prototype-detail-heading">
        <div>
          <div class="prototype-eyebrow">
            ISSUE #{{ getIssueIid(issue) }}
            <span>/ {{ issue.branchName }}</span>
          </div>
          <h1>{{ getIssueTitle(issue) }}</h1>
          <div class="prototype-detail-meta">
            <NTag
              :class="stateClass(issue.lifecycle)"
              :bordered="false"
              round
            >
              {{ stateLabel(issue.lifecycle) }}
            </NTag>
            <span>
              <GitBranch :size="14" />
              {{ issue.branchName }}
            </span>
            <span>更新于 {{ new Date(issue.updatedAt).toLocaleString('zh-CN') }}</span>
            <span
              v-if="connected"
              class="prototype-connection-pill"
            >
              <span></span>
              实时连接
            </span>
          </div>
        </div>
        <div class="prototype-detail-actions">
          <NButton @click="activeTab = 'plan'">
            <template #icon><FileText :size="16" /></template>
            实施计划
          </NButton>
          <NButton
            v-if="can('abort')"
            :loading="actionBusy"
            @click="runAction(() => issueAction('abort'))"
          >
            <template #icon><Pause :size="16" /></template>
            暂停/终止
          </NButton>
          <NButton
            v-if="can('continue')"
            type="primary"
            :loading="actionBusy"
            @click="runAction(() => issueAction('continue'))"
          >
            <template #icon><Play :size="16" /></template>
            继续执行
          </NButton>
          <NButton
            v-if="can('retry')"
            type="primary"
            :loading="actionBusy"
            @click="runAction(() => issueAction('retry'))"
          >
            <template #icon><RotateCcw :size="16" /></template>
            重试当前阶段
          </NButton>
        </div>
      </header>
      <NAlert
        v-if="issueError || actionError || detail.detailError.value"
        type="error"
        class="prototype-alert"
      >
        {{ actionError || detail.detailError.value || issueError }}
      </NAlert>
      <NativeInterventionPanel
        :key="props.issueNumber"
        :issue="issue"
        :max-retries="systemStatus?.config.maxRetries"
        @refresh="refreshIssues"
        @logs="activeTab = 'logs'"
        @verification="activeTab = 'verification'"
      />
      <section class="prototype-workflow-panel">
        <div class="prototype-workflow-label">
          <strong>Issue 主流程</strong>
          <span>计划 v{{ issue.run.planRevision }} · {{ workflowPhaseLabel }}</span>
        </div>
        <NSteps
          :current="workflowCurrent"
          :status="workflowStatus"
          size="small"
        >
          <NStep
            v-for="[key, value] in displayPhases"
            :key="key"
            :title="key.toUpperCase()"
            :description="
              value.status === 'completed'
                ? '已完成'
                : value.status === 'in_progress'
                  ? '正在推进'
                  : value.status === 'gate_waiting'
                    ? '等待确认'
                    : value.status === 'failed'
                      ? '需要处理'
                      : '等待前序阶段'
            "
          />
        </NSteps>
      </section>
      <div class="prototype-detail-tabs">
        <button
          v-for="tab in [
            { key: 'graph', label: '执行视图', icon: Workflow },
            { key: 'plan', label: '实施计划', icon: FileText },
            { key: 'logs', label: '完整日志', icon: Terminal },
            { key: 'verification', label: '验收结果', icon: ShieldCheck },
          ]"
          :key="tab.key"
          :class="{ active: activeTab === tab.key }"
          @click="setTab(tab.key)"
        >
          <component
            :is="tab.icon"
            :size="16"
          />
          {{ tab.label }}
        </button>
      </div>
      <div class="prototype-detail-columns">
        <div class="prototype-detail-primary">
          <template v-if="activeTab === 'graph'">
            <TaskGraphPanel
              :issue-number="getIssueIid(issue)"
              :state-version="issue.run.version"
              @task-selected="selectedTask = $event"
            />
          </template>
          <NativePlanPanel
            v-else-if="activeTab === 'plan'"
            :issue="issue"
            :issue-number="getIssueIid(issue)"
            :state-version="issue.run.version"
            :review-submitting="detail.reviewSubmitting.value"
            @approve="runAction(() => detail.doApprovePlan(props.issueNumber, refreshIssues))"
            @reject="submitPlanReject"
          />
          <NativeLogPanel
            v-else-if="activeTab === 'logs'"
            :logs="logs.filteredLogs.value"
            :lifecycle="issue.lifecycle"
            :auto-scroll="logs.agentAutoScroll.value"
            :debug-mode="logs.debugMode.value"
            @update:auto-scroll="logs.agentAutoScroll.value = $event"
            @update:debug-mode="logs.debugMode.value = $event"
            @clear="logs.clear()"
          />
          <NativeVerificationPanel
            v-else
            :issue-iid="getIssueIid(issue)"
          />
        </div>
        <aside class="prototype-detail-aside">
          <NCard title="任务概况">
            <dl class="prototype-detail-data">
              <div>
                <dt>当前状态</dt>
                <dd>
                  <NTag :bordered="false">{{ stateLabel(issue.lifecycle) }}</NTag>
                </dd>
              </div>
              <div>
                <dt>计划版本</dt>
                <dd>
                  v{{ issue.run.planRevision }} ·
                  {{ issue.run.review?.decision === 'waiting' ? '等待审核' : '已批准' }}
                </dd>
              </div>
              <div>
                <dt>执行器</dt>
                <dd>{{ systemStatus?.config.aiMode ?? 'Codex' }}</dd>
              </div>
              <div>
                <dt>构建进度</dt>
                <dd>{{ mergedTaskCount }} / {{ taskTotal }} 已合并</dd>
              </div>
            </dl>
            <NProgress
              :percentage="taskProgress"
              :show-indicator="false"
              :height="5"
              color="#168875"
              rail-color="#e5edef"
            />
            <dl class="prototype-detail-data prototype-detail-data-after">
              <div>
                <dt>浏览器验收</dt>
                <dd>{{ systemStatus?.config.e2eEnabled ? '已开启' : '未开启' }}</dd>
              </div>
              <div>
                <dt>所属仓库</dt>
                <dd>
                  {{ systemStatus?.config.repository?.split('/').pop() || 'issue-auto-finish' }}
                </dd>
              </div>
            </dl>
          </NCard>
          <NCard
            v-if="activeTab === 'graph' && selectedTask"
            class="prototype-selected-task-card"
          >
            <template #header>
              <div class="prototype-card-heading">
                <span>当前子任务</span>
                <NTag
                  :bordered="false"
                  size="small"
                >
                  {{
                    selectedTask.status === 'running'
                      ? '执行中'
                      : selectedTask.status === 'merged'
                        ? '已合并'
                        : '等待'
                  }}
                </NTag>
              </div>
            </template>
            <div class="prototype-selected-task">
              <span class="prototype-task-id">{{ selectedTask.id }}</span>
              <h3>{{ selectedTask.title }}</h3>
              <p>{{ selectedTask.instructions }}</p>
              <h4>验收标准</h4>
              <ul>
                <li
                  v-for="criterion in selectedTask.acceptanceCriteria"
                  :key="criterion"
                >
                  <Check :size="14" />
                  {{ criterion }}
                </li>
              </ul>
              <h4>预计涉及文件</h4>
              <code class="prototype-task-file">等待任务执行后由执行器记录</code>
              <h4>执行记录</h4>
              <p class="prototype-task-run">
                第 {{ selectedTask.attemptNo || 0 }} 次尝试 ·
                {{
                  selectedTask.error ||
                  (selectedTask.success
                    ? selectedTask.success.noChange
                      ? '执行完成，无内容变化'
                      : '执行成功'
                    : '尚未执行')
                }}
              </p>
              <div class="prototype-dependency-note">
                <GitBranch :size="14" />
                <span>
                  {{
                    selectedTask.dependsOn.length
                      ? '依赖 ' + selectedTask.dependsOn.join('、')
                      : '无前置任务'
                  }}
                </span>
              </div>
            </div>
          </NCard>
          <section
            v-if="activeTab === 'plan'"
            class="prototype-aside-note"
          >
            <ShieldCheck :size="22" />
            <h3>让每一步都可核验</h3>
            <p>计划保留完整版本，审核意见可回溯，验收结果绑定本轮执行。</p>
          </section>
        </aside>
      </div>
    </template>
  </section>
</template>
