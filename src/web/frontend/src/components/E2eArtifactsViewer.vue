<script setup lang="ts">
import { ref, watch } from "vue";
import { json, type UatRun } from "@/api/mini";
import { useAction } from "@/composables/useAction";
const props = defineProps<{ issueIid?: number }>(),
  runs = ref<UatRun[]>([]);
const { busy, error, run } = useAction();
async function load() {
  if (props.issueIid)
    runs.value = (
      await json<{ runs: UatRun[] }>(`/api/issues/${props.issueIid}/uat-runs`)
    ).runs;
}
watch(
  () => props.issueIid,
  () => run(load),
  { immediate: true },
);
</script>
<template>
  <section class="mini-panel">
    <h3>浏览器验收记录</h3>
    <button :disabled="busy" @click="run(load)">刷新验收结果</button>
    <p v-if="error" role="alert" class="mini-error">{{ error }}</p>
    <p v-if="!runs.length">暂无验收记录。</p>
    <article v-for="item in runs" :key="item.runId" class="mini-card">
      <h3 :class="item.passed ? 'text-green-700' : 'text-red-700'">
        {{ item.passed ? "通过" : "未通过" }} ·
        {{ new Date(item.startedAt).toLocaleString() }}
      </h3>
      <p>
        通过 {{ item.passedTests }} · 失败 {{ item.failedTests }} · 跳过
        {{ item.skippedTests }}
      </p>
      <p v-if="item.error" class="mini-error">{{ item.error }}</p>
      <a
        v-if="item.reportAvailable"
        :href="`/api/uat/runs/${item.runId}/files/report/index.html`"
        target="_blank"
        rel="noreferrer"
        >打开本次 HTML 报告</a
      >
      <div class="flex flex-wrap gap-3">
        <a
          v-for="shot in item.screenshots"
          :key="shot"
          :href="`/api/uat/runs/${item.runId}/files/${shot}`"
          target="_blank"
          rel="noreferrer"
          ><img
            :src="`/api/uat/runs/${item.runId}/files/${shot}`"
            :alt="shot"
            class="max-w-48"
        /></a>
      </div>
    </article>
  </section>
</template>
