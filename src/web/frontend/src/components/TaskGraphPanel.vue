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
  <section class="p-4">
    <div class="flex items-center justify-between"><h3 class="font-semibold">Issue 主流程</h3><button class="text-blue-600" @click="refresh">刷新</button></div>
    <p v-if="loading" class="my-3">正在读取本轮流程…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="graph">
      <p class="text-sm text-gray-500 my-2">计划 {{ graph.planRevision }} · 构建 {{ graph.buildGeneration }} · 流程 {{ graph.workflowGeneration }} · 状态 {{ graph.lifecycle }}</p>
      <label class="text-sm"><input v-model="debug" type="checkbox" /> 显示原生节点与声明路由</label>
      <ExecutionGraph :graph="workflow" :order="workflowOrder" :active="active" @select="selectNode" />
      <p class="text-sm">{{ graph.checkpoint.exists ? (graph.checkpoint.next.length ? '检查点下一步：' + graph.checkpoint.next.join('、') : '检查点已无后续节点') : '尚无检查点，当前位置未确定。' }}</p>
      <p v-for="task in graph.checkpoint.tasks.filter(task => task.interrupts.length)" :key="task.id" class="text-sm text-amber-600">{{ task.name }}：等待人工审核</p>
      <p v-if="graph.buildEntry === 'repair-integration'" class="my-2 text-amber-600">当前进入集成修复，第 {{ graph.repairRounds }} 轮；保留原任务合并结果。</p>
      <details v-if="graph.repairReason"><summary>修复原因</summary><p class="whitespace-pre-wrap text-sm">{{ graph.repairReason }}</p></details>
      <details v-if="debug" class="my-2"><summary>检查点详情</summary><code>{{ graph.threadId }} · 记录版本 {{ graph.version }}</code><pre class="overflow-auto text-xs">{{ JSON.stringify(graph.checkpoint.tasks, null, 2) }}</pre></details>
      <div :id="`tasks-${issueNumber}`" class="mt-5"><button class="font-semibold" @click="showTasks = !showTasks">{{ showTasks ? '收起' : '展开' }} build 任务图</button></div>
      <template v-if="showTasks">
        <p class="text-sm text-gray-500 my-2">前置任务合并后才执行后续任务，全部完成后统一验收。点击主流程构建节点可定位到本图。</p>
        <p v-if="!tasks.length">计划尚未生成。</p>
        <ExecutionGraph v-else :graph="graph.topology" :statuses="taskStatuses" :active="tasks.filter(task => task.status === 'running').map(task => task.id)" />
    <div class="overflow-x-auto">
      <table v-if="tasks.length" class="w-full text-sm text-left border-collapse">
        <thead><tr class="border-b"><th class="p-2">任务</th><th class="p-2">依赖</th><th class="p-2">状态</th><th class="p-2">尝试</th><th class="p-2">执行结果</th></tr></thead>
        <tbody><tr v-for="task in tasks" :key="task.id" class="border-b">
          <td class="p-2"><strong>{{ task.id }} · {{ task.title }}</strong><details class="mt-1"><summary>实施要求</summary><p class="whitespace-pre-wrap">{{ task.instructions }}</p><ul><li v-for="criterion in task.acceptanceCriteria" :key="criterion">{{ criterion }}</li></ul></details></td>
          <td class="p-2">{{ task.dependsOn.join('、') || '无' }}</td>
          <td class="p-2">{{ status(task) }}</td><td class="p-2">{{ task.attemptNo || '—' }}</td>
          <td class="p-2"><p v-if="task.error" class="text-red-600">{{ task.error }}</p><span v-else-if="task.success">{{ task.success.noChange ? '执行完成，无内容变化' : '执行成功' }}</span><code v-if="task.merge?.integrationAfter" class="block text-xs">{{ task.merge.integrationAfter.slice(0, 12) }}</code></td>
        </tr></tbody>
      </table>
    </div>
      </template>
    </template>
  </section>
</template>
