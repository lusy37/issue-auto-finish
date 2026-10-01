<script setup lang="ts">
import { computed } from 'vue';
import {
  ArcElement,
  Chart as ChartJS,
  Legend,
  Tooltip,
  type ChartData,
  type ChartOptions,
} from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Doughnut } from 'vue-chartjs';

ChartJS.register(ArcElement, Tooltip, Legend, ChartDataLabels);

export type TaskDistributionItem = {
  label: string;
  count: number;
  percentage: number;
  color: string;
};

const props = defineProps<{
  items: TaskDistributionItem[];
  total: number;
}>();

const chartData = computed<ChartData<'doughnut'>>(() => {
  const hasTasks = props.total > 0;
  return {
    labels: props.items.map((item) => item.label),
    datasets: [
      {
        data: hasTasks ? props.items.map((item) => item.count) : [1],
        backgroundColor: hasTasks ? props.items.map((item) => item.color) : ['#e6edef'],
        borderColor: '#ffffff',
        borderWidth: 3,
        hoverOffset: 4,
      },
    ],
  };
});

const chartOptions: ChartOptions<'doughnut'> = {
  responsive: true,
  maintainAspectRatio: false,
  cutout: '62%',
  animation: {
    duration: 240,
  },
  plugins: {
    legend: {
      display: false,
    },
    datalabels: {
      color: '#ffffff',
      display: (context) =>
        props.total > 0 && (props.items[context.dataIndex]?.count ?? 0) > 0,
      font: {
        size: 13,
        weight: 600,
      },
      formatter: (_value, context) => {
        const item = props.items[context.dataIndex];
        return item && item.count > 0 ? `${item.percentage}%` : '';
      },
    },
    tooltip: {
      callbacks: {
        label: (context) => {
          const item = props.items[context.dataIndex];
          return item ? ` ${item.label}：${item.count} 个` : '';
        },
      },
    },
  },
};

const ariaLabel = computed(
  () =>
    `任务分布：${props.items
      .map((item) => `${item.label} ${item.count} 个，占比 ${item.percentage}%`)
      .join('，')}`,
);
</script>

<template>
  <div
    class="prototype-pie-chart"
    role="img"
    :aria-label="ariaLabel"
  >
    <Doughnut
      :data="chartData"
      :options="chartOptions"
    />
    <div class="prototype-pie-center">
      <strong>{{ total }}</strong>
      <span>总任务</span>
    </div>
  </div>
</template>
