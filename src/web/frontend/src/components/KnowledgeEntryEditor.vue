<script setup lang="ts">
import { ref } from 'vue';
import { NAlert } from 'naive-ui/es/alert';
import { NButton } from 'naive-ui/es/button';
import { NFormItem } from 'naive-ui/es/form';
import { NInput } from 'naive-ui/es/input';
import { NModal } from 'naive-ui/es/modal';
import { useMessage } from 'naive-ui/es/message';
import { createKnowledge, updateKnowledge, type KnowledgeEntry } from '@/api/knowledge';

const props = defineProps<{ entry: KnowledgeEntry | null }>();
const emit = defineEmits<{ saved: [entry: KnowledgeEntry]; close: [] }>();
const message = useMessage();
const saving = ref(false);
const actionError = ref('');
const form = ref(props.entry
  ? { title: props.entry.title, content: props.entry.content, tags: props.entry.tags.join('，') }
  : { title: '', content: '', tags: '' });

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
    const saved = props.entry
      ? await updateKnowledge(props.entry.id, input)
      : await createKnowledge(input);
    emit('saved', saved);
    emit('close');
    message.success(props.entry ? '知识已更新' : '知识已添加');
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    saving.value = false;
  }
}

</script>

<template>
  <NModal
    :show="true"
    @update:show="(show) => { if (!show) emit('close'); }"
    preset="card"
    :title="entry ? '编辑知识' : '新增知识'"
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
      <NButton :disabled="saving" @click="emit('close')">取消</NButton>
      <NButton
        type="primary"
        :loading="saving"
        :disabled="!form.title.trim() || !form.content.trim()"
        @click="saveEntry"
      >保存知识</NButton>
    </div>
  </NModal>
</template>
