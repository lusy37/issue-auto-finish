<script setup lang="ts">
import { AI_DEFAULTS, PROJECT_DEFAULTS } from "../../../../shared/runtime/defaults.js";
import { ref, onMounted } from "vue";
import { json } from "@/api/mini";
import { useAction } from "@/composables/useAction";
const values = ref<Record<string, string>>({}),
  message = ref(""),
  checks = ref<{ name: string; ok: boolean; message: string }[]>([]);
const { busy, error, run } = useAction();
const featureLabels: Record<string, string> = {
  REVIEW_ENABLED: "启用计划审核",
  E2E_UI_ENABLED: "启用浏览器验收（E2E）",
  KNOWLEDGE_ENABLED: "任务引用知识与经验",
  DISTILL_ENABLED: "启用经验蒸馏",
  VERIFY_FIX_LOOP_ENABLED: "验证失败后自动修复",
};
const labels: Record<string, string> = {
  MAX_CONCURRENT_ISSUES: `同时执行的父 Issue 数量（默认 ${PROJECT_DEFAULTS.maxConcurrentIssues}）`,
  AI_MAX_CONCURRENCY: `全局 AI 并发额度（默认 ${AI_DEFAULTS.maxConcurrency}，范围 1～${AI_DEFAULTS.maxConcurrencyLimit}）`,
  MAX_RETRIES: "首次执行之外的自动重试次数（0 表示不自动重试）",
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
  PREVIEW_STARTUP_TIMEOUT_MS: "预览启动就绪超时（毫秒）",
  PREVIEW_READINESS_INTERVAL_MS: "预览探测间隔（毫秒）",
  PREVIEW_BACKEND_READY_URL: "后端就绪 HTTP 地址（可用 {port}；留空探测端口）",
  PREVIEW_FRONTEND_READY_URL: "前端就绪 HTTP 地址（可用 {port}；留空探测端口）",
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
async function checkConnection() {
  const result = await json<{ ok: boolean; message: string }>(
    "/api/settings/check-connection",
    "POST",
  );
  message.value = (result.ok ? "✓ " : "✗ ") + result.message;
}
onMounted(() => run(load));
</script>
<template>
  <section class="mini-panel">
    <h2>设置</h2>
    <p>
      单用户、单仓库，执行器使用Codex SDK。配置保存在当前项目的独立数据目录。
    </p>
    <p>父 Issue 并发限制同时推进的需求数量；全局 AI 额度限制全部需求和后台功能合计的 AI 调用。等待额度时不会启动新调用。</p>
    <form @submit.prevent="run(save)">
      <fieldset class="my-4 border rounded p-4">
        <legend>流程与知识</legend>
        <label v-for="(label, key) in featureLabels" :key="key" class="block my-3">
          <input v-model="values[key]" type="checkbox" true-value="true" false-value="false" :aria-label="label" />
          {{ label }}
        </label>
        <label class="block my-3">最大自动修复轮数
          <input :value="values.VERIFY_FIX_MAX_ITERATIONS" @input="values.VERIFY_FIX_MAX_ITERATIONS = ($event.target as HTMLInputElement).value" type="number" min="1" max="10" step="1"
            :disabled="values.VERIFY_FIX_LOOP_ENABLED === 'false'" aria-label="最大自动修复轮数" />
        </label>
        <p class="text-sm text-gray-500">次数为初次验证失败后追加的修复轮数，范围 1～10。以上设置保存后重启生效。</p>
        <p class="text-sm text-gray-500">关闭审核后，新计划保存完成会自动继续实现；已等待审核的任务仍需手动处理。</p>
        <p class="text-sm text-gray-500">关闭浏览器验收后仍执行代码验证，交付会注明未执行浏览器验收。重启后新任务或完整重做采用新设置，已开始的流程保持原要求；预览服务由预览设置单独控制。</p>
        <p class="text-sm text-gray-500">关闭知识引用或蒸馏不会删除资料。知识引用决定任务是否使用经验，蒸馏决定是否生成新经验。</p>
      </fieldset>
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
    <button
      :disabled="busy"
      @click="
        run(async () => {
          const result = await json<{ ok: boolean; message: string }>(
            '/api/settings/check-github',
            'POST',
          );
          message = result.message;
        })
      "
    >
      检查 GitHub 仓库连接
    </button>
    <button :disabled="busy" @click="run(checkConnection)">
      检查 Codex 连接（实际调用）
    </button>
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
      >；先运行 <code>npx codex login</code> 登录；启用浏览器验收时运行
      <code>npm run e2e:install</code> 安装 Chromium。
    </p>
  </section>
</template>
