<script setup lang="ts">
import type { GitHubIssue, SystemStatus } from '@/types';
import { formatTime } from '@/utils/formatters';

defineProps<{
  issues: GitHubIssue[];
  trackedIids: Set<number>;
  total: number;
  page: number;
  perPage: number;
  loading: boolean;
  error: string;
  search: string;
  systemStatus: SystemStatus | null;
}>();

const emit = defineEmits<{
  'update:search': [value: string];
  'update:page': [value: number];
  search: [];
  start: [issue: GitHubIssue];
}>();

function issueUrl(number: number, status: SystemStatus | null): string {
  if (!status) return '#';
  return `${status.config.githubBaseUrl}/${status.config.repository}/issues/${number}`;
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center space-x-3">
      <div class="relative flex-1 max-w-md">
        <input
          :value="search"
          @input="emit('update:search', ($event.target as HTMLInputElement).value)"
          type="text" :placeholder="$t('browse.searchPlaceholder')"
          class="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
          @keyup.enter="emit('search')"
        >
        <svg class="absolute left-3 top-2.5 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
      </div>
      <button
        class="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700"
        :disabled="loading" @click="emit('search')"
      >{{ loading ? $t('browse.loading') : $t('browse.search') }}</button>
    </div>

    <div v-if="loading" class="py-12 text-center text-gray-400">
      <svg class="animate-spin h-6 w-6 mx-auto mb-2 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      {{ $t('browse.loadingList') }}
    </div>

    <div v-else-if="error" class="py-8 text-center text-red-500">{{ error }}</div>

    <div v-else>
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">IID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{{ $t('browse.title') }}</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{{ $t('browse.labels') }}</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{{ $t('browse.author') }}</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{{ $t('browse.createdAt') }}</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{{ $t('browse.actions') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-if="issues.length === 0">
              <td colspan="6" class="px-4 py-8 text-center text-gray-400">{{ $t('browse.empty') }}</td>
            </tr>
            <tr v-for="gi in issues" :key="gi.number" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 text-sm font-mono text-gray-700">
                <a :href="issueUrl(gi.number, systemStatus)" target="_blank" rel="noopener"
                   class="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center">
                  #{{ gi.number }}
                  <svg class="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                </a>
              </td>
              <td class="px-4 py-3 text-sm text-gray-800 max-w-sm truncate">{{ gi.title }}</td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap">
                  <span v-for="label in gi.labels" :key="label" class="label-tag bg-blue-100 text-blue-700">{{ label }}</span>
                </div>
              </td>
              <td class="px-4 py-3 text-sm text-gray-600">{{ gi.author?.name || gi.author?.username || '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-500">{{ formatTime(gi.created_at) }}</td>
              <td class="px-4 py-3">
                <span v-if="trackedIids.has(gi.number)" class="px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">{{ $t('browse.tracked') }}</span>
                <button v-else class="px-3 py-1 bg-green-500 text-white text-xs rounded-lg hover:bg-green-600 font-medium" @click="emit('start', gi)">{{ $t('browse.start') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="total > perPage" class="flex items-center justify-between mt-4">
        <div class="text-sm text-gray-500">{{ $t('browse.pagination', { total, page, totalPages: Math.ceil(total / perPage) }) }}</div>
        <div class="flex space-x-2">
          <button class="px-3 py-1 text-sm bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40"
                  :disabled="page <= 1" @click="emit('update:page', page - 1); emit('search')">{{ $t('browse.prevPage') }}</button>
          <button class="px-3 py-1 text-sm bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40"
                  :disabled="page >= Math.ceil(total / perPage)" @click="emit('update:page', page + 1); emit('search')">{{ $t('browse.nextPage') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
