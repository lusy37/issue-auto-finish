<script setup lang="ts">
import { ref, watch } from 'vue';
import type { SystemStatus } from '@/types';
import { formatDuration } from '@/utils/formatters';
import * as api from '@/api/client';
import { useI18n } from '@/i18n/index';

const { locale, setLocale } = useI18n();

const props = defineProps<{
  connected: boolean;
  systemStatus: SystemStatus | null;
}>();

const emit = defineEmits<{
  (e: 'open-settings'): void;
}>();

const noteSyncEnabled = ref(true);
const noteSyncSaving = ref(false);

watch(() => props.systemStatus, (s) => {
  if (s) noteSyncEnabled.value = s.config.issueNoteSyncEnabled;
}, { immediate: true });

async function toggleSystemNoteSync() {
  const next = !noteSyncEnabled.value;
  noteSyncSaving.value = true;
  try {
    await api.setSystemNoteSync(next);
    noteSyncEnabled.value = next;
  } catch (e) {
    console.error('Failed to toggle system note sync', e);
  } finally {
    noteSyncSaving.value = false;
  }
}
</script>

<template>
  <header class="app-topbar">
    <div class="topbar-left">
        <img src="/logo.png" alt="IssueFlow" class="topbar-logo" />
        <span class="topbar-repository">issue-auto-finish</span>
        <span class="topbar-separator">/</span>
        <strong>LangGraph Native</strong>
        <span
          class="connection-pill"
          :class="connected ? 'text-green-600' : 'text-red-500'"
        >
          <span
            class="inline-block w-2 h-2 rounded-full"
            :class="connected ? 'bg-green-500 pulse-dot' : 'bg-red-500'"
          />
          <span>{{ connected ? '实时连接' : '连接中断' }}</span>
        </span>
    </div>
      <div class="topbar-actions">
        <span v-if="systemStatus" class="topbar-meta">运行 {{ formatDuration(systemStatus.uptime) }}</span>
        <span v-if="systemStatus" class="topbar-meta">AI · {{ systemStatus.config.aiMode }}</span>
        <span
          v-if="systemStatus?.config.pipelineMode"
          class="mode-pill"
        >计划 → 审核 → 构建 → 验证 → 验收 → 交付</span>
        <button
          v-if="systemStatus"
          class="sync-pill"
          :class="noteSyncEnabled ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'"
          :disabled="noteSyncSaving"
          :title="noteSyncEnabled ? $t('header.syncOnTitle') : $t('header.syncOffTitle')"
          @click="toggleSystemNoteSync()"
        >
          {{ noteSyncEnabled ? $t('header.syncOn') : $t('header.syncOff') }}
        </button>
        <button
          class="topbar-button"
          :title="$t('header.settings')"
          @click="emit('open-settings')"
        >
          <svg class="h-3.5 w-3.5 inline-block" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.248a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
        <button
          class="topbar-button"
          :title="$t('header.langSwitch')"
          @click="setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')"
        >
          {{ locale === 'zh-CN' ? 'EN' : '中文' }}
        </button>
      </div>
  </header>
</template>
