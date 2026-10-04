<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NAlert } from 'naive-ui/es/alert';
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NEmpty } from 'naive-ui/es/empty';
import { NInput } from 'naive-ui/es/input';
import { NModal } from 'naive-ui/es/modal';
import { NPopconfirm } from 'naive-ui/es/popconfirm';
import { useMessage } from 'naive-ui/es/message';
import { NSpin } from 'naive-ui/es/spin';
import { NTag } from 'naive-ui/es/tag';
import { Plus, RefreshCw, Search } from '@lucide/vue';
import {
  knowledgeLabels as labels,
  deleteKnowledge,
  fetchKnowledge,
  fetchDiaries,
  fetchDistillStatus,
  fetchProjectProfile,
  runDistill as requestDistill,
  setRuleEnabled,
  type KnowledgeEntry,
  type DiaryEntry,
  type DistillStatus,
  type ProjectProfile,
} from '@/api/knowledge';

import KnowledgeEntryList from './KnowledgeEntryList.vue';
import KnowledgeEntryEditor from './KnowledgeEntryEditor.vue';
import KnowledgeProjectPanel from './KnowledgeProjectPanel.vue';

const message = useMessage();
const entries = ref<KnowledgeEntry[]>([]);
const diaries = ref<DiaryEntry[]>([]);
const distillStatus = ref<DistillStatus | null>(null);
const profile = ref<ProjectProfile | null>(null);
const loading = ref(false);
const loaded = ref(false);
const saving = ref(false);
const distilling = ref(false);
const loadError = ref('');
const actionError = ref('');
const query = ref('');
const reading = ref<KnowledgeEntry | null>(null);
const editing = ref<KnowledgeEntry | null>(null);
const showEditor = ref(false);
type KnowledgeView = 'project' | 'diaries' | 'memory' | 'rules';
const activeView = ref<KnowledgeView>('project');

const filteredEntries = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return entries.value.filter((entry) =>
    !term || [entry.title, entry.content, labels[entry.type], ...entry.tags]
      .some((value) => value.toLocaleLowerCase().includes(term)),
  );
});

const projectAnalysis = computed(() =>
  entries.value.find((entry) => entry.type === 'project-meta') ?? null,
);

const sectionDefinitions = {
  custom: {
    title: '自定义知识',
    description: '人工维护的项目资料，可编辑和删除。',
    empty: '暂无自定义知识，可添加一条可复用的项目约定。',
  },
  memory: {
    title: 'Memory 记忆',
    description: 'AI 从经验日志中提炼的共性模式，只读查看。',
    empty: '暂无 Memory，先积累经验日志并执行蒸馏。',
  },
  'agent-rule': {
    title: 'Agent Rule 规则',
    description: '由成熟 Memory 提炼的执行规则，可启用或停用。',
    empty: '暂无 Agent Rule，成熟 Memory 蒸馏后会出现在这里。',
  },
} as const;

const customEntries = computed(() =>
  filteredEntries.value.filter((entry) => entry.type === 'custom'),
);
const memoryEntries = computed(() =>
  filteredEntries.value.filter((entry) => entry.type === 'memory'),
);
const ruleEntries = computed(() =>
  filteredEntries.value.filter((entry) => entry.type === 'agent-rule'),
);

const currentEntrySection = computed(() => {
  const key = activeView.value === 'project'
    ? 'custom'
    : activeView.value === 'memory'
      ? 'memory'
      : 'agent-rule';
  return {
    key,
    ...sectionDefinitions[key],
    entries: key === 'custom'
      ? customEntries.value
      : key === 'memory'
        ? memoryEntries.value
        : ruleEntries.value,
  };
});

const navigationTabs = computed(() => [
  {
    key: 'project' as const,
    label: '项目资料',
    description: '项目背景与自定义知识',
    count: entries.value.filter((entry) => entry.type === 'custom').length,
  },
  {
    key: 'diaries' as const,
    label: '经验日志',
    description: 'Issue 执行原始记录',
    count: diaries.value.filter(hasDiaryContent).length,
  },
  {
    key: 'memory' as const,
    label: 'Memory 记忆',
    description: 'AI 提炼的共性模式',
    count: entries.value.filter((entry) => entry.type === 'memory').length,
  },
  {
    key: 'rules' as const,
    label: 'Agent Rule 规则',
    description: '可执行的项目规则',
    count: entries.value.filter((entry) => entry.type === 'agent-rule').length,
  },
]);

const filteredDiaries = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return diaries.value.filter((diary) =>
    hasDiaryContent(diary) &&
    (!term || [
      diary.issueTitle,
      diary.issueIid,
      diary.artifactSummary,
      diary.failure?.error,
      diary.prUrl,
      ...diary.humanInterventions.map((item) => item.detail),
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(term)),
  );
});

const profileMatchesQuery = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  if (!term) return true;
  const profileText = [
    profile.value?.description,
    profile.value?.language,
    ...(profile.value?.frameworks ?? []),
    profile.value?.rules,
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  return profileText.includes(term) || Boolean(
    projectAnalysis.value && projectAnalysis.value.content.toLocaleLowerCase().includes(term),
  );
});

const activeHasSearchResults = computed(() => {
  if (!query.value.trim()) return true;
  if (activeView.value === 'diaries') return filteredDiaries.value.length > 0;
  return currentEntrySection.value.entries.length > 0 ||
    (activeView.value === 'project' && profileMatchesQuery.value);
});

const showCurrentEntrySection = computed(() =>
  !query.value.trim() || currentEntrySection.value.entries.length > 0 ||
  (activeView.value === 'project' && profileMatchesQuery.value),
);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [items, project, status, diaryItems] = await Promise.all([
      fetchKnowledge(),
      fetchProjectProfile(),
      fetchDistillStatus(),
      fetchDiaries(),
    ]);
    entries.value = items;
    profile.value = project;
    distillStatus.value = status;
    diaries.value = diaryItems;
    loaded.value = true;
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

async function executeDistill() {
  if (distilling.value || !distillStatus.value?.enabled) return;
  distilling.value = true;
  actionError.value = '';
  try {
    await requestDistill();
    await load();
    message.success('经验蒸馏完成，已刷新日记、Memory 和规则');
  } catch (error) {
    actionError.value = (error as Error).message;
    await load();
  } finally {
    distilling.value = false;
  }
}

function diaryOutcomeLabel(diary: DiaryEntry): string {
  return diary.outcome === 'completed' ? '已完成' : '执行失败';
}

function diarySummary(diary: DiaryEntry): string {
  return diary.artifactSummary?.trim() || diary.failure?.error.trim() ||
    diary.humanInterventions.map((item) => item.detail.trim()).filter(Boolean).join('；') ||
    (diary.prUrl ? `交付 PR：${diary.prUrl}` : '');
}

function hasDiaryContent(diary: DiaryEntry): boolean {
  return Boolean(diarySummary(diary));
}

function openEditor(entry: KnowledgeEntry | null = null) {
  editing.value = entry;
  actionError.value = '';
  showEditor.value = true;
}

function entrySaved(saved: KnowledgeEntry) {
  const exists = entries.value.some((entry) => entry.id === saved.id);
  entries.value = exists
    ? entries.value.map((entry) => entry.id === saved.id ? saved : entry)
    : [saved, ...entries.value];
  if (reading.value?.id === saved.id) reading.value = saved;
}

async function removeEntry(entry: KnowledgeEntry) {
  if (entry.type !== 'custom' || saving.value) return;
  saving.value = true;
  actionError.value = '';
  try {
    const result = await deleteKnowledge(entry.id);
    if (!result.success) throw new Error('删除失败，知识条目可能已不存在，请刷新后重试');
    entries.value = entries.value.filter((item) => item.id !== entry.id);
    if (reading.value?.id === entry.id) reading.value = null;
    message.success('知识已删除');
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    saving.value = false;
  }
}

async function toggleRule(entry: KnowledgeEntry, enabled: boolean) {
  if (entry.type !== 'agent-rule' || entry.deprecated || saving.value) return;
  saving.value = true;
  actionError.value = '';
  try {
    const saved = await setRuleEnabled(entry.id, enabled);
    entries.value = entries.value.map((item) => item.id === saved.id ? saved : item);
    if (reading.value?.id === saved.id) reading.value = saved;
    message.success(enabled ? '规则已启用' : '规则已停用');
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="knowledge-workspace">
    <div class="knowledge-toolbar">
      <NInput
        v-model:value="query"
        clearable
        placeholder="搜索标题、内容或标签…"
        :input-props="{ 'aria-label': '搜索知识' }"
        class="prototype-draft-search"
      >
        <template #prefix><Search :size="16" /></template>
      </NInput>
      <div class="knowledge-toolbar-actions">
        <NButton :loading="loading" aria-label="刷新知识" @click="load">
          <template #icon><RefreshCw :size="16" /></template>
          刷新
        </NButton>
        <NTag
          v-if="distillStatus"
          size="small"
          :type="distillStatus.enabled ? 'success' : 'warning'"
        >
          蒸馏{{ distillStatus.enabled ? '已启用' : '已关闭' }}
        </NTag>
        <NTag v-if="distillStatus?.undistilledDiaryCount" size="small" type="warning">
          待蒸馏 {{ distillStatus.undistilledDiaryCount }}
        </NTag>
        <NButton
          type="primary"
          :loading="distilling"
          :disabled="!loaded || !distillStatus?.enabled"
          @click="executeDistill"
        >
          立即执行蒸馏
        </NButton>
        <NButton
          v-if="activeView === 'project'"
          type="primary"
          :disabled="!loaded"
          @click="openEditor()"
        >
          <template #icon><Plus :size="16" /></template>
          新增知识
        </NButton>
      </div>
    </div>

    <NAlert v-if="loadError" type="error" class="prototype-alert">
      读取知识失败：{{ loadError }}。请检查知识文件后重试。
    </NAlert>
    <NAlert
      v-if="actionError && !reading && !showEditor"
      type="error"
      class="prototype-alert"
    >
      {{ actionError }}
    </NAlert>
    <NAlert
      v-if="!actionError && distillStatus?.runs[0]?.status === 'failed'"
      type="error"
      class="prototype-alert"
    >
      上次蒸馏失败：{{ distillStatus.runs[0].error || '未返回错误详情' }}
    </NAlert>
    <NCard v-if="loading && !loaded" class="prototype-empty-card">
      <NSpin description="正在读取知识与项目资料" />
    </NCard>
    <template v-else-if="loaded">
      <nav class="knowledge-tabs" role="tablist" aria-label="知识与经验分类">
        <button
          v-for="tab in navigationTabs"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="activeView === tab.key"
          :tabindex="activeView === tab.key ? 0 : -1"
          :class="['knowledge-tab', { 'is-active': activeView === tab.key }]"
          @click="activeView = tab.key"
        >
          <span class="knowledge-tab-heading">
            <strong>{{ tab.label }}</strong>
            <span>{{ tab.count }}</span>
          </span>
          <small>{{ tab.description }}</small>
        </button>
      </nav>

      <div class="knowledge-tab-panel" role="tabpanel">
        <KnowledgeProjectPanel
          v-if="activeView === 'project'"
          :profile="profile"
          :project-analysis="projectAnalysis"
          @saved="profile = $event"
          @read="reading = $event"
        />
        <KnowledgeEntryList
          v-if="activeView !== 'diaries' && showCurrentEntrySection"
          :section="currentEntrySection"
          :saving="saving"
          @create="openEditor()"
          @edit="openEditor"
          @read="reading = $event"
          @toggle="toggleRule"
        />

        <section
          v-if="activeView === 'diaries' && (!query || filteredDiaries.length)"
          class="knowledge-layer-section"
        >
          <div class="knowledge-section-title">
            <div>
              <h2>经验日志 <span>({{ filteredDiaries.length }})</span></h2>
              <p>每个 Issue 完成或失败后自动保存的原始执行记录，不会直接作为规则使用。</p>
            </div>
          </div>
          <NCard v-if="!filteredDiaries.length" class="knowledge-section-empty">
            <NEmpty description="暂无经验日志，完成一次 Issue 后会自动生成" />
          </NCard>
          <div v-else class="knowledge-diary-grid">
            <NCard v-for="diary in filteredDiaries" :key="diary.id" class="knowledge-diary-card">
              <div class="knowledge-diary-heading">
                <strong>#{{ diary.issueIid }} {{ diary.issueTitle }}</strong>
                <NTag size="small" :type="diary.outcome === 'completed' ? 'success' : 'error'">
                  {{ diaryOutcomeLabel(diary) }}
                </NTag>
              </div>
              <p>{{ diarySummary(diary) || '本次执行未生成摘要。' }}</p>
              <small>
                {{ new Date(diary.createdAt).toLocaleString('zh-CN') }} ·
                {{ diary.distilled ? '已参与蒸馏' : '待蒸馏' }}
              </small>
            </NCard>
          </div>
        </section>
      </div>

      <NCard v-if="query && !activeHasSearchResults" class="knowledge-search-empty">
        <NEmpty description="没有匹配的知识或经验记录">
          <template #extra>
            <NButton @click="query = ''">清除搜索</NButton>
          </template>
        </NEmpty>
      </NCard>
    </template>

    <NModal
      :show="Boolean(reading)"
      preset="card"
      :title="reading?.title"
      class="prototype-draft-modal"
      @update:show="(value) => { if (!value) reading = null; }"
    >
      <template v-if="reading">
        <NAlert v-if="actionError" type="error" class="prototype-alert">{{ actionError }}</NAlert>
        <NTag size="small">{{ labels[reading.type] }}</NTag>
        <pre class="prototype-document-reading">{{ reading.content }}</pre>
        <div v-if="reading.type === 'custom'" class="prototype-modal-actions">
          <NPopconfirm
            positive-text="确认删除"
            negative-text="取消"
            @positive-click="removeEntry(reading)"
          >
            <template #trigger>
              <NButton type="error" ghost :disabled="saving">删除</NButton>
            </template>
            确定删除这条知识？此操作不可撤销。
          </NPopconfirm>
          <NButton type="primary" @click="openEditor(reading)">编辑知识</NButton>
        </div>
      </template>
    </NModal>

    <KnowledgeEntryEditor
      v-if="showEditor"
      :entry="editing"
      @saved="entrySaved"
      @close="showEditor = false"
    />
  </div>
</template>
