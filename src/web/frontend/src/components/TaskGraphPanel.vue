<script setup lang="ts">
import { computed, ref } from 'vue';
import { useIssueGraphs } from '@/composables/useIssueGraphs';
import ExecutionGraph from './ExecutionGraph.vue';
import type { GraphTopology, IssueGraphs } from '../../../../shared/workflowGraphs.js';
const props = defineProps<{ issueNumber: number; stateVersion?: number }>();
const { graph, error, loading, refresh } = useIssueGraphs(props);
const debug = ref(false), showTasks = ref(true);
const tasks = computed(() => graph.value?.tasks ?? []);
const labels: Record<string, string> = { pending: '待执行', running: '执行中', 'waiting-merge': '等待合并', merging: '正在集成', merged: '已合并', failed: '失败', uncertain: '结果待核对' };
function status(task: IssueGraphs['tasks'][number]): string {
  if (task.status === 'merged') return task.success && task.merge?.stage === 'merged' ? '已合并' : '凭证待核对';
  if (task.status === 'pending' && task.dependsOn.some(id => tasks.value.find(t => t.id === id)?.status !== 'merged')) return '等待前置任务';
  return labels[task.status ?? 'pending'];
}
const taskStatuses = computed(() => Object.fromEntries(tasks.value.map(task => [task.id, status(task)])));
const names: Record<string, string> = { plan: '计划', review: '审核', build: '构建', verify: '验证', uat: '验收', deliver: '交付', __start__: '开始', __end__: '结束' };
const order = ['__start__', 'plan', 'publish_plan', 'review', 'build', 'publish_build', 'verify', 'publish_verify', 'uat', 'publish_uat', 'deliver', '__end__'];
const workflow = computed<GraphTopology>(() => {
  if (!graph.value) return { nodes: [], edges: [] };
  const raw = graph.value.workflow;
  if (debug.value) return raw;
  const ids = new Set([...graph.value.phaseIds, 'deliver']);
  // 业务视图折叠发布节点，路由仍完全取自原生图。
  const fold = (id: string) => id.replace(/^publish_/, '');
  const edges = raw.edges.map(edge => ({ ...edge, source: fold(edge.source), target: fold(edge.target) }))
    .filter(edge => !edge.disabled && edge.source !== edge.target && ids.has(edge.source) && ids.has(edge.target));
  return { nodes: raw.nodes.filter(node => ids.has(node.id)).map(node => ({ ...node, label: names[node.id] ?? node.id })), edges };
});
const workflowOrder = computed(() => order.filter(id => workflow.value.nodes.some(node => node.id === id)));
const active = computed(() => graph.value?.checkpoint.next.map(id => debug.value ? id : id.replace(/^publish_/, '')) ?? []);
function selectNode(id: string) { if (id === 'build') { showTasks.value = true; document.getElementById(`tasks-${props.issueNumber}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }
</script>
<template>
  <section class="execution-surface">
    <div class="execution-head"><div><div class="execution-eyebrow">EXECUTION GRAPH</div><h3>Issue 主流程</h3></div><button class="execution-refresh" type="button" :disabled="loading" @click="refresh">{{ loading ? '读取中…' : '刷新图数据' }}</button></div>
    <div v-if="loading" class="execution-state" role="status">正在读取本轮流程…</div>
    <div v-if="error" class="execution-state execution-error" role="alert">{{ error }}</div>
    <template v-if="graph">
      <div class="execution-meta"><span>计划 v{{ graph.planRevision }}</span><span>构建 {{ graph.buildGeneration }}</span><span>流程 {{ graph.workflowGeneration }}</span><span>状态 {{ graph.lifecycle }}</span><label><input v-model="debug" type="checkbox" /> 原生节点</label></div>
      <div class="graph-viewport"><ExecutionGraph :graph="workflow" :order="workflowOrder" :active="active" @select="selectNode" /></div>
      <div class="graph-statusbar"><span>{{ graph.checkpoint.exists ? (graph.checkpoint.next.length ? '检查点下一步：' + graph.checkpoint.next.join('、') : '检查点已无后续节点') : '尚无检查点，当前位置未确定。' }}</span><span v-if="graph.checkpoint.tasks.some(task => task.interrupts.length)">等待人工审核</span></div>
      <p v-if="graph.buildEntry === 'repair-integration'" class="my-2 text-amber-600">当前进入集成修复，第 {{ graph.repairRounds }} 轮；保留原任务合并结果。</p>
      <details v-if="graph.repairReason"><summary>修复原因</summary><p class="whitespace-pre-wrap text-sm">{{ graph.repairReason }}</p></details>
      <details v-if="debug" class="my-2"><summary>检查点详情</summary><code>{{ graph.threadId }} · 记录版本 {{ graph.version }}</code><pre class="overflow-auto text-xs">{{ JSON.stringify(graph.checkpoint.tasks, null, 2) }}</pre></details>
      <div :id="`tasks-${issueNumber}`" class="task-graph-heading"><button type="button" @click="showTasks = !showTasks">{{ showTasks ? '收起' : '展开' }} build 任务图</button></div>
      <template v-if="showTasks">
        <p class="task-graph-help">前置任务合并后才执行后续任务，全部完成后统一验收。点击主流程构建节点可定位到本图。</p>
        <p v-if="!tasks.length" class="execution-state">计划尚未生成。</p>
        <ExecutionGraph v-else :graph="graph.topology" :statuses="taskStatuses" :active="tasks.filter(task => task.status === 'running').map(task => task.id)" />
    <div class="task-table-scroll">
      <table v-if="tasks.length" class="task-table">
        <thead><tr><th>任务</th><th>依赖</th><th>状态</th><th>尝试</th><th>执行结果</th></tr></thead>
        <tbody><tr v-for="task in tasks" :key="task.id">
          <td><strong>{{ task.id }} · {{ task.title }}</strong><details><summary>实施要求</summary><p>{{ task.instructions }}</p><ul><li v-for="criterion in task.acceptanceCriteria" :key="criterion">{{ criterion }}</li></ul></details></td>
          <td>{{ task.dependsOn.join('、') || '无' }}</td>
          <td><span class="task-status-label">{{ status(task) }}</span></td><td>{{ task.attemptNo || '—' }}</td>
          <td><p v-if="task.error" class="task-error">{{ task.error }}</p><span v-else-if="task.success">{{ task.success.noChange ? '执行完成，无内容变化' : '执行成功' }}</span><code v-if="task.merge?.integrationAfter" class="task-commit">{{ task.merge.integrationAfter.slice(0, 12) }}</code></td>
        </tr></tbody>
      </table>
    </div>
      </template>
    </template>
  </section>
</template>
