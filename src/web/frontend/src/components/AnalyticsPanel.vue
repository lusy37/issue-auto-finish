<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json, type TaskSummary } from "@/api/mini";
import { useAction } from "@/composables/useAction";
const range = ref("7d"),
  data = ref<TaskSummary>();
const { busy, error, run } = useAction();
async function load() {
  data.value = await json<TaskSummary>(
    "/api/analytics/summary?range=" + range.value,
  );
}
const rate = (v: number | null) =>
  v === null ? "暂无数据" : (v * 100).toFixed(1) + "%";
const duration = (v: number | null) =>
  v === null ? "暂无数据" : (v / 1000).toFixed(1) + " 秒";
onMounted(() => run(load));
</script>
<template>
  <section class="mini-panel">
    <h2>任务统计</h2>
    <select v-model="range" aria-label="统计时间范围" @change="run(load)">
      <option value="7d">最近 7 天</option>
      <option value="30d">最近 30 天</option>
      <option value="all">全部数据</option></select
    ><button :disabled="busy" @click="run(load)">刷新</button>
    <p>
      按任务创建时间筛选；成功率只计算当前成功或失败终态。总耗时包含审核等待，阶段耗时仅计算实际执行。
    </p>
    <p v-if="error" class="mini-error" role="alert">{{ error }}</p>
    <template v-if="data"
      ><div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div
          v-for="[label, value] in [
            ['任务总量', data.total],
            ['成功 / 失败', `${data.completed} / ${data.failed}`],
            ['成功率', rate(data.successRate)],
            ['重试次数', data.retries],
            ['审核介入', data.interventions],
            [
              '总耗时',
              duration(
                data.completed + data.failed ? data.totalDurationMs : null,
              ),
            ],
            ['平均耗时', duration(data.averageDurationMs)],
            ['UAT 通过率', rate(data.uat.passRate)],
          ]"
          :key="label"
          class="mini-card"
        >
          <p>{{ label }}</p>
          <strong>{{ value }}</strong>
        </div>
      </div>
      <h3>阶段执行情况</h3>
      <p v-if="!Object.keys(data.phases).length">暂无数据</p>
      <table v-else class="w-full text-left">
        <thead>
          <tr>
            <th>阶段</th>
            <th>执行次数</th>
            <th>失败次数</th>
            <th>实际耗时</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(phase, name) in data.phases" :key="name">
            <td>{{ name }}</td>
            <td>{{ phase.runs }}</td>
            <td>{{ phase.failures }}</td>
            <td>{{ duration(phase.durationMs) }}</td>
          </tr>
        </tbody>
      </table></template
    >
  </section>
</template>
