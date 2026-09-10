<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json, type DraftBatch, type TaskDraft } from "@/api/mini";
import { useAction } from "@/composables/useAction";
const emit = defineEmits<{ created: [] }>();
const batches = ref<DraftBatch[]>([]),
  input = ref(""),
  selected = ref<string[]>([]);
const { busy, error, run } = useAction();
const labels = {
  draft: "待确认",
  creating: "创建中",
  created: "已创建",
  failed: "创建失败",
  unknown: "结果未知，需核对",
};
async function load() {
  batches.value = (await json<{ drafts: DraftBatch[] }>("/api/drafts")).drafts;
}
async function generate() {
  await json("/api/drafts", "POST", { input: input.value });
  await load();
}
async function save(batch: DraftBatch, task: TaskDraft) {
  await json(`/api/drafts/${batch.id}/tasks/${task.id}`, "PUT", task);
}
async function create(batch: DraftBatch) {
  const tasks = batch.tasks.filter(
    (t) =>
      selected.value.includes(t.id) && ["draft", "failed"].includes(t.status),
  );
  for (const task of tasks) await save(batch, task);
  await json(`/api/drafts/${batch.id}/confirm`, "POST", {
    taskIds: tasks.map((t) => t.id),
  });
  await load();
}
async function reconcile(batch: DraftBatch, task: TaskDraft) {
  const answer = window.prompt(
    "请在平台核对草稿标记和标题。已创建请输入 Issue 编号；确认未创建请输入 0。",
  );
  if (answer === null) return;
  if (!/^\d+$/.test(answer)) throw new Error("请输入有效编号");
  await json(`/api/drafts/${batch.id}/tasks/${task.id}/reconcile`, "POST", {
    issueIid: Number(answer) || null,
  });
  await load();
}
onMounted(() => run(load));
</script>
<template>
  <section class="mini-panel">
    <h2>需求拆分</h2>
    <p>
      先生成并编辑子任务草稿，确认后创建普通 Issue，再从任务工作台启动流水线。
    </p>
    <textarea
      v-model="input"
      rows="4"
      maxlength="20000"
      aria-label="原始需求"
      placeholder="描述你希望完成的需求与验收标准"
    />
    <button :disabled="busy || !input.trim()" @click="run(generate)">
      {{ busy ? "处理中…" : "生成草稿" }}
    </button>
    <p v-if="error" role="alert" class="mini-error">{{ error }}</p>
    <p v-if="!batches.length && !busy">暂无草稿。</p>
    <article v-for="batch in batches" :key="batch.id" class="mini-card">
      <p>
        {{ new Date(batch.createdAt).toLocaleString() }} · {{ batch.input }}
      </p>
      <div v-for="task in batch.tasks" :key="task.id" class="mini-card">
        <label
          ><input
            v-model="selected"
            type="checkbox"
            :value="task.id"
            :disabled="busy || !['draft', 'failed'].includes(task.status)"
          />
          {{ labels[task.status] }}</label
        >
        <input
          v-model="task.title"
          :disabled="busy || !['draft', 'failed'].includes(task.status)"
          aria-label="草稿标题"
        />
        <textarea
          v-model="task.description"
          rows="3"
          :disabled="busy || !['draft', 'failed'].includes(task.status)"
          aria-label="草稿描述"
        />
        <textarea
          v-model="task.acceptanceCriteria"
          rows="2"
          :disabled="busy || !['draft', 'failed'].includes(task.status)"
          aria-label="验收标准"
        />
        <button
          v-if="['draft', 'failed'].includes(task.status)"
          :disabled="busy"
          @click="run(() => save(batch, task))"
        >
          保存草稿
        </button>
        <a
          v-if="task.issueUrl"
          :href="task.issueUrl"
          target="_blank"
          rel="noreferrer"
          >查看 Issue #{{ task.issueIid }}</a
        >
        <p v-if="task.error" class="mini-error">{{ task.error }}</p>
        <button
          v-if="task.status === 'unknown'"
          :disabled="busy"
          @click="run(() => reconcile(batch, task))"
        >
          核对创建结果
        </button>
      </div>
      <button
        :disabled="
          busy ||
          !batch.tasks.some(
            (t) =>
              selected.includes(t.id) && ['draft', 'failed'].includes(t.status),
          )
        "
        @click="run(() => create(batch))"
      >
        确认创建选中草稿
      </button>
      <button
        v-if="batch.tasks.some((t) => t.status === 'created')"
        @click="emit('created')"
      >
        回到任务工作台
      </button>
    </article>
  </section>
</template>
