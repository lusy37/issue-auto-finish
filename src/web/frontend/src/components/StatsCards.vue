<script setup lang="ts">
defineProps<{
  total: number;
  active: number;
  completed: number;
  failed: number;
}>();
</script>

<template>
  <div class="grid grid-cols-4 gap-4 mb-6">
    <div class="bg-white rounded-lg shadow-sm p-4 border border-gray-200">
      <div class="text-sm text-gray-500">{{ $t('stats.total') }}</div>
      <div class="text-2xl font-bold text-gray-800">{{ total }}</div>
    </div>
    <div class="bg-white rounded-lg shadow-sm p-4 border border-blue-200">
      <div class="text-sm text-blue-500">{{ $t('stats.active') }}</div>
      <div class="text-2xl font-bold text-blue-600">{{ active }}</div>
    </div>
    <div class="bg-white rounded-lg shadow-sm p-4 border border-green-200">
      <div class="text-sm text-green-500">{{ $t('stats.completed') }}</div>
      <div class="text-2xl font-bold text-green-600">{{ completed }}</div>
    </div>
    <div class="bg-white rounded-lg shadow-sm p-4 border border-red-200">
      <div class="text-sm text-red-500">{{ $t('stats.failed') }}</div>
      <div class="text-2xl font-bold text-red-600">{{ failed }}</div>
    </div>
  </div>
</template>
