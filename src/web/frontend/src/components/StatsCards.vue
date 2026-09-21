<script setup lang="ts">
defineProps<{
  total: number;
  active: number;
  review: number;
  completed: number;
}>();
</script>

<template>
  <div class="metrics-grid" aria-label="任务统计">
    <div class="metric-card">
      <div class="metric-label"><span>全部任务</span><span class="metric-icon">◈</span></div>
      <div class="metric-value">{{ total }}</div>
      <p>当前仓库的全部 Issue</p>
    </div>
    <div class="metric-card metric-card-primary">
      <div class="metric-label"><span>正在执行</span><span class="metric-icon">●</span></div>
      <div class="metric-value">{{ active }}<span class="live-dot" aria-hidden="true"></span></div>
      <p>正在占用执行额度</p>
    </div>
    <div class="metric-card metric-card-warning">
      <div class="metric-label"><span>等待审核</span><span class="metric-icon">◷</span></div>
      <div class="metric-value">{{ review }}</div>
      <p>需要你的下一步决策</p>
    </div>
    <div class="metric-card metric-card-success">
      <div class="metric-label"><span>已完成交付</span><span class="metric-icon">✓</span></div>
      <div class="metric-value">{{ completed }}</div>
      <p>构建、验证与验收完成</p>
    </div>
  </div>
</template>
