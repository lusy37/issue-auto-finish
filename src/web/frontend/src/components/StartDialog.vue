<script setup lang="ts">
import type { GitHubIssue, SupplementInfo } from '@/types';

const props = defineProps<{
  issue: GitHubIssue | null;
  supplement: SupplementInfo;
  processing: boolean;
}>();

const emit = defineEmits<{
  close: [];
  start: [];
  'update:supplement': [value: SupplementInfo];
}>();

function updateField(field: keyof SupplementInfo, value: string) {
  emit('update:supplement', { ...props.supplement, [field]: value });
}
</script>

<template>
  <Transition name="fade">
    <div v-if="issue" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="emit('close')" />
      <div class="relative bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div class="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10 rounded-t-xl">
          <h2 class="text-lg font-bold text-gray-800">{{ $t('start.title', { number: issue.number }) }}</h2>
          <button class="text-gray-400 hover:text-gray-600 text-2xl leading-none" @click="emit('close')">&times;</button>
        </div>

        <div class="px-6 py-4 space-y-4">
          <div>
            <div class="text-sm text-gray-500 mb-1">{{ $t('start.issueTitle') }}</div>
            <div class="text-sm font-medium text-gray-800">{{ issue.title }}</div>
          </div>
          <div v-if="issue.description">
            <div class="text-sm text-gray-500 mb-1">{{ $t('start.descPreview') }}</div>
            <div class="text-sm text-gray-600 bg-gray-50 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap">
              {{ issue.description?.slice(0, 500) }}{{ (issue.description?.length || 0) > 500 ? '...' : '' }}
            </div>
          </div>

          <div class="border-t border-gray-200 pt-4">
            <h3 class="text-sm font-semibold text-gray-700 mb-3">{{ $t('start.supplement') }}</h3>
            <div class="space-y-3">
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('start.requirements') }}</label>
                <textarea :value="supplement.requirements" @input="updateField('requirements', ($event.target as HTMLTextAreaElement).value)" rows="2"
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  :placeholder="$t('start.requirementsPlaceholder')" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('start.acceptance') }}</label>
                <textarea :value="supplement.acceptanceCriteria" @input="updateField('acceptanceCriteria', ($event.target as HTMLTextAreaElement).value)" rows="2"
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  :placeholder="$t('start.acceptancePlaceholder')" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('start.scope') }}</label>
                <input :value="supplement.scope" @input="updateField('scope', ($event.target as HTMLInputElement).value)" type="text"
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  :placeholder="$t('start.scopePlaceholder')">
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('start.constraints') }}</label>
                <textarea :value="supplement.constraints" @input="updateField('constraints', ($event.target as HTMLTextAreaElement).value)" rows="2"
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  :placeholder="$t('start.constraintsPlaceholder')" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('start.references') }}</label>
                <textarea :value="supplement.references" @input="updateField('references', ($event.target as HTMLTextAreaElement).value)" rows="1"
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  :placeholder="$t('start.referencesPlaceholder')" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('start.freeText') }}</label>
                <textarea :value="supplement.freeText" @input="updateField('freeText', ($event.target as HTMLTextAreaElement).value)" rows="2"
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  :placeholder="$t('start.freeTextPlaceholder')" />
              </div>
            </div>
          </div>
        </div>

        <div class="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex justify-end space-x-3 rounded-b-xl">
          <button class="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200" @click="emit('close')">{{ $t('start.cancel') }}</button>
          <button
            class="px-4 py-2 text-sm text-white bg-green-500 rounded-lg hover:bg-green-600 font-medium disabled:opacity-50"
            :disabled="processing" @click="emit('start')"
          >{{ processing ? $t('start.processing') : $t('start.submit') }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>
