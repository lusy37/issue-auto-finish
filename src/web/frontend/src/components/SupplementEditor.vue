<script setup lang="ts">
import type { SupplementInfo } from '@/types';

const props = defineProps<{
  supplement: SupplementInfo;
  supplementForm: SupplementInfo;
  loading: boolean;
  error?: string;
  editing: boolean;
  saving: boolean;
  hasData: boolean;
}>();

const emit = defineEmits<{
  edit: [];
  save: [];
  cancel: [];
  'update:supplementForm': [value: SupplementInfo];
}>();

function updateField(field: keyof SupplementInfo, value: string) {
  emit('update:supplementForm', { ...props.supplementForm, [field]: value });
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-base font-semibold text-gray-700">{{ $t('supplement.title') }}</h3>
      <div class="flex items-center space-x-2">
        <button
          v-if="!editing && !loading && !error"
          class="px-2 py-1 text-xs bg-blue-100 text-blue-600 rounded hover:bg-blue-200"
          @click="emit('edit')"
        >{{ $t('supplement.edit') }}</button>
        <template v-else>
          <button
            class="px-2 py-1 text-xs bg-green-500 text-white rounded hover:bg-green-600"
            :disabled="saving"
            @click="emit('save')"
          >{{ saving ? $t('supplement.saving') : $t('supplement.save') }}</button>
          <button
            class="px-2 py-1 text-xs bg-gray-200 text-gray-600 rounded hover:bg-gray-300"
            @click="emit('cancel')"
          >{{ $t('supplement.cancel') }}</button>
        </template>
      </div>
    </div>

    <div v-if="loading" class="py-4 text-center text-gray-400 text-sm">{{ $t('supplement.loading') }}</div>
    <div v-else-if="error" role="alert" class="py-4 text-red-600 text-sm">补充资料读取失败：{{ error }}。请修复文件后重新打开详情。</div>

    <div v-else-if="!editing">
      <div v-if="hasData" class="space-y-2 text-sm">
        <div v-if="supplement.requirements"><span class="text-gray-500 font-medium">{{ $t('supplement.requirements') }}</span> <span class="text-gray-700">{{ supplement.requirements }}</span></div>
        <div v-if="supplement.acceptanceCriteria"><span class="text-gray-500 font-medium">{{ $t('supplement.acceptance') }}</span> <span class="text-gray-700">{{ supplement.acceptanceCriteria }}</span></div>
        <div v-if="supplement.scope"><span class="text-gray-500 font-medium">{{ $t('supplement.scope') }}</span> <span class="text-gray-700">{{ supplement.scope }}</span></div>
        <div v-if="supplement.constraints"><span class="text-gray-500 font-medium">{{ $t('supplement.constraints') }}</span> <span class="text-gray-700">{{ supplement.constraints }}</span></div>
        <div v-if="supplement.references"><span class="text-gray-500 font-medium">{{ $t('supplement.references') }}</span> <span class="text-gray-700">{{ supplement.references }}</span></div>
        <div v-if="supplement.freeText"><span class="text-gray-500 font-medium">{{ $t('supplement.freeText') }}</span> <span class="text-gray-700">{{ supplement.freeText }}</span></div>
      </div>
      <div v-else class="py-4 text-center text-gray-400 text-sm">{{ $t('supplement.empty') }}</div>
    </div>

    <div v-else class="space-y-3">
      <div>
        <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('supplement.requirementsLabel') }}</label>
        <textarea :value="supplementForm.requirements" @input="updateField('requirements', ($event.target as HTMLTextAreaElement).value)" rows="2"
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('supplement.acceptanceLabel') }}</label>
        <textarea :value="supplementForm.acceptanceCriteria" @input="updateField('acceptanceCriteria', ($event.target as HTMLTextAreaElement).value)" rows="2"
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('supplement.scopeLabel') }}</label>
        <input :value="supplementForm.scope" @input="updateField('scope', ($event.target as HTMLInputElement).value)" type="text"
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('supplement.constraintsLabel') }}</label>
        <textarea :value="supplementForm.constraints" @input="updateField('constraints', ($event.target as HTMLTextAreaElement).value)" rows="2"
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('supplement.referencesLabel') }}</label>
        <textarea :value="supplementForm.references" @input="updateField('references', ($event.target as HTMLTextAreaElement).value)" rows="1"
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-600 mb-1">{{ $t('supplement.freeTextLabel') }}</label>
        <textarea :value="supplementForm.freeText" @input="updateField('freeText', ($event.target as HTMLTextAreaElement).value)" rows="2"
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
      </div>
    </div>
  </div>
</template>
