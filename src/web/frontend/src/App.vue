<script setup lang="ts">
import IssueDetailPage from '@/components/IssueDetailPage.vue';
import WorkbenchPage from '@/components/WorkbenchPage.vue';

// 仅挂载当前页面，让各页面独立管理初始化、轮询和实时事件订阅。
const isDetailPage = window.location.pathname === '/detail';
</script>

<template>
  <IssueDetailPage v-if="isDetailPage" />
  <WorkbenchPage v-else />
</template>
