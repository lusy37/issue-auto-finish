<script setup lang="ts">
import { ref, watch } from 'vue';
import { json } from '@/api/mini';
import type { TaskDefinition, TaskRun } from '../../../../shared/workbench';
const props = defineProps<{ issueNumber: number; stateVersion?: number }>();
const tasks = ref<Array<TaskDefinition & TaskRun>>([]);
const revision = ref(0), generation = ref(0), error = ref('');
const labels: Record<TaskRun['status'], string> = { pending: '待执行', running: '执行中', 'waiting-merge': '等待合并', merging: '正在集成', merged: '已合并', failed: '失败', uncertain: '结果待核对' };
let request = 0;
watch(() => [props.issueNumber, props.stateVersion], async () => {
  const current = ++request;
  try {
    const result = await json<{planRevision: number; buildGeneration: number; tasks: Array<TaskDefinition & TaskRun>}>(`/api/issues/${props.issueNumber}/tasks`);
    if (current !== request) return;
    tasks.value = result.tasks;
    revision.value = result.planRevision;
    generation.value = result.buildGeneration;
    error.value = '';
  } catch (failure) { if (current === request) error.value = (failure as Error).message; }
}, { immediate: true });
function status(task: TaskDefinition & TaskRun): string {
  if (task.status === 'pending' && task.dependsOn.some(id => tasks.value.find(t => t.id === id)?.status !== 'merged')) return '等待前置任务';
  return labels[task.status] ?? '待执行';
}
</script>
<template>
  <section class="p-4">
    <h3 class="font-semibold">内部任务</h3>
    <p class="text-sm text-gray-500 my-2">计划版本 {{ revision }} · 构建轮次 {{ generation }}。前置任务合并后才执行后续任务，全部完成后统一验收。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!tasks.length">计划尚未生成。</p>
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
  </section>
</template>
