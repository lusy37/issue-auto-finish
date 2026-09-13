<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { json, type DemandDraft } from '@/api/mini';
import { useAction } from '@/composables/useAction';
const emit = defineEmits<{ created: [] }>();
const drafts = ref<DemandDraft[]>([]), input = ref('');
const { busy, error, run } = useAction();
const labels = { draft: '待确认', created: '已创建', unknown: '创建结果待核对' };
async function load() { drafts.value = (await json<{drafts: DemandDraft[]}>('/api/drafts')).drafts; }
async function generate() { await json('/api/drafts', 'POST', { input: input.value }); await load(); }
async function save(draft: DemandDraft) { await json(`/api/drafts/${draft.id}`, 'PUT', draft); }
async function create(draft: DemandDraft) { await save(draft); await json(`/api/drafts/${draft.id}/confirm`, 'POST', {}); await load(); }
async function reconcile(draft: DemandDraft) { await json(`/api/drafts/${draft.id}/reconcile`, 'POST', {}); await load(); }
onMounted(() => run(load));
</script>
<template>
  <section class="mini-panel">
    <h2>需求草稿</h2>
    <p>整理完整需求，确认后创建一个 Issue。启动后生成内部任务计划，统一审核、验收和交付。</p>
    <textarea v-model="input" rows="4" maxlength="20000" aria-label="原始需求" placeholder="描述希望完成的需求与验收标准" />
    <button :disabled="busy || !input.trim()" @click="run(generate)">{{ busy ? '处理中…' : '生成草稿' }}</button>
    <p v-if="error" role="alert" class="mini-error">{{ error }}</p>
    <p v-if="!drafts.length && !busy">暂无草稿。</p>
    <article v-for="draft in drafts" :key="draft.id" class="mini-card">
      <p>{{ new Date(draft.createdAt).toLocaleString() }} · {{ labels[draft.status] }}</p>
      <input v-model="draft.title" :disabled="busy || draft.status !== 'draft'" aria-label="草稿标题" />
      <textarea v-model="draft.description" rows="3" :disabled="busy || draft.status !== 'draft'" aria-label="草稿描述" />
      <textarea v-model="draft.acceptanceCriteria" rows="2" :disabled="busy || draft.status !== 'draft'" aria-label="验收标准" />
      <template v-if="draft.status === 'draft'">
        <button :disabled="busy" @click="run(() => save(draft))">保存草稿</button>
        <button :disabled="busy" @click="run(() => create(draft))">确认创建一个 Issue</button>
      </template>
      <button v-if="draft.status === 'unknown'" :disabled="busy" @click="run(() => reconcile(draft))">核对平台创建结果</button>
      <p v-if="draft.error" class="mini-error">{{ draft.error }}</p>
      <template v-if="draft.issueUrl">
        <a :href="draft.issueUrl" target="_blank" rel="noreferrer">查看 Issue #{{ draft.issueIid }}</a>
        <button @click="emit('created')">前往工作台启动</button>
      </template>
    </article>
  </section>
</template>
