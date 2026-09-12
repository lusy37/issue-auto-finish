<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import type { PlanFileSpec } from '@/types';
import * as api from '@/api/client';
import { useI18n } from '@/i18n/index';

const props = defineProps<{
  issueIid: number;
  planDocs: PlanFileSpec[];
  isEditableDoc: (filename: string) => boolean;
  detailVersion?: number;
}>();

watch(() => props.detailVersion, () => {
  if (activeDoc.value) {
    loadDoc(activeDoc.value);
  }
});

const activeDoc = ref<string | null>(null);
const docContent = ref('');
const docLoading = ref(false);
const docError = ref('');
const docEditMode = ref(false);
const docRawContent = ref('');
const docSaving = ref(false);
const docNotFound = ref(false);
const isFullscreen = ref(false);

const { t } = useI18n();

const NOT_FOUND_HINTS: Record<string, () => string> = {
  'review-feedback.md': () => t('planDoc.noReviewFeedback'),
  '02-verify-report.md': () => t('planDoc.verifyNotGenerated'),
};

async function loadDoc(filename: string) {
  activeDoc.value = filename;
  docEditMode.value = false;
  docRawContent.value = '';
  docLoading.value = true;
  docContent.value = '';
  docError.value = '';
  docNotFound.value = false;
  try {
    docContent.value = await api.loadPlanDoc(props.issueIid, filename, 'html');
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('not found') && filename in NOT_FOUND_HINTS) {
      docNotFound.value = true;
      docError.value = NOT_FOUND_HINTS[filename]();
    } else {
      docError.value = msg;
    }
  } finally {
    docLoading.value = false;
  }
}

async function enterEditMode() {
  if (!activeDoc.value) return;
  try {
    docRawContent.value = await api.loadPlanDoc(props.issueIid, activeDoc.value, 'raw');
    docEditMode.value = true;
  } catch (e) {
    alert(t('planDoc.fetchFailed') + ' ' + (e as Error).message);
  }
}

function exitEditMode() {
  docEditMode.value = false;
  docRawContent.value = '';
  if (activeDoc.value) loadDoc(activeDoc.value);
}

async function savePlanDoc() {
  if (!activeDoc.value) return;
  docSaving.value = true;
  try {
    await api.savePlanDoc(props.issueIid, activeDoc.value, docRawContent.value);
    docEditMode.value = false;
    docRawContent.value = '';
    await loadDoc(activeDoc.value);
  } catch (e) {
    alert(t('planDoc.saveFailed') + ' ' + (e as Error).message);
  } finally {
    docSaving.value = false;
  }
}

function openFullscreen() {
  isFullscreen.value = true;
  document.body.style.overflow = 'hidden';
  if (!activeDoc.value && props.planDocs.length > 0) {
    loadDoc(props.planDocs[0].file);
  }
}

function closeFullscreen() {
  isFullscreen.value = false;
  document.body.style.overflow = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isFullscreen.value) {
    closeFullscreen();
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  if (props.planDocs.length > 0) {
    loadDoc(props.planDocs[0].file);
  }
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
});

defineExpose({ activeDoc });
</script>

<template>
  <div class="flex flex-col">
    <div class="flex items-center justify-between mb-2 shrink-0">
      <h3 class="text-base font-semibold text-gray-700">{{ $t('planDoc.title') }}</h3>
      <div class="flex items-center space-x-2">
        <template v-if="activeDoc && isEditableDoc(activeDoc) && !isFullscreen">
          <button
            v-if="!docEditMode"
            class="px-2 py-1 text-xs bg-blue-100 text-blue-600 rounded hover:bg-blue-200"
            @click="enterEditMode()"
          >{{ $t('planDoc.edit') }}</button>
          <template v-else>
            <button
              class="px-2 py-1 text-xs bg-green-500 text-white rounded hover:bg-green-600"
              :disabled="docSaving"
              @click="savePlanDoc()"
            >{{ docSaving ? $t('planDoc.saving') : $t('planDoc.save') }}</button>
            <button
              class="px-2 py-1 text-xs bg-gray-200 text-gray-600 rounded hover:bg-gray-300"
              @click="exitEditMode()"
            >{{ $t('planDoc.cancel') }}</button>
          </template>
        </template>
        <button
          class="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 inline-flex items-center space-x-1"
          :title="$t('planDoc.fullscreen')"
          @click="openFullscreen()"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
          <span>{{ $t('planDoc.expand') }}</span>
        </button>
      </div>
    </div>

    <div class="flex space-x-1 mb-3 border-b border-gray-200 shrink-0">
      <button
        v-for="doc in planDocs"
        :key="doc.file"
        class="px-3 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeDoc === doc.file ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'"
        @click="loadDoc(doc.file)"
      >{{ doc.label }}</button>
    </div>

    <div v-if="docLoading" class="flex-1 flex items-center justify-center text-gray-400">{{ $t('planDoc.loading') }}</div>
    <div v-else-if="docError" class="flex-1 flex items-center justify-center text-gray-400">{{ docError }}</div>
    <div v-else-if="docEditMode && !isFullscreen" class="flex-1 min-h-0 flex flex-col">
      <textarea
        v-model="docRawContent"
        class="w-full flex-1 min-h-0 border border-gray-300 rounded-lg p-3 text-sm font-mono text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
        :placeholder="$t('planDoc.editPlaceholder')"
      />
    </div>
    <div
      v-else-if="docContent && !isFullscreen"
      class="plan-doc text-sm text-gray-700 flex-1 min-h-0 overflow-y-auto border border-gray-100 rounded-lg p-4"
      v-html="docContent"
    />
    <div v-else-if="!isFullscreen" class="flex-1 flex items-center justify-center text-gray-400">{{ $t('planDoc.selectTab') }}</div>

    <!-- Fullscreen overlay -->
    <Teleport to="body">
      <Transition name="fullscreen-fade">
        <div v-if="isFullscreen" class="fullscreen-doc-overlay">
          <div class="fullscreen-doc-container">
            <!-- Header -->
            <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
              <div class="flex items-center space-x-3">
                <h2 class="text-lg font-bold text-gray-800">{{ $t('planDoc.title') }}</h2>
                <span class="text-sm text-gray-400">Issue #{{ issueIid }}</span>
              </div>
              <div class="flex items-center space-x-2">
                <template v-if="activeDoc && isEditableDoc(activeDoc)">
                  <button
                    v-if="!docEditMode"
                    class="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
                    @click="enterEditMode()"
                  >{{ $t('planDoc.edit') }}</button>
                  <template v-else>
                    <button
                      class="px-3 py-1.5 text-sm bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
                      :disabled="docSaving"
                      @click="savePlanDoc()"
                    >{{ docSaving ? $t('planDoc.saving') : $t('planDoc.save') }}</button>
                    <button
                      class="px-3 py-1.5 text-sm bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300 transition-colors"
                      @click="exitEditMode()"
                    >{{ $t('planDoc.cancel') }}</button>
                  </template>
                </template>
                <button
                  class="ml-2 p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                  :title="$t('planDoc.closeFullscreen')"
                  @click="closeFullscreen()"
                >
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>

            <!-- Tabs -->
            <div class="flex space-x-1 px-6 pt-3 border-b border-gray-200 shrink-0">
              <button
                v-for="doc in planDocs"
                :key="'fs-' + doc.file"
                class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors"
                :class="activeDoc === doc.file ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'"
                @click="loadDoc(doc.file)"
              >{{ doc.label }}</button>
            </div>

            <!-- Content -->
            <div class="flex-1 overflow-y-auto min-h-0">
              <div v-if="docLoading" class="flex items-center justify-center h-full text-gray-400">
                <span class="text-base">{{ $t('planDoc.loading') }}</span>
              </div>
              <div v-else-if="docError" class="flex items-center justify-center h-full text-gray-400">
                <span class="text-base">{{ docError }}</span>
              </div>
              <div v-else-if="docEditMode" class="h-full p-4">
                <textarea
                  v-model="docRawContent"
                  class="w-full h-full border border-gray-300 rounded-lg p-4 text-sm font-mono text-gray-700 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
                  :placeholder="$t('planDoc.editPlaceholder')"
                />
              </div>
              <div
                v-else-if="docContent"
                class="plan-doc text-sm text-gray-700 p-6"
                v-html="docContent"
              />
              <div v-else class="flex items-center justify-center h-full text-gray-400">
                <span class="text-base">{{ $t('planDoc.selectTab') }}</span>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
