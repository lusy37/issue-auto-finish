<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue';
import { NButton, NCard, NConfigProvider, NDivider, NDrawer, NDrawerContent, NMenu, NProgress, NTag, NTimeline, NTimelineItem, NBadge, NEmpty, NMessageProvider, NDialogProvider, type MenuOption } from 'naive-ui';
import { Activity, Bell, BookOpen, ChartNoAxesCombined, CheckCheck, ChevronRight, CircleDot, FileText, GitBranch, LayoutDashboard, Menu, Moon, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles } from '@lucide/vue';
import type { SystemStatus } from '@/types';
import { getIssueIid } from '@/types';
import { useTasks } from '@/composables/useTasks';
import { useSSE } from '@/composables/useSSE';
import { useIssueDetail } from '@/composables/useIssueDetail';
import * as api from '@/api/client';
import NativeTaskTable from './NativeTaskTable.vue';
import NativeWorkspacePage from './NativeWorkspacePage.vue';
import NativeIssueDetailPage from './NativeIssueDetailPage.vue';

const systemStatus = ref<SystemStatus | null>(null);
const route = ref(location.hash || '#/workbench');
const mobileMenu = ref(false);
const refreshBusy = ref(false);
const { tasks, loading, error, refresh } = useTasks('issue');
const detail = useIssueDetail();
const connectedState = useSSE((eventName, rawPayload) => {
  const payload = rawPayload as { data?: { issueIid?: number } };
  if (eventName.startsWith('issue:') || eventName.startsWith('gate:') || eventName.startsWith('phase:') || eventName.startsWith('pipeline:') || eventName.startsWith('uat:')) {
    refresh();
    if (payload.data?.issueIid && detail.selectedIssue.value && getIssueIid(detail.selectedIssue.value) === payload.data.issueIid) detail.refreshDetail();
  }
});
const connected = connectedState.connected;
const page = computed(() => {
  const value = route.value.replace(/^#\//, '').split('/')[0];
  return ['workbench', 'drafts', 'knowledge', 'analytics', 'settings'].includes(value) ? value : 'workbench';
});
const isIssueRoute = computed(() => /^issue\/\d+$/.test(route.value.replace(/^#\//, '')));
const issueNumber = computed(() => { const match = route.value.match(/^#\/issue\/(\d+)/); return match ? Number(match[1]) : 0; });
const navPage = computed(() => isIssueRoute.value ? 'workbench' : page.value);
const currentPage = computed(() => page.value as 'workbench' | 'drafts' | 'knowledge' | 'analytics' | 'settings');
const workspacePage = computed(() => (currentPage.value === 'workbench' ? 'drafts' : currentPage.value));
const running = computed(() => tasks.value.filter(task => task.stateCategory === 'active'));
const reviews = computed(() => tasks.value.filter(task => task.stateCategory === 'blocked'));
const completed = computed(() => tasks.value.filter(task => task.stateCategory === 'completed'));
const failures = computed(() => tasks.value.filter(task => task.stateCategory === 'failed'));
const metrics = computed(() => [
  { title: '全部任务', value: tasks.value.length, note: '当前仓库的全部 Issue', icon: Activity, type: '' },
  { title: '正在执行', value: running.value.length, note: `${running.value.length} 个任务占用 AI 额度`, icon: CircleDot, type: 'primary' },
  { title: '等待审核', value: reviews.value.length, note: '需要你的下一步决策', icon: ShieldCheck, type: 'warning' },
  { title: '已完成交付', value: completed.value.length, note: '构建、验证与验收完成', icon: CheckCheck, type: 'success' },
]);
const menuOptions: MenuOption[] = [
  { key: 'workbench', label: '任务工作台', icon: () => h(LayoutDashboard, { size: 18 }), extra: () => h('span', { class: 'prototype-nav-count' }, tasks.value.length) },
  { key: 'drafts', label: '需求草稿', icon: () => h(FileText, { size: 18 }) },
  { key: 'knowledge', label: '知识与经验', icon: () => h(BookOpen, { size: 18 }) },
  { key: 'analytics', label: '任务统计', icon: () => h(ChartNoAxesCombined, { size: 18 }) },
  { key: 'settings', label: '设置', icon: () => h(Settings2, { size: 18 }) },
];

function navigate(path: string) { window.location.hash = `#/${path}`; }
function selectNav(key: string) { navigate(key); mobileMenu.value = false; }
async function refreshAll() { if (refreshBusy.value) return; refreshBusy.value = true; try { await refresh(); } finally { refreshBusy.value = false; } }
async function openIssue(number: number) { navigate(`issue/${number}`); }
async function fetchStatus() { try { systemStatus.value = await api.fetchSystemStatus(); } catch { /* 后端暂不可用时保留页面 */ } }

function onHashChange() { route.value = location.hash || '#/workbench'; document.title = page.value === 'workbench' ? '任务工作台 · IssueFlow' : `${page.value} · IssueFlow`; }
onMounted(async () => { window.addEventListener('hashchange', onHashChange); onHashChange(); await refresh(); await fetchStatus(); });
onUnmounted(() => window.removeEventListener('hashchange', onHashChange));
</script>

<template>
  <NConfigProvider :theme="null">
    <NMessageProvider><NDialogProvider><div class="prototype-shell">
      <a class="prototype-skip-link" href="#prototype-main">跳到主要内容</a>
      <div class="prototype-preview-strip"><div><span class="prototype-preview-dot"></span><strong>设计预览</strong><span>V2 · Native 工作台</span></div><div class="prototype-preview-tools"><span>场景</span><NTag size="small" :bordered="false">真实数据</NTag><span>当前分支：LangGraph Native</span></div></div>
      <aside class="prototype-sidebar">
        <a class="prototype-brand" href="#/workbench"><span class="prototype-brand-symbol"><GitBranch :size="24" /></span><span><strong>IssueFlow</strong><small>AI ISSUE WORKSPACE</small></span></a>
        <div class="prototype-repo-card"><GitBranch :size="18" /><div><strong>issue-auto-finish</strong><small>LangGraph Native</small></div><span class="prototype-repo-dot"></span></div>
        <div class="prototype-nav-label">工作空间</div>
        <NMenu :value="navPage" :options="menuOptions" :indent="14" @update:value="selectNav" />
        <div class="prototype-sidebar-bottom"><div class="prototype-side-tip"><Sparkles :size="18" /><p>每一次交付，<br>都为下一次积累经验。</p></div><div class="prototype-local-workspace"><span class="prototype-user-avatar">L</span><div><strong>本地工作空间</strong><small>单仓库 · 单实例</small></div></div></div>
      </aside>
      <div class="prototype-main">
        <header class="prototype-topbar"><div class="prototype-topbar-left"><NButton quaternary circle class="prototype-mobile-menu" aria-label="打开导航" @click="mobileMenu = true"><template #icon><Menu :size="20" /></template></NButton><GitBranch :size="16" /><span>issue-auto-finish</span><ChevronRight :size="13" /><strong>{{ isIssueRoute ? 'Issue 执行详情' : page === 'workbench' ? '任务工作台' : page === 'drafts' ? '需求草稿' : page === 'knowledge' ? '知识与经验' : page === 'analytics' ? '任务统计' : '设置' }}</strong><span class="prototype-connection-pill"><span></span>{{ connected ? '实时连接' : '连接中断' }}</span></div><div class="prototype-topbar-actions"><NButton quaternary class="prototype-quick-search"><template #icon><Search :size="17" /></template>快速查找</NButton><span class="prototype-local-pill"><span></span>本地数据</span><NButton quaternary circle aria-label="切换主题"><template #icon><Moon :size="18" /></template></NButton><NBadge :value="reviews.length + failures.length" :show="reviews.length + failures.length > 0"><NButton quaternary circle aria-label="查看待处理事项"><template #icon><Bell :size="18" /></template></NButton></NBadge></div></header>
        <main id="prototype-main" class="prototype-content" tabindex="-1">
          <NativeIssueDetailPage v-if="isIssueRoute" :issue-number="issueNumber" :system-status="systemStatus" />
          <template v-else-if="page === 'workbench'">
            <header class="prototype-page-heading"><div><div class="prototype-eyebrow">YOUR WORK, IN FLOW</div><h1>任务工作台</h1><p>从需求到交付，掌握每个 Issue 的执行脉络。</p></div><div class="prototype-heading-actions"><NButton :loading="refreshBusy" @click="refreshAll"><template #icon><RefreshCw :size="16" /></template>刷新</NButton><NButton type="primary" @click="navigate('drafts')"><template #icon><Plus :size="18" /></template>新建需求</NButton></div></header>
            <section class="prototype-metrics-grid" aria-label="任务统计"><NCard v-for="metric in metrics" :key="metric.title" class="prototype-metric-card" :class="'prototype-metric-' + metric.type"><div class="prototype-metric-label"><span>{{ metric.title }}</span><component :is="metric.icon" :size="17" /></div><strong class="prototype-metric-value">{{ metric.value }}<span v-if="metric.type === 'primary'" class="prototype-live-dot"></span></strong><p>{{ metric.note }}</p></NCard></section>
            <div class="prototype-workbench-columns"><div class="prototype-workbench-primary"><section v-if="reviews.length" class="prototype-review-notice"><span class="prototype-notice-symbol"><ShieldCheck :size="23" /></span><div><strong>{{ reviews.length }} 份实施计划等待审核</strong><p>确认任务范围与验收标准后，AI 将开始构建。</p></div><NButton text @click="openIssue(Number(reviews[0].taskId))">去审核<ChevronRight :size="17" /></NButton></section><NativeTaskTable :tasks="tasks" :loading="loading" :error="error" @select="openIssue" /></div><aside class="prototype-workbench-aside"><NCard title="运行概况" class="prototype-capacity-card"><template #header-extra><NTag size="small" :bordered="false" type="success">正常</NTag></template><div class="prototype-capacity-caption">AI 并发额度<strong>{{ running.length }} <span>/ 4</span></strong></div><NProgress type="line" :percentage="Math.min(100, running.length / 4 * 100)" :show-indicator="false" :height="6" color="#168875" rail-color="#e6edef" /><p class="prototype-capacity-hint">{{ Math.max(0, 4 - running.length) }} 个额度可用</p><dl class="prototype-detail-data"><div><dt>正在推进</dt><dd>{{ running.length }} 个 Issue</dd></div><div><dt>等待审核</dt><dd>{{ reviews.length }} 个 Issue</dd></div><div><dt>当前执行器</dt><dd>{{ systemStatus?.config.aiMode ?? 'Codex' }}</dd></div></dl><NDivider /><button v-if="running[0]" class="prototype-current-run" @click="openIssue(Number(running[0].taskId))"><span><CircleDot :size="16" />关注当前执行</span><strong>#{{ running[0].taskId }} {{ running[0].title }}</strong><small>打开执行视图 <ChevronRight :size="14" /></small></button><NEmpty v-else description="当前没有执行中的任务" size="small" /></NCard><NCard title="最近动态" class="prototype-activity-card"><template #header-extra><Activity :size="16" class="prototype-muted" /></template><NTimeline><NTimelineItem v-if="running[0]" type="success" :title="'#' + running[0].taskId + ' 正在推进'" content="Native 流水线正在执行" time="刚刚" /><NTimelineItem v-if="reviews[0]" type="warning" :title="'#' + reviews[0].taskId + ' 计划已就绪'" content="等待审核实施方案" time="最近" /><NTimelineItem v-if="completed[0]" type="default" :title="'#' + completed[0].taskId + ' 已交付'" content="构建与验收已完成" time="最近" /></NTimeline></NCard></aside></div>
          </template>
          <NativeWorkspacePage v-else :page="workspacePage" :tasks="tasks" :system-status="systemStatus" @create="navigate('drafts')" />
        </main>
      </div>
      <NDrawer v-model:show="mobileMenu" placement="left" :width="280"><NDrawerContent title="IssueFlow 工作空间" closable><NMenu :value="navPage" :options="menuOptions" @update:value="selectNav" /></NDrawerContent></NDrawer>
    </div></NDialogProvider></NMessageProvider>
  </NConfigProvider>
</template>
