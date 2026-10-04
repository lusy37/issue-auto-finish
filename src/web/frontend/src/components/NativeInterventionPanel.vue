<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAlert } from 'naive-ui/es/alert';
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NInput } from 'naive-ui/es/input';
import type { IssueRecord } from '@/types';
import { getIssueIid } from '@/types';
import * as api from '@/api/client';

const props = defineProps<{ issue: IssueRecord; maxRetries?: number }>();
const emit = defineEmits<{ refresh: []; logs: []; verification: [] }>();
const busy = ref(false);
const error = ref('');
const feedback = ref('');
const feedbackSaved = ref(false);
const failed = computed(() =>
  props.issue.lifecycle.kind === 'failed' ? props.issue.lifecycle : null,
);
const phase = computed(() =>
  'phase' in props.issue.lifecycle ? props.issue.lifecycle.phase : undefined,
);
const retryUsed = computed(() => props.issue.run.retryUsed[phase.value ?? 'setup'] ?? 0);
const exhausted = computed(() => (
  failed.value
  && props.maxRetries !== undefined
  && retryUsed.value >= props.maxRetries
));
const visible = computed(() => failed.value || props.issue.lifecycle.kind === 'paused');

async function act(action: 'retry' | 'continue' | 'restart' | 'replan') {
  if (busy.value) return;
  if (action === 'replan' && !feedback.value.trim()) {
    error.value = '请填写处理说明，帮助 AI 调整下一轮计划。';
    return;
  }
  if ((action === 'restart' || action === 'replan') && !window.confirm(
    '完整重做将重新生成计划、重做构建和验收，并开启新一轮重试与修复预算。确认继续？',
  )) return;
  busy.value = true;
  error.value = '';
  const number = getIssueIid(props.issue);
  try {
    if (action === 'replan') {
      // 先读取已有补充信息，保留各字段；保存失败时不得触发重做。
      const supplement = await api.fetchSupplement(number) ?? {
        requirements: '',
        acceptanceCriteria: '',
        scope: '',
        constraints: '',
        references: '',
        freeText: '',
      };
      const note = `人工介入说明：\n${feedback.value.trim()}`;
      await api.saveSupplement(number, {
        ...supplement,
        freeText: supplement.freeText.includes(note)
          ? supplement.freeText
          : [supplement.freeText, note].filter(Boolean).join('\n\n'),
      });
      feedbackSaved.value = true;
    }
    if (action === 'retry') await api.retryIssue(number);
    else if (action === 'continue') await api.continueIssue(number);
    else await api.restartIssue(number);
    feedback.value = '';
    feedbackSaved.value = false;
    emit('refresh');
  } catch (cause) {
    const savedMessage = feedbackSaved.value ? '处理说明已保存，恢复执行失败；可再次提交。' : '';
    error.value = savedMessage + (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <NCard v-if="visible" title="人工介入" class="native-intervention-panel" :aria-busy="busy">
    <div class="native-intervention-content">
      <NAlert
        :type="failed ? 'warning' : 'info'"
        :title="failed
          ? (exhausted ? '自动重试次数已达上限，需要人工处理' : '执行失败，需要处理')
          : '任务已暂停，可以人工处理后继续'"
      >
        <p v-if="failed" class="native-intervention-error">{{ failed.error.message }}</p>
        <p>
          当前阶段：{{ phase ?? '准备或交付' }}。
          <template v-if="failed">
            已用自动重试 {{ retryUsed }}
            <template v-if="maxRetries !== undefined"> / {{ maxRetries }}</template> 次；
            已用集成修复 {{ issue.run.repairRounds }} 轮。
            {{ failed.retry === 'manual' || exhausted ? '自动执行已停止。' : '系统仍可能自动重试。' }}
          </template>
        </p>
      </NAlert>
      <p>修复环境或代码后可恢复当前执行。手动重试保留已有计划、执行进度和已用额度；若需调整方案或重新获得自动修复额度，请选择完整重做。</p>
      <div class="native-intervention-actions">
        <NButton
          v-if="failed"
          type="primary"
          :loading="busy"
          :disabled="busy"
          @click="act('retry')"
        >手动重试当前阶段</NButton>
        <NButton
          v-else
          type="primary"
          :loading="busy"
          :disabled="busy"
          @click="act('continue')"
        >继续执行</NButton>
        <NButton :disabled="busy" @click="emit('logs')">查看失败日志</NButton>
        <NButton
          v-if="phase === 'verify' || phase === 'uat'"
          :disabled="busy"
          @click="emit('verification')"
        >查看验收结果</NButton>
        <NButton :disabled="busy" @click="act('restart')">完整重做</NButton>
      </div>
      <label :for="`intervention-feedback-${getIssueIid(issue)}`">处理说明</label>
      <NInput
        v-model:value="feedback"
        type="textarea"
        :input-props="{ id: `intervention-feedback-${getIssueIid(issue)}` }"
        :disabled="busy"
        :autosize="{ minRows: 3, maxRows: 8 }"
        placeholder="补充失败原因、已做的修复，或下一轮需要遵守的要求"
      />
      <p>处理说明将保存到需求补充信息，供新一轮计划使用；提交后会完整重做。</p>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <div class="native-intervention-actions">
        <NButton
          :disabled="busy || !feedback.trim()"
          :loading="busy"
          @click="act('replan')"
        >保存说明并重新规划</NButton>
      </div>
    </div>
  </NCard>
</template>

<style scoped>
.native-intervention-panel { margin-bottom: 20px; }
.native-intervention-content { display: grid; gap: 12px; }
.native-intervention-content p { margin: 0; line-height: 1.7; }
.native-intervention-error { white-space: pre-wrap; overflow-wrap: anywhere; }
.native-intervention-actions { display: flex; flex-wrap: wrap; gap: 10px; }
</style>
