<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json, type KnowledgeItem } from "@/api/mini";
import { useAction } from "@/composables/useAction";
defineProps<{ knowledgeEnabled?: boolean }>();
const entries = ref<KnowledgeItem[]>([]),
  title = ref(""),
  content = ref(""),
  versions = ref<unknown[]>([]);
const { busy, error, run } = useAction();
const profile = ref({
  description: "",
  language: "",
  frameworks: [] as string[],
  installCommand: "",
  lintCommand: "",
  buildCommand: "",
  testCommand: "",
  rules: "",
});
const profileMessage = ref("");
const profileLabels = {
  description: "项目说明",
  language: "主要语言",
  installCommand: "安装命令",
  lintCommand: "静态检查命令",
  buildCommand: "构建命令",
  testCommand: "测试命令",
  rules: "项目规则（每行一条）",
};
async function saveProfile() {
  await json("/api/project-profile", "PUT", profile.value);
  profileMessage.value = "项目上下文已保存，后续任务将使用新配置。";
}
async function load() {
  entries.value = (
    await json<{ entries: KnowledgeItem[] }>("/api/knowledge")
  ).entries;
}
async function add() {
  await json("/api/knowledge", "POST", {
    title: title.value,
    content: content.value,
  });
  title.value = "";
  content.value = "";
  await load();
}
async function toggle(item: KnowledgeItem) {
  await json(`/api/knowledge/${item.id}/enabled`, "PUT", {
    enabled: !item.tags.includes("enabled"),
  });
  await load();
}
async function remove(item: KnowledgeItem) {
  if (!confirm("删除此知识条目？版本历史仍保留。")) return;
  await json(`/api/knowledge/${item.id}`, "DELETE");
  await load();
}
async function history(item: KnowledgeItem) {
  versions.value = (
    await json<{ versions: unknown[] }>(`/api/knowledge/${item.id}/versions`)
  ).versions;
}
onMounted(() =>
  run(async () => {
    await load();
    profile.value = await json<typeof profile.value>("/api/project-profile");
  }),
);
</script>
<template>
  <section class="mini-panel">
    <h2>知识与经验</h2>
    <p v-if="knowledgeEnabled === false" role="status">任务知识引用已关闭。你仍可管理资料，开启并重启服务后，任务才会引用这些知识与经验。</p>
    <p>
      本地知识、蒸馏记忆和通用 Markdown 规则。启用的规则会进入后续任务提示词。
    </p>
    <details>
      <summary>项目说明、技术栈与测试命令</summary>
      <form @submit.prevent="run(saveProfile)">
        <label
          v-for="(label, key) in profileLabels"
          :key="key"
          class="block my-3"
          >{{ label
          }}<textarea v-model="profile[key]" :aria-label="label" rows="2" />
        </label>
        <label
          >技术框架（逗号分隔）<input
            :value="profile.frameworks.join(', ')"
            aria-label="技术框架"
            @input="
              profile.frameworks = ($event.target as HTMLInputElement).value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            "
        /></label>
        <button :disabled="busy">保存项目上下文</button>
        <p role="status">{{ profileMessage }}</p>
      </form>
    </details>
    <input
      v-model="title"
      aria-label="知识标题"
      placeholder="知识标题"
    /><textarea
      v-model="content"
      aria-label="知识内容"
      rows="4"
      placeholder="Markdown 内容"
    />
    <button
      :disabled="busy || !title.trim() || !content.trim()"
      @click="run(add)"
    >
      添加知识
    </button>
    <p v-if="error" role="alert" class="mini-error">{{ error }}</p>
    <p v-if="!entries.length">暂无知识条目。</p>
    <article v-for="item in entries" :key="item.id" class="mini-card">
      <h3>
        {{ item.title }} <small>{{ item.type }}</small>
      </h3>
      <pre>{{ item.content }}</pre>
      <button
        v-if="item.type === 'agent-rule'"
        :disabled="busy || item.deprecated"
        @click="run(() => toggle(item))"
      >
        {{ item.tags.includes("enabled") ? "停用规则" : "启用规则" }}
      </button>
      <button :disabled="busy" @click="run(() => history(item))">
        查看版本</button
      ><button :disabled="busy" @click="run(() => remove(item))">删除</button>
    </article>
    <details>
      <summary>所选条目的版本记录（{{ versions.length }}）</summary>
      <pre>{{ JSON.stringify(versions, null, 2) }}</pre>
    </details>
  </section>
</template>
