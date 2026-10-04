<script setup lang="ts">
import { ref } from 'vue';
import { NAlert } from 'naive-ui/es/alert';
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NFormItem } from 'naive-ui/es/form';
import { NInput } from 'naive-ui/es/input';
import { NModal } from 'naive-ui/es/modal';
import { useMessage } from 'naive-ui/es/message';
import { saveProjectProfile, type ProjectProfile, type KnowledgeEntry } from '@/api/knowledge';

const props = defineProps<{
  profile: ProjectProfile | null;
  projectAnalysis: KnowledgeEntry | null;
}>();
const emit = defineEmits<{ saved: [profile: ProjectProfile]; read: [entry: KnowledgeEntry] }>();
const message = useMessage();
const showProfileEditor = ref(false);
const profileForm = ref<ProjectProfile | null>(null);
const frameworksInput = ref('');
const saving = ref(false);
const actionError = ref('');

function openProfileEditor() {
  if (!props.profile) return;
  profileForm.value = { ...props.profile, frameworks: [...props.profile.frameworks] };
  frameworksInput.value = props.profile.frameworks.join('，');
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
    emit('saved', updated);
    showProfileEditor.value = false;
    message.success('项目资料已保存');
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    saving.value = false;
  }
}

</script>

<template>
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
      <NButton text type="primary" @click="emit('read', projectAnalysis)">查看项目分析</NButton>
    </p>
  </NCard>

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
</template>
