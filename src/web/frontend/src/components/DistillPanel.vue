<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json } from "@/api/mini";
import { useAction } from "@/composables/useAction";
const status = ref<{
  enabled: boolean;
  running: boolean;
  runs: {
    id: string;
    startedAt: string;
    finishedAt?: string;
    status: string;
    error?: string;
  }[];
  diaryCount: number;
  undistilledDiaryCount: number;
  memoryCount: number;
  ruleCount: number;
}>();
const diaries = ref<
    { id: string; issueIid?: number; outcome?: string; createdAt?: string }[]
  >([]),
  result = ref<unknown>();
const { busy, error, run } = useAction();
async function load() {
  const [s, d] = await Promise.all([
    json<{ status: typeof status.value }>("/api/distill/status"),
    json<{ diaries: typeof diaries.value }>("/api/distill/diaries"),
  ]);
  status.value = s.status;
  diaries.value = d.diaries;
}
async function distill() {
  try {
    result.value = await json("/api/distill/run", "POST");
  } finally {
    await load();
  }
}
onMounted(() => run(load));
</script>
<template>
  <section class="mini-panel">
    <h2>经验蒸馏</h2>
    <p>
      任务完成或失败后自动采集日记。手动蒸馏将日记提炼为记忆与规则，规则需要在知识页启用。
    </p>
    <p v-if="status">
      日记 {{ status.diaryCount }} · 待蒸馏 {{ status.undistilledDiaryCount }} ·
      记忆 {{ status.memoryCount }} · 规则 {{ status.ruleCount }}
    </p>
    <p v-if="status && !status.enabled" role="status">经验蒸馏已关闭，请在设置中开启并重启服务。已有经验和日记仍保留。</p>
    <button :disabled="busy || !status?.enabled || status.running" @click="run(distill)">
      {{ busy || status?.running ? "正在处理…" : "手动蒸馏" }}</button
    ><button :disabled="busy" @click="run(load)">刷新</button>
    <p v-if="error" class="mini-error" role="alert">{{ error }}</p>
    <pre v-if="result">{{ JSON.stringify(result, null, 2) }}</pre>
    <h3>蒸馏执行记录</h3>
    <p v-if="!status?.runs?.length">暂无执行记录。</p>
    <article v-for="item in status?.runs" :key="item.id" class="mini-card">
      <p>
        {{ item.startedAt }} ·
        {{
          item.status === "completed"
            ? "已完成"
            : item.status === "failed"
              ? "失败"
              : "执行中"
        }}
      </p>
      <p v-if="item.error" class="mini-error">{{ item.error }}</p>
    </article>
    <h3>任务日记</h3>
    <p v-if="!diaries.length">完成一个任务后，这里将显示执行日记。</p>
    <details v-for="diary in diaries" :key="diary.id" class="mini-card">
      <summary>
        Issue #{{ diary.issueIid }} · {{ diary.outcome }} ·
        {{ diary.createdAt }}
      </summary>
      <pre>{{ JSON.stringify(diary, null, 2) }}</pre>
    </details>
  </section>
</template>
