<script setup lang="ts">
import { computed, defineAsyncComponent, h, onMounted, onUnmounted, ref } from 'vue';
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NConfigProvider } from 'naive-ui/es/config-provider';
import { NDialogProvider } from 'naive-ui/es/dialog';
import { NDivider } from 'naive-ui/es/divider';
import { NDrawer, NDrawerContent } from 'naive-ui/es/drawer';
import { NEmpty } from 'naive-ui/es/empty';
import { NMenu, type MenuOption } from 'naive-ui/es/menu';
import { NMessageProvider } from 'naive-ui/es/message';
import { NProgress } from 'naive-ui/es/progress';
import { NTag } from 'naive-ui/es/tag';
import { NTimeline, NTimelineItem } from 'naive-ui/es/timeline';
import {
  Activity,
  BookOpen,
  ChartNoAxesCombined,
  CheckCheck,
  ChevronRight,
  CircleDot,
  GitBranch,
  LayoutDashboard,
  Menu,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from '@lucide/vue';
import type { SystemStatus } from '@/types';
import { getIssueIid } from '@/types';
import { useTasks } from '@/composables/useTasks';
import { useSSE } from '@/composables/useSSE';
import { useIssueDetail } from '@/composables/useIssueDetail';
import { isReviewWaiting, needsIntervention } from '@/adapters/issueflowViewModel';
import * as api from '@/api/client';
const NativeTaskTable = defineAsyncComponent(() => import('./NativeTaskTable.vue'));
const NativeWorkspacePage = defineAsyncComponent(() => import('./NativeWorkspacePage.vue'));
const NativeIssueDetailPage = defineAsyncComponent(() => import('./NativeIssueDetailPage.vue'));

const systemStatus = ref<SystemStatus | null>(null);
const route = ref(location.hash || '#/workbench');
const mobileMenu = ref(false);
const refreshBusy = ref(false);
const { tasks, loading, error, refresh } = useTasks('issue');
const detail = useIssueDetail();
const connectedState = useSSE((eventName, rawPayload) => {
  const payload = rawPayload as { data?: { issueIid?: number } };
  if (
    eventName.startsWith('issue:') ||
    eventName.startsWith('gate:') ||
    eventName.startsWith('phase:') ||
    eventName.startsWith('pipeline:') ||
    eventName.startsWith('uat:')
  ) {
    refresh();
    if (
      payload.data?.issueIid &&
      detail.selectedIssue.value &&
      getIssueIid(detail.selectedIssue.value) === payload.data.issueIid
    )
      detail.refreshDetail();
  }
});
const connected = connectedState.connected;
const page = computed(() => {
  const value = route.value.replace(/^#\//, '').split('/')[0];
  return ['workbench', 'knowledge', 'analytics', 'settings'].includes(value)
    ? value
    : 'workbench';
});
const isIssueRoute = computed(() => /^issue\/\d+$/.test(route.value.replace(/^#\//, '')));
const issueNumber = computed(() => {
  const match = route.value.match(/^#\/issue\/(\d+)/);
  return match ? Number(match[1]) : 0;
});
const navPage = computed(() => (isIssueRoute.value ? 'workbench' : page.value));
const currentPage = computed(
  () => page.value as 'workbench' | 'knowledge' | 'analytics' | 'settings',
);
const workspacePage = computed(() =>
  (currentPage.value === 'workbench' ? 'knowledge' : currentPage.value) as
    'knowledge' | 'analytics' | 'settings',
);
const running = computed(() => tasks.value.filter((task) => task.stateCategory === 'active'));
const reviews = computed(() => tasks.value.filter((task) => isReviewWaiting(task.lifecycle)));
const interventions = computed(() => (
  tasks.value.filter((task) => needsIntervention(task.lifecycle))
));
const completed = computed(() => tasks.value.filter((task) => task.stateCategory === 'completed'));
const aiConcurrencyLimit = computed(() => systemStatus.value?.config.aiMaxConcurrency ?? 4);
const metrics = computed(() => [
  {
    title: '全部任务',
    value: tasks.value.length,
    note: '当前仓库的全部 Issue',
    icon: Activity,
    type: '',
  },
  {
    title: '正在执行',
    value: running.value.length,
    note: `${running.value.length} 个任务占用 AI 额度`,
    icon: CircleDot,
    type: 'primary',
  },
  {
    title: '等待审核',
    value: reviews.value.length,
    note: '需要你的下一步决策',
    icon: ShieldCheck,
    type: 'warning',
  },
  {
    title: '已完成交付',
    value: completed.value.length,
    note: '构建、验证与验收完成',
    icon: CheckCheck,
    type: 'success',
  },
]);
const menuOptions: MenuOption[] = [
  {
    key: 'workbench',
    label: '任务工作台',
    icon: () => h(LayoutDashboard, { size: 18 }),
    extra: () => h('span', { class: 'prototype-nav-count' }, tasks.value.length),
  },
  { key: 'knowledge', label: '知识与经验', icon: () => h(BookOpen, { size: 18 }) },
  { key: 'analytics', label: '任务统计', icon: () => h(ChartNoAxesCombined, { size: 18 }) },
  { key: 'settings', label: '设置', icon: () => h(Settings2, { size: 18 }) },
];

function navigate(path: string) {
  window.location.hash = `#/${path}`;
}
function selectNav(key: string) {
  navigate(key);
  mobileMenu.value = false;
}
async function refreshAll() {
  if (refreshBusy.value) return;
  refreshBusy.value = true;
  try {
    await refresh();
  } finally {
    refreshBusy.value = false;
  }
}
async function openIssue(number: number) {
  navigate(`issue/${number}`);
}
async function fetchStatus() {
  try {
    systemStatus.value = await api.fetchSystemStatus();
  } catch {
    /* 后端暂不可用时保留页面 */
  }
}

function onHashChange() {
  route.value = location.hash || '#/workbench';
  document.title =
    page.value === 'workbench' ? '任务工作台 · IssueFlow' : `${page.value} · IssueFlow`;
}
onMounted(async () => {
  window.addEventListener('hashchange', onHashChange);
  onHashChange();
  await refresh();
  await fetchStatus();
});
onUnmounted(() => window.removeEventListener('hashchange', onHashChange));
</script>

<template>
  <NConfigProvider :theme="null">
    <NMessageProvider>
      <NDialogProvider>
        <div class="prototype-shell">
          <a
            class="prototype-skip-link"
            href="#prototype-main"
          >
            跳到主要内容
          </a>
          <aside class="prototype-sidebar">
            <a
              class="prototype-brand"
              href="#/workbench"
            >
              <span class="prototype-brand-symbol"><GitBranch :size="24" /></span>
              <span>
                <strong>IssueFlow</strong>
                <small>AI ISSUE WORKSPACE</small>
              </span>
            </a>
            <NMenu
              :value="navPage"
              :options="menuOptions"
              :indent="14"
              @update:value="selectNav"
            />
            <div class="prototype-sidebar-bottom">
              <div class="prototype-local-workspace">
                <span class="prototype-user-avatar">L</span>
                <div>
                  <strong>本地工作空间</strong>
                  <small>单仓库 · 单实例</small>
                </div>
              </div>
            </div>
          </aside>
          <div class="prototype-main">
            <header class="prototype-topbar">
              <div class="prototype-topbar-left">
                <NButton
                  quaternary
                  circle
                  class="prototype-mobile-menu"
                  aria-label="打开导航"
                  @click="mobileMenu = true"
                >
                  <template #icon><Menu :size="20" /></template>
                </NButton>
                <GitBranch :size="16" />
                <span>issue-auto-finish</span>
                <ChevronRight :size="13" />
                <strong>
                  {{
                    isIssueRoute
                      ? 'Issue 执行详情'
                      : page === 'workbench'
                        ? '任务工作台'
                        : page === 'knowledge'
                            ? '知识与经验'
                            : page === 'analytics'
                              ? '任务统计'
                              : '设置'
                  }}
                </strong>
                <span class="prototype-connection-pill">
                  <span></span>
                  {{ connected ? '实时连接' : '连接中断' }}
                </span>
              </div>
              <div class="prototype-topbar-actions">
                <span class="prototype-local-pill">
                  <span></span>
                  本地数据
                </span>
              </div>
            </header>
            <main
              id="prototype-main"
              class="prototype-content"
              tabindex="-1"
            >
              <NativeIssueDetailPage
                v-if="isIssueRoute"
                :issue-number="issueNumber"
                :system-status="systemStatus"
              />
              <template v-else-if="page === 'workbench'">
                <header class="prototype-page-heading">
                  <div>
                    <div class="prototype-eyebrow">YOUR WORK, IN FLOW</div>
                    <h1>任务工作台</h1>
                    <p>从需求到交付，掌握每个 Issue 的执行脉络。</p>
                  </div>
                  <div class="prototype-heading-actions">
                    <NButton
                      :loading="refreshBusy"
                      @click="refreshAll"
                    >
                      <template #icon><RefreshCw :size="16" /></template>
                      刷新
                    </NButton>
                  </div>
                </header>
                <section
                  class="prototype-metrics-grid"
                  aria-label="任务统计"
                >
                  <NCard
                    v-for="metric in metrics"
                    :key="metric.title"
                    class="prototype-metric-card"
                    :class="'prototype-metric-' + metric.type"
                  >
                    <div class="prototype-metric-label">
                      <span>{{ metric.title }}</span>
                      <component
                        :is="metric.icon"
                        :size="17"
                      />
                    </div>
                    <strong class="prototype-metric-value">
                      {{ metric.value }}
                      <span
                        v-if="metric.type === 'primary'"
                        class="prototype-live-dot"
                      ></span>
                    </strong>
                    <p>{{ metric.note }}</p>
                  </NCard>
                </section>
                <div class="prototype-workbench-columns">
                  <div class="prototype-workbench-primary">
                    <section
                      v-if="interventions.length"
                      class="prototype-review-notice"
                      aria-label="需要人工介入的任务"
                    >
                      <span class="prototype-notice-symbol"><ShieldCheck :size="23" /></span>
                      <div>
                        <strong>{{ interventions.length }} 个任务需要人工介入</strong>
                        <p>任务失败或已暂停，可查看原因、手动恢复或补充说明后重新规划。</p>
                        <NButton
                          v-for="task in interventions"
                          :key="task.taskId"
                          text
                          @click="openIssue(Number(task.taskId))"
                        >处理 #{{ task.taskId }} · {{ task.title }}</NButton>
                      </div>
                    </section>
                    <section
                      v-if="reviews.length"
                      class="prototype-review-notice"
                    >
                      <span class="prototype-notice-symbol"><ShieldCheck :size="23" /></span>
                      <div>
                        <strong>{{ reviews.length }} 份实施计划等待审核</strong>
                        <p>确认任务范围与验收标准后，AI 将开始构建。</p>
                      </div>
                      <NButton
                        text
                        @click="openIssue(Number(reviews[0].taskId))"
                      >
                        去审核
                        <ChevronRight :size="17" />
                      </NButton>
                    </section>
                    <NativeTaskTable
                      :tasks="tasks"
                      :loading="loading"
                      :error="error"
                      @select="openIssue"
                    />
                  </div>
                  <aside class="prototype-workbench-aside">
                    <NCard
                      title="运行概况"
                      class="prototype-capacity-card"
                    >
                      <template #header-extra>
                        <NTag
                          size="small"
                          :bordered="false"
                          type="success"
                        >
                          正常
                        </NTag>
                      </template>
                      <div class="prototype-capacity-caption">
                        AI 并发额度
                        <strong>
                          {{ running.length }}
                           <span>/ {{ aiConcurrencyLimit }}</span>
                        </strong>
                      </div>
                      <NProgress
                        type="line"
                         :percentage="Math.min(100, (running.length / aiConcurrencyLimit) * 100)"
                        :show-indicator="false"
                        :height="6"
                        color="#168875"
                        rail-color="#e6edef"
                      />
                      <p class="prototype-capacity-hint">
                         {{ Math.max(0, aiConcurrencyLimit - running.length) }} 个额度可用
                      </p>
                      <dl class="prototype-detail-data">
                        <div>
                          <dt>正在推进</dt>
                          <dd>{{ running.length }} 个 Issue</dd>
                        </div>
                        <div>
                          <dt>等待审核</dt>
                          <dd>{{ reviews.length }} 个 Issue</dd>
                        </div>
                        <div>
                          <dt>当前执行器</dt>
                          <dd>{{ systemStatus?.config.aiMode ?? 'Codex' }}</dd>
                        </div>
                      </dl>
                      <NDivider />
                      <button
                        v-if="running[0]"
                        class="prototype-current-run"
                        @click="openIssue(Number(running[0].taskId))"
                      >
                        <span>
                          <CircleDot :size="16" />
                          关注当前执行
                        </span>
                        <strong>#{{ running[0].taskId }} {{ running[0].title }}</strong>
                        <small>
                          打开执行视图
                          <ChevronRight :size="14" />
                        </small>
                      </button>
                      <NEmpty
                        v-else
                        description="当前没有执行中的任务"
                        size="small"
                      />
                    </NCard>
                    <NCard
                      title="最近动态"
                      class="prototype-activity-card"
                    >
                      <template #header-extra>
                        <Activity
                          :size="16"
                          class="prototype-muted"
                        />
                      </template>
                      <NTimeline>
                        <NTimelineItem
                          v-if="running[0]"
                          type="success"
                          :title="'#' + running[0].taskId + ' 正在推进'"
                          content="Native 流水线正在执行"
                          time="刚刚"
                        />
                        <NTimelineItem
                          v-if="reviews[0]"
                          type="warning"
                          :title="'#' + reviews[0].taskId + ' 计划已就绪'"
                          content="等待审核实施方案"
                          time="最近"
                        />
                        <NTimelineItem
                          v-if="completed[0]"
                          type="default"
                          :title="'#' + completed[0].taskId + ' 已交付'"
                          content="构建与验收已完成"
                          time="最近"
                        />
                      </NTimeline>
                    </NCard>
                  </aside>
                </div>
              </template>
              <NativeWorkspacePage
                v-else
                :page="workspacePage"
                :tasks="tasks"
                :system-status="systemStatus"
              />
            </main>
          </div>
          <NDrawer
            v-model:show="mobileMenu"
            placement="left"
            :width="280"
          >
            <NDrawerContent
              title="IssueFlow 工作空间"
              closable
            >
              <NMenu
                :value="navPage"
                :options="menuOptions"
                @update:value="selectNav"
              />
            </NDrawerContent>
          </NDrawer>
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
