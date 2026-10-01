<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert } from 'naive-ui/es/alert';
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NEmpty } from 'naive-ui/es/empty';
import { NFormItem } from 'naive-ui/es/form';
import { NInput } from 'naive-ui/es/input';
import { useMessage } from 'naive-ui/es/message';
import { NModal } from 'naive-ui/es/modal';
import { NStatistic } from 'naive-ui/es/statistic';
import { NSwitch } from 'naive-ui/es/switch';
import { NTag } from 'naive-ui/es/tag';
import {
  ArrowUpRight,
  FileText,
  Plus,
  Search,
  Trash2,
} from '@lucide/vue';
import { fetchSettings, saveSettings } from '@/api/client';
import { json, type DemandDraft } from '@/api/mini';
import type { ExecutableTask, SystemStatus } from '@/types';
import { useAction } from '@/composables/useAction';
import TaskDistributionChart from '@/components/TaskDistributionChart.vue';
import KnowledgeWorkspace from '@/components/KnowledgeWorkspace.vue';

const props = defineProps<{
  page: 'drafts' | 'knowledge' | 'analytics' | 'settings';
  tasks: ExecutableTask[];
  systemStatus: SystemStatus | null;
}>();
const emit = defineEmits<{ create: []; refresh: [] }>();
const message = useMessage();
const { busy, error, run } = useAction();
const drafts = ref<DemandDraft[]>([]);
const draftQuery = ref('');
const showCreate = ref(false);
const input = ref('');
const pageMeta = computed(
  () =>
    ({
      drafts: ['需求草稿', '先把想法整理清楚，再交给 AI 实施。'],
      knowledge: ['知识与经验', '项目约定与交付经验，为下一次实现提供依据。'],
      analytics: ['任务统计', '回顾任务分布，找到需要关注的执行环节。'],
      settings: ['工作台设置', '调整阅读与显示偏好，让工作台适合你的节奏。'],
    })[props.page],
);
const filteredDrafts = computed(() =>
  drafts.value.filter((draft) =>
    `${draft.title} ${draft.description}`
      .toLowerCase()
      .includes(draftQuery.value.trim().toLowerCase()),
  ),
);
const analytics = computed(() => [
  { label: '总任务', value: props.tasks.length },
  {
    label: '已交付',
    value: props.tasks.filter((task) => task.stateCategory === 'completed').length,
  },
  { label: '待审核', value: props.tasks.filter((task) => task.stateCategory === 'blocked').length },
  { label: '需处理', value: props.tasks.filter((task) => task.stateCategory === 'failed').length },
]);
const distribution = computed(() => {
  const total = props.tasks.length;
  const categories = [
    { label: '执行中', key: 'active', color: '#347abe' },
    { label: '待审核', key: 'blocked', color: '#c78b22' },
    { label: '失败待处理', key: 'failed', color: '#bd5a5a' },
    { label: '已完成', key: 'completed', color: '#168875' },
  ];
  return categories.map((category) => {
    const count = props.tasks.filter((task) => task.stateCategory === category.key).length;
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

async function loadDrafts() {
  drafts.value = (await json<{ drafts: DemandDraft[] }>('/api/drafts')).drafts;
}
async function createDraft() {
  if (!input.value.trim()) return;
  await json('/api/drafts', 'POST', { input: input.value.trim() });
  input.value = '';
  showCreate.value = false;
  await loadDrafts();
  message.success('草稿已生成。');
}
async function removeDraft(draft: DemandDraft) {
  await json(`/api/drafts/${draft.id}`, 'PUT', { ...draft, status: 'draft' });
  drafts.value = drafts.value.filter((item) => item.id !== draft.id);
  message.success('草稿已移除。');
}
watch(
  () => props.page,
  (value) => {
    if (value === 'drafts') run(loadDrafts);
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
    <NButton
      v-if="page === 'drafts'"
      type="primary"
      @click="showCreate = true"
    >
      <template #icon><Plus :size="17" /></template>
      新建需求
    </NButton>
  </header>

  <template v-if="page === 'drafts'">
    <NInput
      v-if="drafts.length"
      v-model:value="draftQuery"
      placeholder="搜索草稿…"
      clearable
      class="prototype-draft-search"
      aria-label="搜索草稿"
    >
      <template #prefix><Search :size="16" /></template>
    </NInput>
    <NAlert
      v-if="error"
      type="error"
      class="prototype-alert"
    >
      {{ error }}
    </NAlert>
    <NCard
      v-if="!filteredDrafts.length"
      class="prototype-empty-card"
    >
      <NEmpty :description="draftQuery ? '没有匹配的草稿' : '把下一个想法写在这里'">
        <template #extra>
          <NButton
            v-if="draftQuery"
            @click="draftQuery = ''"
          >
            清除搜索
          </NButton>
          <NButton
            v-else
            type="primary"
            @click="showCreate = true"
          >
            创建第一份草稿
          </NButton>
        </template>
      </NEmpty>
    </NCard>
    <div
      v-else
      class="prototype-document-grid"
    >
      <NCard
        v-for="draft in filteredDrafts"
        :key="draft.id"
        class="prototype-document-card"
      >
        <FileText
          :size="23"
          class="prototype-document-icon"
        />
        <h2>{{ draft.title }}</h2>
        <p>{{ draft.description || '尚未填写背景说明。' }}</p>
        <NTag
          size="small"
          :bordered="false"
        >
          草稿 · {{ new Date(draft.createdAt).toLocaleDateString('zh-CN') }}
        </NTag>
        <template #action>
          <div class="prototype-card-actions">
            <NButton
              text
              type="primary"
              @click="emit('create')"
            >
              查看详情
              <ArrowUpRight :size="15" />
            </NButton>
            <NButton
              quaternary
              circle
              :aria-label="'删除草稿 ' + draft.title"
              :loading="busy"
              @click="run(() => removeDraft(draft))"
            >
              <template #icon><Trash2 :size="16" /></template>
            </NButton>
          </div>
        </template>
      </NCard>
    </div>
  </template>
  <KnowledgeWorkspace v-else-if="page === 'knowledge'" />
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

  <NModal
    v-model:show="showCreate"
    preset="card"
    title="新建需求草稿"
    class="prototype-draft-modal"
  >
    <NFormItem
      label="原始需求"
      required
    >
      <NInput
        v-model:value="input"
        type="textarea"
        :autosize="{ minRows: 5, maxRows: 12 }"
        placeholder="描述希望完成的需求与验收标准"
      />
    </NFormItem>
    <div class="prototype-modal-actions">
      <NButton @click="showCreate = false">取消</NButton>
      <NButton
        type="primary"
        :loading="busy"
        :disabled="!input.trim()"
        @click="run(createDraft)"
      >
        生成草稿
      </NButton>
    </div>
  </NModal>
</template>
