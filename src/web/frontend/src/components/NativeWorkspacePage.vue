<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NEmpty } from 'naive-ui/es/empty';
import { NInput } from 'naive-ui/es/input';
import { useMessage } from 'naive-ui/es/message';
import { NStatistic } from 'naive-ui/es/statistic';
import { NSwitch } from 'naive-ui/es/switch';
import { fetchSettings, saveSettings } from '@/api/client';
import type { ExecutableTask, SystemStatus } from '@/types';
import { isReviewWaiting } from '@/adapters/issueflowViewModel';
import TaskDistributionChart from '@/components/TaskDistributionChart.vue';
import KnowledgeWorkspace from '@/components/KnowledgeWorkspace.vue';

const props = defineProps<{
  page: 'knowledge' | 'analytics' | 'settings';
  tasks: ExecutableTask[];
  systemStatus: SystemStatus | null;
}>();
defineEmits<{ refresh: [] }>();
const message = useMessage();
const pageMeta = computed(
  () =>
    ({
      knowledge: ['知识与经验', '项目约定与交付经验，为下一次实现提供依据。'],
      analytics: ['任务统计', '回顾任务分布，找到需要关注的执行环节。'],
      settings: ['工作台设置', '调整阅读与显示偏好，让工作台适合你的节奏。'],
    })[props.page],
);
const analytics = computed(() => [
  { label: '总任务', value: props.tasks.length },
  {
    label: '已交付',
    value: props.tasks.filter((task) => task.stateCategory === 'completed').length,
  },
  { label: '待审核', value: props.tasks.filter((task) => isReviewWaiting(task.lifecycle)).length },
  { label: '需处理', value: props.tasks.filter((task) => task.stateCategory === 'failed').length },
]);
const distribution = computed(() => {
  const total = props.tasks.length;
  const categories = [
    {
      label: '执行中',
      key: 'active',
      color: '#347abe',
      matches: (task: ExecutableTask) => task.stateCategory === 'active',
    },
    {
      label: '待审核',
      key: 'review',
      color: '#c78b22',
      matches: (task: ExecutableTask) => isReviewWaiting(task.lifecycle),
    },
    {
      label: '已暂停',
      key: 'paused',
      color: '#b37a16',
      matches: (task: ExecutableTask) => task.lifecycle.kind === 'paused',
    },
    {
      label: '失败待处理',
      key: 'failed',
      color: '#bd5a5a',
      matches: (task: ExecutableTask) => task.stateCategory === 'failed',
    },
    {
      label: '已完成',
      key: 'completed',
      color: '#168875',
      matches: (task: ExecutableTask) => task.stateCategory === 'completed',
    },
  ];
  return categories.map((category) => {
    const count = props.tasks.filter(category.matches).length;
    const percentageValue = total ? (count / total) * 100 : 0;
    return {
      ...category,
      count,
      percentage: Math.round(percentageValue),
    };
  });
});
type SettingField = {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'boolean';
  placeholder?: string;
  help?: string;
  secret?: boolean;
};
type SettingSection = { title: string; fields: SettingField[] };

const settingSections: SettingSection[] = [
  {
    title: '仓库与项目',
    fields: [
      { key: 'GITHUB_API_URL', label: 'GitHub API 地址', placeholder: 'https://api.github.com' },
      { key: 'GITHUB_TOKEN', label: 'GitHub Token', placeholder: '留空保持现有 Token', secret: true },
      { key: 'GITHUB_REPOSITORY', label: 'GitHub 仓库', placeholder: 'owner/repository' },
      { key: 'PROJECT_WORK_DIR', label: '项目工作目录', placeholder: '绝对路径' },
      { key: 'GIT_ROOT_DIR', label: 'Git 根目录', placeholder: '默认使用项目工作目录' },
      { key: 'PROJECT_SUBDIR', label: '项目子目录', placeholder: '可选' },
      { key: 'BASE_BRANCH', label: '基准分支', placeholder: 'main' },
    ],
  },
  {
    title: 'AI 与执行策略',
    fields: [
      { key: 'CODEX_BINARY', label: 'Codex 程序路径', placeholder: '留空使用自动发现' },
      { key: 'AI_MODEL', label: 'AI 模型', placeholder: '留空使用默认模型' },
      { key: 'AI_MAX_CONCURRENCY', label: 'AI 最大并发', type: 'number' },
      { key: 'MAX_CONCURRENT_ISSUES', label: 'Issue 最大并发', type: 'number' },
      { key: 'MAX_RETRIES', label: '最大重试次数', type: 'number' },
      { key: 'AI_PHASE_TIMEOUT_MS', label: 'AI 阶段超时（毫秒）', type: 'number' },
    ],
  },
  {
    title: '验收与预览',
    fields: [
      {
        key: 'E2E_UI_ENABLED',
        label: '浏览器验收',
        type: 'boolean',
        help: '关闭后流水线不会执行 Playwright 验收阶段。',
      },
      {
        key: 'PLAYWRIGHT_CHANNEL',
        label: 'Playwright 浏览器',
        placeholder: 'msedge、chromium 或 chrome',
        help: '默认使用本机 Microsoft Edge；修改后需要重启工作台。',
      },
      { key: 'UAT_CONFIG_FILE', label: '验收配置文件', placeholder: 'playwright.config.ts' },
      { key: 'UAT_TIMEOUT_MS', label: '验收超时（毫秒）', type: 'number' },
      {
        key: 'E2E_VISUAL_REVIEW_ENABLED',
        label: '视觉复核',
        type: 'boolean',
        help: '机器验收通过后复核截图；配置在每次 UAT 开始时固化。',
      },
      { key: 'E2E_VISUAL_REVIEW_MAX_IMAGES', label: '视觉复核最大图片数', type: 'number' },
      { key: 'E2E_VISUAL_REVIEW_MODEL', label: '视觉复核模型', placeholder: '留空继承 AI 模型' },
      { key: 'E2E_VISUAL_REVIEW_TIMEOUT_MS', label: '视觉复核超时（毫秒）', type: 'number' },
      { key: 'E2E_BASE_URL', label: '验收基础地址', placeholder: 'http://127.0.0.1:5173' },
      { key: 'PREVIEW_ENABLED', label: '预览服务', type: 'boolean' },
      { key: 'PREVIEW_BACKEND_COMMAND', label: '预览后端命令' },
      { key: 'PREVIEW_FRONTEND_COMMAND', label: '预览前端命令' },
      { key: 'PREVIEW_FRONTEND_DIR', label: '预览前端目录' },
      { key: 'PREVIEW_STARTUP_TIMEOUT_MS', label: '预览启动超时（毫秒）', type: 'number' },
      { key: 'PREVIEW_READINESS_INTERVAL_MS', label: '预览就绪间隔（毫秒）', type: 'number' },
      { key: 'PREVIEW_BACKEND_READY_URL', label: '后端就绪地址', placeholder: '可选' },
      { key: 'PREVIEW_FRONTEND_READY_URL', label: '前端就绪地址', placeholder: '可选' },
    ],
  },
  {
    title: '工作流功能',
    fields: [
      { key: 'REVIEW_ENABLED', label: '审核门', type: 'boolean' },
      { key: 'KNOWLEDGE_ENABLED', label: '知识库', type: 'boolean' },
      { key: 'DISTILL_ENABLED', label: '经验蒸馏', type: 'boolean' },
      { key: 'VERIFY_FIX_LOOP_ENABLED', label: '验证修复循环', type: 'boolean' },
      { key: 'VERIFY_FIX_MAX_ITERATIONS', label: '验证修复最大轮数', type: 'number' },
    ],
  },
];
const settingsValues = ref<Record<string, string>>({});
const initialSettingsValues = ref<Record<string, string>>({});
const settingsLoaded = ref(false);
const settingsLoading = ref(false);
const settingsSaving = ref(false);
const settingsRestartRequired = ref(false);
const settingsError = ref('');
const settingsDirty = computed(() =>
  settingSections.some((section) =>
    section.fields.some(
      (field) => settingsValues.value[field.key] !== initialSettingsValues.value[field.key],
    ),
  ),
);

function updateSetting(key: string, value: string | number | boolean) {
  settingsValues.value[key] = String(value);
}

async function loadSettings() {
  settingsLoading.value = true;
  settingsError.value = '';
  try {
    const response = await fetchSettings();
    settingsValues.value = { ...response.values };
    initialSettingsValues.value = { ...response.values };
    settingsRestartRequired.value = false;
    settingsLoaded.value = true;
  } catch (error) {
    settingsLoaded.value = false;
    settingsError.value = (error as Error).message;
  } finally {
    settingsLoading.value = false;
  }
}

async function saveCurrentSettings() {
  if (!settingsDirty.value || settingsSaving.value) return;
  settingsSaving.value = true;
  settingsError.value = '';
  try {
    const response = await saveSettings(settingsValues.value);
    initialSettingsValues.value = { ...settingsValues.value };
    settingsRestartRequired.value = response.restartRequired;
    message.success('配置已保存，重启工作台后生效。');
  } catch (error) {
    settingsError.value = (error as Error).message;
  } finally {
    settingsSaving.value = false;
  }
}

function resetSettings() {
  settingsValues.value = { ...initialSettingsValues.value };
  settingsError.value = '';
}

watch(
  () => props.page,
  (value) => {
    if (value === 'settings') void loadSettings();
  },
  { immediate: true },
);
</script>

<template>
  <header class="prototype-page-heading">
    <div>
      <div class="prototype-eyebrow">WORKSPACE / {{ page.toUpperCase() }}</div>
      <h1>{{ pageMeta[0] }}</h1>
      <p>{{ pageMeta[1] }}</p>
    </div>
  </header>
  <KnowledgeWorkspace v-if="page === 'knowledge'" />
  <template v-else-if="page === 'analytics'">
    <div class="prototype-analytics-metrics">
      <NCard
        v-for="metric in analytics"
        :key="metric.label"
      >
        <NStatistic
          :label="metric.label"
          :value="metric.value"
        />
      </NCard>
    </div>
    <NCard
      title="任务分布"
      class="prototype-distribution-card"
    >
      <div class="prototype-distribution-layout">
        <TaskDistributionChart
          :items="distribution"
          :total="props.tasks.length"
        />
        <div
          class="prototype-distribution-legend"
          aria-label="任务状态标注"
        >
          <div
            v-for="item in distribution"
            :key="item.key"
            class="prototype-distribution-label"
          >
            <i
              aria-hidden="true"
              :style="{ backgroundColor: item.color }"
            ></i>
            <span>{{ item.label }}</span>
          </div>
        </div>
      </div>
    </NCard>
  </template>
  <NCard
    v-else
    title="运行配置"
    class="prototype-settings-card"
  >
    <template #header-extra>
      <div class="prototype-settings-actions">
        <NButton
          secondary
          :disabled="!settingsDirty || settingsSaving || settingsLoading"
          @click="resetSettings"
        >
          重置
        </NButton>
        <NButton
          type="primary"
          :loading="settingsSaving"
          :disabled="!settingsDirty || settingsLoading"
          @click="saveCurrentSettings"
        >
          保存配置
        </NButton>
      </div>
    </template>
    <NAlert
      v-if="settingsError"
      type="error"
      :show-icon="false"
      class="prototype-settings-alert"
    >
      {{ settingsError }}
    </NAlert>
    <NAlert
      v-if="settingsRestartRequired"
      type="warning"
      :show-icon="false"
      class="prototype-settings-alert"
    >
      配置已持久化，重启工作台后生效；当前进程仍使用启动时的配置。
    </NAlert>
    <NEmpty
      v-if="settingsLoading"
      description="正在读取运行配置"
    />
    <div
      v-else-if="settingsLoaded"
      class="prototype-settings-form"
    >
      <section
        v-for="section in settingSections"
        :key="section.title"
        class="prototype-settings-section"
      >
        <h3>{{ section.title }}</h3>
        <div class="prototype-settings-fields">
          <div
            v-for="field in section.fields"
            :key="field.key"
            class="prototype-settings-field"
          >
            <label :for="`setting-${field.key}`">{{ field.label }}</label>
            <NSwitch
              v-if="field.type === 'boolean'"
              :id="`setting-${field.key}`"
              :value="settingsValues[field.key] === 'true'"
              :aria-label="field.label"
              @update:value="(value) => updateSetting(field.key, value)"
            />
            <NInput
              v-else
              :id="`setting-${field.key}`"
              :value="settingsValues[field.key] ?? ''"
              :type="field.secret ? 'password' : 'text'"
              :placeholder="field.placeholder"
              :aria-label="field.label"
              @update:value="(value) => updateSetting(field.key, value)"
            />
            <small v-if="field.help">{{ field.help }}</small>
          </div>
        </div>
      </section>
    </div>
    <NEmpty
      v-else
      description="暂时无法读取运行配置"
    />
  </NCard>

</template>
