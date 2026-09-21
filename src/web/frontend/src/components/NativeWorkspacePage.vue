<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NEmpty, NFormItem, NInput, NModal, NStatistic, NSwitch, NTable, NTag, useMessage } from 'naive-ui';
import { ArrowUpRight, BookOpen, FileText, GitBranch, Moon, Plus, Search, ShieldCheck, Terminal, Trash2 } from '@lucide/vue';
import { json, type DemandDraft } from '@/api/mini';
import type { ExecutableTask, SystemStatus } from '@/types';
import { useAction } from '@/composables/useAction';

const props = defineProps<{ page: 'drafts' | 'knowledge' | 'analytics' | 'settings'; tasks: ExecutableTask[]; systemStatus: SystemStatus | null }>();
const emit = defineEmits<{ create: []; refresh: [] }>();
const message = useMessage();
const { busy, error, run } = useAction();
const drafts = ref<DemandDraft[]>([]);
const draftQuery = ref('');
const showCreate = ref(false);
const input = ref('');
const reading = ref<{ title: string; tag: string; content: string } | null>(null);
const docs = [
  { title: '项目开发约定', tag: '项目规则', icon: BookOpen, summary: '统一开发边界、阶段职责与计划审核规则。', content: '项目采用 Vue、TypeScript、Express 和本地 JSON。核心流程包含计划、审核、构建、验证、验收和交付。' },
  { title: '任务依赖与合并规则', tag: '执行经验', icon: GitBranch, summary: '前置任务合并后，再启动依赖它的下游任务。', content: '同一个 Issue 的构建阶段可以拆分为多个任务，服务端 DAG 是依赖关系的唯一来源。' },
  { title: '浏览器验收的有效证据', tag: '验收规则', icon: ShieldCheck, summary: '以本轮退出码和报告判定结果，明确关联候选提交。', content: '浏览器验收必须关联本轮运行编号、候选提交和有效报告。' },
];
const pageMeta = computed(() => ({
  drafts: ['需求草稿', '先把想法整理清楚，再交给 AI 实施。'],
  knowledge: ['知识与经验', '项目约定与交付经验，为下一次实现提供依据。'],
  analytics: ['任务统计', '回顾任务分布，找到需要关注的执行环节。'],
  settings: ['工作台设置', '调整阅读与显示偏好，让工作台适合你的节奏。'],
}[props.page]));
const filteredDrafts = computed(() => drafts.value.filter(draft => `${draft.title} ${draft.description}`.toLowerCase().includes(draftQuery.value.trim().toLowerCase())));
const analytics = computed(() => [
  { label: '总任务', value: props.tasks.length },
  { label: '已交付', value: props.tasks.filter(task => task.stateCategory === 'completed').length },
  { label: '待审核', value: props.tasks.filter(task => task.stateCategory === 'blocked').length },
  { label: '需处理', value: props.tasks.filter(task => task.stateCategory === 'failed').length },
]);

async function loadDrafts() { drafts.value = (await json<{ drafts: DemandDraft[] }>('/api/drafts')).drafts; }
async function createDraft() { if (!input.value.trim()) return; await json('/api/drafts', 'POST', { input: input.value.trim() }); input.value = ''; showCreate.value = false; await loadDrafts(); message.success('草稿已生成。'); }
async function removeDraft(draft: DemandDraft) { await json(`/api/drafts/${draft.id}`, 'PUT', { ...draft, status: 'draft' }); drafts.value = drafts.value.filter(item => item.id !== draft.id); message.success('草稿已移除。'); }
watch(() => props.page, value => { if (value === 'drafts') run(loadDrafts); }, { immediate: true });
</script>

<template>
  <header class="prototype-page-heading">
    <div><div class="prototype-eyebrow">WORKSPACE / {{ page.toUpperCase() }}</div><h1>{{ pageMeta[0] }}</h1><p>{{ pageMeta[1] }}</p></div>
    <NButton v-if="page === 'drafts'" type="primary" @click="showCreate = true"><template #icon><Plus :size="17" /></template>新建需求</NButton>
  </header>

  <template v-if="page === 'drafts'">
    <NInput v-if="drafts.length" v-model:value="draftQuery" placeholder="搜索草稿…" clearable class="prototype-draft-search" aria-label="搜索草稿"><template #prefix><Search :size="16" /></template></NInput>
    <NAlert v-if="error" type="error" class="prototype-alert">{{ error }}</NAlert>
    <NCard v-if="!filteredDrafts.length" class="prototype-empty-card"><NEmpty :description="draftQuery ? '没有匹配的草稿' : '把下一个想法写在这里'"><template #extra><NButton v-if="draftQuery" @click="draftQuery = ''">清除搜索</NButton><NButton v-else type="primary" @click="showCreate = true">创建第一份草稿</NButton></template></NEmpty></NCard>
    <div v-else class="prototype-document-grid"><NCard v-for="draft in filteredDrafts" :key="draft.id" class="prototype-document-card"><FileText :size="23" class="prototype-document-icon" /><h2>{{ draft.title }}</h2><p>{{ draft.description || '尚未填写背景说明。' }}</p><NTag size="small" :bordered="false">草稿 · {{ new Date(draft.createdAt).toLocaleDateString('zh-CN') }}</NTag><template #action><div class="prototype-card-actions"><NButton text type="primary" @click="emit('create')">查看详情<ArrowUpRight :size="15" /></NButton><NButton quaternary circle :aria-label="'删除草稿 ' + draft.title" :loading="busy" @click="run(() => removeDraft(draft))"><template #icon><Trash2 :size="16" /></template></NButton></div></template></NCard></div>
  </template>
  <div v-else-if="page === 'knowledge'" class="prototype-document-grid"><NCard v-for="doc in docs" :key="doc.title" class="prototype-document-card"><component :is="doc.icon" :size="25" class="prototype-document-icon" /><h2>{{ doc.title }}</h2><p>{{ doc.summary }}</p><NTag size="small" :bordered="false">{{ doc.tag }}</NTag><template #action><NButton text type="primary" @click="reading = doc">阅读内容<ArrowUpRight :size="15" /></NButton></template></NCard></div>
  <template v-else-if="page === 'analytics'"><div class="prototype-analytics-metrics"><NCard v-for="metric in analytics" :key="metric.label"><NStatistic :label="metric.label" :value="metric.value" /></NCard></div><NCard title="任务分布"><NTable :bordered="false" :single-line="false"><thead><tr><th>状态</th><th>数量</th><th>占比</th></tr></thead><tbody><tr v-for="item in [{ label: '执行中', key: 'active' }, { label: '待审核', key: 'blocked' }, { label: '失败待处理', key: 'failed' }, { label: '已完成', key: 'completed' }]" :key="item.key"><td>{{ item.label }}</td><td>{{ props.tasks.filter(task => task.stateCategory === item.key).length }}</td><td>{{ props.tasks.length ? Math.round(props.tasks.filter(task => task.stateCategory === item.key).length / props.tasks.length * 100) : 0 }}%</td></tr></tbody></NTable></NCard></template>
  <NCard v-else title="显示与阅读" class="prototype-settings-card"><div class="prototype-settings-row"><div><h3><Moon :size="17" />深色主题</h3><p>统一切换工作台和详情页的显示主题。</p></div><NSwitch disabled aria-label="深色主题" /></div><div class="prototype-settings-row"><div><h3><Terminal :size="17" />实时数据</h3><p>数据来自当前 LangGraph Native 服务端。</p></div><NTag type="success" :bordered="false">已连接</NTag></div><NAlert type="info" :show-icon="false">工作台配置由服务端管理，页面只读展示当前运行状态。</NAlert></NCard>

  <NModal v-model:show="showCreate" preset="card" title="新建需求草稿" class="prototype-draft-modal"><NFormItem label="原始需求" required><NInput v-model:value="input" type="textarea" :autosize="{ minRows: 5, maxRows: 12 }" placeholder="描述希望完成的需求与验收标准" /></NFormItem><div class="prototype-modal-actions"><NButton @click="showCreate = false">取消</NButton><NButton type="primary" :loading="busy" :disabled="!input.trim()" @click="run(createDraft)">生成草稿</NButton></div></NModal>
  <NModal v-if="reading" :show="Boolean(reading)" preset="card" :title="reading.title" class="prototype-draft-modal" @update:show="value => { if (!value) reading = null; }"><NTag size="small">{{ reading.tag }}</NTag><p class="prototype-document-reading">{{ reading.content }}</p></NModal>
</template>
