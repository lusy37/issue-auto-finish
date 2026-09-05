<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json } from "@/api/mini";
import { useAction } from "@/composables/useAction";
const values = ref<Record<string, string>>({}),
  message = ref(""),
  checks = ref<{ name: string; ok: boolean; message: string }[]>([]);
const { busy, error, run } = useAction();
const labels: Record<string, string> = {
  GITHUB_API_URL: "GitHub API 地址",
  GITHUB_TOKEN: "GitHub Token（留空保留原值）",
  GITHUB_REPOSITORY: "GitHub 仓库（owner/repo）",
  PROJECT_WORK_DIR: "本地仓库目录",
  GIT_ROOT_DIR: "Git 根目录",
  PROJECT_SUBDIR: "项目子目录",
  BASE_BRANCH: "基础分支",
  CODEX_BINARY: "Codex 程序路径（留空使用内置程序，Windows 需为 .exe）",
  AI_MODEL: "Codex 模型（留空使用默认）",
  AI_PHASE_TIMEOUT_MS: "AI 阶段超时（毫秒）",
  UAT_CONFIG_FILE: "Playwright 配置文件",
  UAT_TIMEOUT_MS: "验收超时（毫秒）",
  E2E_BASE_URL: "验收预览地址",
  PREVIEW_ENABLED: "启动预览服务（true / false）",
  PREVIEW_BACKEND_COMMAND: "后端启动命令（端口从 PORT 读取）",
  PREVIEW_FRONTEND_COMMAND: "前端启动命令（{port} 替换为分配端口）",
  PREVIEW_FRONTEND_DIR: "前端目录（相对仓库项目目录）",
};
async function load() {
  values.value = (
    await json<{ values: Record<string, string> }>("/api/settings")
  ).values;
}
async function save() {
  await json("/api/settings", "PUT", { values: values.value });
  message.value = "配置已保存，请重启服务使配置生效。";
}
async function check() {
  checks.value = (
    await json<{ checks: typeof checks.value }>("/api/settings/check")
  ).checks;
}

onMounted(() => run(load));
</script>
<template>
  <section class="mini-panel">
    <h2>设置</h2>
    <p>
      单用户、单仓库，执行器使用Codex SDK。配置保存在当前项目的独立数据目录。
    </p>
    <form @submit.prevent="run(save)">
      <label v-for="(label, key) in labels" :key="key" class="block my-3"
        >{{ label
        }}<input
          v-model="values[key]"
          :type="key === 'GITHUB_TOKEN' ? 'password' : 'text'"
          :aria-label="label"
          autocomplete="off" /></label
      ><button :disabled="busy">保存配置</button>
    </form>
    <button :disabled="busy" @click="run(check)">检查本机依赖</button>

    <p v-if="error" role="alert" class="mini-error">{{ error }}</p>
    <p role="status">{{ message }}</p>
    <ul>
      <li v-for="item in checks" :key="item.name">
        {{ item.ok ? "✓" : "✗" }} {{ item.name }}：{{ item.message }}
      </li>
    </ul>
    <p>
      准备 Node.js、Git for Windows 和
      <a
        href="https://developers.openai.com/codex/sdk/"
        target="_blank"
        rel="noreferrer"
        >Codex</a
      >；先运行 <code>npx codex login</code> 登录，再运行
      <code>npm run e2e:install</code> 安装 Chromium。
    </p>
  </section>
</template>
