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
  fetchProjectProfile,
  saveProjectProfile,
  setRuleEnabled,
  updateKnowledge,
  type KnowledgeEntry,
  type KnowledgeEntryType,
  type ProjectProfile,
} from '@/api/knowledge';

const message = useMessage();
const entries = ref<KnowledgeEntry[]>([]);
const profile = ref<ProjectProfile | null>(null);
const loading = ref(false);
const loaded = ref(false);
const saving = ref(false);
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

const filteredEntries = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return entries.value.filter((entry) =>
    !term || [entry.title, entryContent(entry), labels[entry.type], ...entry.tags]
      .some((value) => value.toLocaleLowerCase().includes(term)),
  );
});

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [items, project] = await Promise.all([fetchKnowledge(), fetchProjectProfile()]);
    entries.value = items;
    profile.value = project;
    loaded.value = true;
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
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
        <NButton type="primary" :disabled="!loaded" @click="openEditor()">
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
    <NCard v-if="loading && !loaded" class="prototype-empty-card">
      <NSpin description="正在读取知识与项目资料" />
    </NCard>
    <template v-else-if="loaded">
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
      </NCard>

      <div class="knowledge-section-title">
        <h2>知识条目 <span>({{ filteredEntries.length }})</span></h2>
        <span>自定义知识可编辑；执行经验与规则由工作流维护</span>
      </div>
      <NCard v-if="!filteredEntries.length" class="prototype-empty-card">
        <NEmpty :description="query ? '没有匹配的知识，试试其他关键词' : '暂无知识条目，添加一条项目知识开始积累经验'">
          <template #extra>
            <NButton v-if="query" @click="query = ''">清除搜索</NButton>
            <NButton v-else type="primary" @click="openEditor()">新增知识</NButton>
          </template>
        </NEmpty>
      </NCard>
      <div v-else class="prototype-document-grid">
        <NCard v-for="entry in filteredEntries" :key="entry.id" class="prototype-document-card">
          <BookOpen :size="25" class="prototype-document-icon" />
          <h2>{{ entry.title }}</h2>
          <p>{{ entryContent(entry).slice(0, 110) || '暂无正文' }}</p>
          <div class="knowledge-card-tags">
            <NTag size="small" :bordered="false">{{ labels[entry.type] }}</NTag>
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
              <NButton v-if="entry.type === 'custom'" text @click="openEditor(entry)">编辑</NButton>
            </div>
          </template>
        </NCard>
      </div>
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
