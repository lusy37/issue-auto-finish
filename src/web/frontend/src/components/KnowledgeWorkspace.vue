<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NAlert } from 'naive-ui/es/alert';
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NEmpty } from 'naive-ui/es/empty';
import { NFormItem } from 'naive-ui/es/form';
import { NInput } from 'naive-ui/es/input';
import { NModal } from 'naive-ui/es/modal';
import { NPopconfirm } from 'naive-ui/es/popconfirm';
import { useMessage } from 'naive-ui/es/message';
import { NSpin } from 'naive-ui/es/spin';
import { NSwitch } from 'naive-ui/es/switch';
import { NTag } from 'naive-ui/es/tag';
import { ArrowUpRight, BookOpen, Plus, RefreshCw, Search } from '@lucide/vue';
import {
  createKnowledge,
  deleteKnowledge,
  fetchKnowledge,
  fetchDiaries,
  fetchDistillStatus,
  fetchProjectProfile,
  runDistill as requestDistill,
  saveProjectProfile,
  setRuleEnabled,
  updateKnowledge,
  type KnowledgeEntry,
  type KnowledgeEntryType,
  type DiaryEntry,
  type DistillStatus,
  type ProjectProfile,
} from '@/api/knowledge';

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
const showProfileEditor = ref(false);
const form = ref({ title: '', content: '', tags: '' });
const profileForm = ref<ProjectProfile | null>(null);
const frameworksInput = ref('');
type KnowledgeView = 'project' | 'diaries' | 'memory' | 'rules';
const activeView = ref<KnowledgeView>('project');

const labels: Record<KnowledgeEntryType, string> = {
  'project-meta': '项目分析',
  custom: '自定义知识',
  diary: '执行日记',
  memory: '经验记忆',
  'agent-rule': 'Agent 规则',
};

function entryContent(entry: KnowledgeEntry): string {
  if (entry.type !== 'memory' && entry.type !== 'agent-rule') return entry.content;
  try {
    const parsed: unknown = JSON.parse(entry.content);
    if (
      parsed && typeof parsed === 'object' && 'content' in parsed &&
      typeof parsed.content === 'string'
    ) {
      return parsed.content;
    }
  } catch {
    return entry.content;
  }
  return entry.content;
}

function deprecated(entry: KnowledgeEntry): boolean {
  if (entry.type !== 'agent-rule') return false;
  try {
    const parsed: unknown = JSON.parse(entry.content);
    return !!(parsed && typeof parsed === 'object' && 'deprecated' in parsed && parsed.deprecated);
  } catch {
    return false;
  }
}

function memoryDetails(entry: KnowledgeEntry): {
  confidence: number;
  evidence: string[];
  promotedToRule: boolean;
} {
  if (entry.type !== 'memory') {
    return { confidence: 0, evidence: [], promotedToRule: false };
  }
  try {
    const parsed = JSON.parse(entry.content) as {
      confidence?: number;
      evidence?: string[];
      promotedToRule?: boolean;
    };
    return {
      confidence: parsed.confidence ?? 0,
      evidence: parsed.evidence ?? [],
      promotedToRule: parsed.promotedToRule === true,
    };
  } catch {
    return { confidence: 0, evidence: [], promotedToRule: false };
  }
}

const filteredEntries = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return entries.value.filter((entry) =>
    !term || [entry.title, entryContent(entry), labels[entry.type], ...entry.tags]
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
    projectAnalysis.value && entryContent(projectAnalysis.value).toLocaleLowerCase().includes(term),
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
  form.value = entry
    ? { title: entry.title, content: entry.content, tags: entry.tags.join('，') }
    : { title: '', content: '', tags: '' };
  actionError.value = '';
  showEditor.value = true;
}

async function saveEntry() {
  if (saving.value || !form.value.title.trim() || !form.value.content.trim()) return;
  saving.value = true;
  actionError.value = '';
  const input = {
    title: form.value.title.trim(),
    content: form.value.content.trim(),
    tags: [...new Set(form.value.tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))],
  };
  try {
    const saved = editing.value
      ? await updateKnowledge(editing.value.id, input)
      : await createKnowledge(input);
    entries.value = editing.value
      ? entries.value.map((entry) => entry.id === saved.id ? saved : entry)
      : [saved, ...entries.value];
    if (reading.value?.id === saved.id) reading.value = saved;
    showEditor.value = false;
    message.success(editing.value ? '知识已更新' : '知识已添加');
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    saving.value = false;
  }
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
  if (entry.type !== 'agent-rule' || deprecated(entry) || saving.value) return;
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

function openProfileEditor() {
  if (!profile.value) return;
  profileForm.value = { ...profile.value, frameworks: [...profile.value.frameworks] };
  frameworksInput.value = profile.value.frameworks.join('，');
  actionError.value = '';
  showProfileEditor.value = true;
}

async function saveProfile() {
  if (!profileForm.value || saving.value) return;
  saving.value = true;
  actionError.value = '';
  try {
    const updated = await saveProjectProfile({
      ...profileForm.value,
      frameworks: [
        ...new Set(
          frameworksInput.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean),
        ),
      ],
    });
    profile.value = updated;
    showProfileEditor.value = false;
    message.success('项目资料已保存');
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
      v-if="actionError && !reading && !showEditor && !showProfileEditor"
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
        <template v-if="activeView === 'project'">
          <NCard class="knowledge-profile-card" title="项目资料">
            <template #header-extra>
              <NButton text type="primary" @click="openProfileEditor">编辑资料</NButton>
            </template>
            <p>{{ profile?.description || '尚未填写项目简介，可编辑项目资料，让后续任务了解项目背景。' }}</p>
            <div class="knowledge-profile-meta">
              <span>主要语言：{{ profile?.language || '未设置' }}</span>
              <span>技术框架：{{ profile?.frameworks.join('、') || '未设置' }}</span>
            </div>
            <p v-if="profile?.rules" class="knowledge-profile-rules">开发约定：{{ profile.rules }}</p>
            <p v-if="projectAnalysis" class="knowledge-profile-analysis">
              已生成项目分析，作为项目资料的补充参考。
              <NButton text type="primary" @click="reading = projectAnalysis">查看项目分析</NButton>
            </p>
          </NCard>
        </template>

        <section
          v-if="activeView !== 'diaries' && showCurrentEntrySection"
          class="knowledge-layer-section"
        >
          <div class="knowledge-section-title">
            <div>
              <h2>
                {{ currentEntrySection.title }}
                <span>({{ currentEntrySection.entries.length }})</span>
              </h2>
              <p>{{ currentEntrySection.description }}</p>
            </div>
          </div>
          <NCard v-if="!currentEntrySection.entries.length" class="knowledge-section-empty">
            <NEmpty :description="currentEntrySection.empty">
              <template #extra>
                <NButton
                  v-if="currentEntrySection.key === 'custom'"
                  type="primary"
                  @click="openEditor()"
                >
                  新增知识
                </NButton>
              </template>
            </NEmpty>
          </NCard>
          <div v-else class="prototype-document-grid">
            <NCard
              v-for="entry in currentEntrySection.entries"
              :key="entry.id"
              class="prototype-document-card"
            >
              <BookOpen :size="25" class="prototype-document-icon" />
              <h2>{{ entry.title }}</h2>
              <p>{{ entryContent(entry).slice(0, 110) || '暂无正文' }}</p>
              <div class="knowledge-card-tags">
                <NTag size="small" :bordered="false">{{ labels[entry.type] }}</NTag>
                <template v-if="entry.type === 'memory'">
                  <NTag size="small" :bordered="false">
                    证据 {{ memoryDetails(entry).evidence.length }} 条
                  </NTag>
                  <NTag size="small" :bordered="false">
                    置信度 {{ Math.round(memoryDetails(entry).confidence * 100) }}%
                  </NTag>
                </template>
                <NTag v-if="deprecated(entry)" size="small" type="warning">已退役</NTag>
                <NTag
                  v-for="tag in entry.tags
                    .filter((item) => entry.type !== 'agent-rule' || item !== 'enabled')
                    .slice(0, 2)"
                  :key="tag"
                  size="small"
                  :bordered="false"
                >{{ tag }}</NTag>
              </div>
              <template #action>
                <div class="knowledge-card-actions">
                  <NButton text type="primary" @click="reading = entry">
                    阅读内容 <ArrowUpRight :size="15" />
                  </NButton>
                  <NSwitch
                    v-if="entry.type === 'agent-rule'"
                    :value="entry.tags.includes('enabled')"
                    :disabled="saving || deprecated(entry)"
                    :aria-label="`${entry.tags.includes('enabled') ? '停用' : '启用'}规则 ${entry.title}`"
                    @update:value="(enabled) => toggleRule(entry, enabled)"
                  />
                  <NButton v-if="entry.type === 'custom'" text @click="openEditor(entry)">
                    编辑
                  </NButton>
                </div>
              </template>
            </NCard>
          </div>
        </section>

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
        <pre class="prototype-document-reading">{{ entryContent(reading) }}</pre>
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

    <NModal
      v-model:show="showEditor"
      preset="card"
      :title="editing ? '编辑知识' : '新增知识'"
      class="prototype-draft-modal"
    >
      <NAlert v-if="actionError" type="error" class="prototype-alert">{{ actionError }}</NAlert>
      <NFormItem label="标题" required>
        <NInput
          v-model:value="form.title"
          :input-props="{ 'aria-label': '知识标题' }"
          maxlength="200"
          placeholder="例如：提交前必须运行的检查"
        />
      </NFormItem>
      <NFormItem label="正文" required>
        <NInput
          v-model:value="form.content"
          type="textarea"
          :input-props="{ 'aria-label': '知识正文' }"
          :autosize="{ minRows: 6, maxRows: 16 }"
          maxlength="100000"
          placeholder="记录可复用的规则或经验"
        />
      </NFormItem>
      <NFormItem label="标签（逗号分隔）">
        <NInput v-model:value="form.tags" placeholder="例如：测试，前端" />
      </NFormItem>
      <div class="prototype-modal-actions">
        <NButton :disabled="saving" @click="showEditor = false">取消</NButton>
        <NButton
          type="primary"
          :loading="saving"
          :disabled="!form.title.trim() || !form.content.trim()"
          @click="saveEntry"
        >保存知识</NButton>
      </div>
    </NModal>

    <NModal
      v-model:show="showProfileEditor"
      preset="card"
      title="编辑项目资料"
      class="prototype-draft-modal"
    >
      <template v-if="profileForm">
        <NAlert v-if="actionError" type="error" class="prototype-alert">{{ actionError }}</NAlert>
        <NFormItem label="项目简介">
          <NInput
            v-model:value="profileForm.description"
            type="textarea"
            :input-props="{ 'aria-label': '项目简介' }"
            :autosize="{ minRows: 3, maxRows: 6 }"
            maxlength="10000"
            placeholder="介绍项目目标与业务背景"
          />
        </NFormItem>
        <NFormItem label="主要语言">
          <NInput
            v-model:value="profileForm.language"
            :input-props="{ 'aria-label': '主要语言' }"
            maxlength="10000"
            placeholder="例如：TypeScript"
          />
        </NFormItem>
        <NFormItem label="技术框架（逗号分隔）">
          <NInput
            v-model:value="frameworksInput"
            :input-props="{ 'aria-label': '技术框架' }"
            placeholder="例如：Vue，Express"
          />
        </NFormItem>
        <NFormItem label="安装命令">
          <NInput
            v-model:value="profileForm.installCommand"
            :input-props="{ 'aria-label': '安装命令' }"
            maxlength="10000"
            placeholder="例如：npm install"
          />
        </NFormItem>
        <NFormItem label="Lint 命令">
          <NInput
            v-model:value="profileForm.lintCommand"
            :input-props="{ 'aria-label': 'Lint 命令' }"
            maxlength="10000"
            placeholder="例如：npm run lint"
          />
        </NFormItem>
        <NFormItem label="构建命令">
          <NInput
            v-model:value="profileForm.buildCommand"
            :input-props="{ 'aria-label': '构建命令' }"
            maxlength="10000"
            placeholder="例如：npm run build"
          />
        </NFormItem>
        <NFormItem label="测试命令">
          <NInput
            v-model:value="profileForm.testCommand"
            :input-props="{ 'aria-label': '测试命令' }"
            maxlength="10000"
            placeholder="例如：npm test"
          />
        </NFormItem>
        <NFormItem label="开发约定（每行一条）">
          <NInput
            v-model:value="profileForm.rules"
            type="textarea"
            :input-props="{ 'aria-label': '开发约定' }"
            :autosize="{ minRows: 4, maxRows: 10 }"
            maxlength="10000"
            placeholder="每行写一条开发约定"
          />
        </NFormItem>
        <div class="prototype-modal-actions">
          <NButton :disabled="saving" @click="showProfileEditor = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="saveProfile">保存资料</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>
