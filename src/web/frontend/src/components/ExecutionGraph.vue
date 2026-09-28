<script setup lang="ts">
import { computed, useId } from 'vue';
import type { GraphTopology } from '../../../../shared/workflowGraphs.js';
const props = defineProps<{
  graph: GraphTopology;
  active?: string[];
  statuses?: Record<string, string>;
  order?: string[];
  variant?: 'workflow' | 'tasks';
}>();
const emit = defineEmits<{ select: [id: string] }>();
const marker = `arrow-${useId()}`;
function titleLines(label: string): string[] {
  const lines = [''];
  const width = (text: string) =>
    Array.from(text).reduce((total, char) => total + (char.charCodeAt(0) <= 0xff ? 1 : 2), 0);
  for (const char of label) {
    let last = lines.length - 1;
    if (width(lines[last] + char) > 26) {
      if (last === 1) {
        while (width(lines[1] + '…') > 26) lines[1] = lines[1].slice(0, -1);
        return [lines[0].trim(), lines[1].trimEnd() + '…'];
      }
      lines.push('');
      last = 1;
    }
    lines[last] += char;
  }
  return lines.map((line) => line.trim());
}
function taskState(status?: string): string {
  if (status === '已合并') return 'merged';
  if (status === '执行中' || status === '正在集成') return 'running';
  if (status === '失败' || status === '结果待核对' || status === '凭证待核对') return 'failed';
  return 'waiting';
}
const layout = computed(() => {
  const ranks = new Map<string, number>();
  function rank(id: string, seen = new Set<string>()): number {
    if (ranks.has(id)) return ranks.get(id)!;
    if (seen.has(id)) return 0;
    const parents = props.graph.edges.filter((e) => e.target === id).map((e) => e.source);
    const value = props.order
      ? Math.max(0, props.order.indexOf(id))
      : parents.length
        ? 1 + Math.max(...parents.map((p) => rank(p, new Set([...seen, id]))))
        : 0;
    ranks.set(id, value);
    return value;
  }
  const rows = new Map<number, number>();
  let nodes = props.graph.nodes.map((node) => {
    const column = rank(node.id),
      row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    const isTaskGraph = props.variant === 'tasks';
    return {
      ...node,
      x: (isTaskGraph ? 38 : 24) + column * (isTaskGraph ? 220 : 180),
      y: (isTaskGraph ? 54 : 30) + row * (isTaskGraph ? 118 : 104),
      titleLines: isTaskGraph ? titleLines(node.label) : [],
    };
  });
  const isTaskGraph = props.variant === 'tasks';
  if (isTaskGraph && nodes.length === 1) nodes = nodes.map((node) => ({ ...node, x: 256, y: 108 }));
  const naturalWidth = Math.max(
    isTaskGraph ? 720 : 480,
    ...nodes.map((node) => node.x + (isTaskGraph ? 208 : 180)),
  );
  const routedBelow =
    isTaskGraph &&
    props.graph.edges.some((edge) => {
      const source = nodes.find((node) => node.id === edge.source),
        target = nodes.find((node) => node.id === edge.target);
      return source && target && (target.x <= source.x || target.x - source.x - 208 > 36);
    });
  const nodeBottom = Math.max(0, ...nodes.map((node) => node.y + 84));
  return {
    nodes,
    width: naturalWidth,
    height: Math.max(
      isTaskGraph ? 260 : 210,
      ...nodes.map((node) => node.y + (isTaskGraph ? 132 : 180)),
      routedBelow ? nodeBottom + 96 : 0,
    ),
    nodeWidth: isTaskGraph ? 208 : 144,
  };
});
const edges = computed(() =>
  props.graph.edges.flatMap((edge, index) => {
    const source = layout.value.nodes.find((n) => n.id === edge.source),
      target = layout.value.nodes.find((n) => n.id === edge.target);
    if (!source || !target) return [];
    const nodeWidth = layout.value.nodeWidth;
    const nodeHeight = props.variant === 'tasks' ? 84 : 66;
    const back = target.x <= source.x;
    const sx = back ? source.x + nodeWidth / 2 : source.x + nodeWidth,
      sy = back ? source.y + nodeHeight : source.y + nodeHeight / 2;
    const tx = back ? target.x + nodeWidth / 2 : target.x,
      ty = back ? target.y + nodeHeight : target.y + nodeHeight / 2;
    const lower =
      Math.max(...layout.value.nodes.map((node) => node.y + nodeHeight)) + 48 + (index % 3) * 18;
    return [
      {
        ...edge,
        path: back
          ? `M ${sx} ${sy} C ${sx} ${lower}, ${tx} ${lower}, ${tx} ${ty}`
          : tx - sx > 36
            ? `M ${sx} ${sy} H ${sx + 18} V ${lower} H ${tx - 18} V ${ty} H ${tx}`
            : `M ${sx} ${sy} C ${sx + 18} ${sy}, ${tx - 18} ${ty}, ${tx} ${ty}`,
      },
    ];
  }),
);
</script>
<template>
  <div
    class="execution-graph"
    tabindex="0"
    aria-label="构建任务依赖图"
  >
    <svg
      :width="layout.width"
      :height="layout.height"
      :viewBox="`0 0 ${layout.width} ${layout.height}`"
      role="group"
      aria-label="流程节点与依赖关系"
    >
      <defs>
        <marker
          :id="marker"
          markerWidth="7"
          markerHeight="7"
          refX="6"
          refY="3.5"
          orient="auto"
        >
          <path
            d="M0,0 L7,3.5 L0,7"
            fill="currentColor"
          />
        </marker>
      </defs>
      <path
        v-for="(edge, i) in edges"
        :key="i"
        :d="edge.path"
        fill="none"
        stroke="currentColor"
        :opacity="edge.disabled ? 0.15 : 0.5"
        :stroke-dasharray="edge.conditional ? '5 3' : undefined"
        :marker-end="`url(#${marker})`"
      />
      <g
        v-for="node in layout.nodes"
        :key="node.id"
        :transform="`translate(${node.x},${node.y})`"
        role="button"
        tabindex="0"
        :aria-label="`${node.label} ${statuses?.[node.id] ?? node.id}`"
        :class="[
          variant === 'tasks' ? taskState(statuses?.[node.id]) : '',
          { active: active?.includes(node.id), disabled: node.disabled },
        ]"
        @click="emit('select', node.id)"
        @keydown.enter="emit('select', node.id)"
        @keydown.space.prevent="emit('select', node.id)"
      >
        <title>
          {{ node.id }} · {{ node.label }} ·
          {{ statuses?.[node.id] ?? (node.disabled ? '本轮不执行' : '') }}
        </title>
        <rect
          :width="layout.nodeWidth"
          :height="variant === 'tasks' ? 84 : 66"
          :rx="variant === 'tasks' ? 12 : 10"
        />
        <text
          v-if="variant === 'tasks'"
          :x="layout.nodeWidth / 2"
          :y="node.titleLines.length > 1 ? 24 : 32"
          text-anchor="middle"
        >
          <tspan
            v-for="(line, index) in node.titleLines"
            :key="index"
            :x="layout.nodeWidth / 2"
            :dy="index ? 16 : 0"
          >
            {{ line }}
          </tspan>
        </text>
        <text
          v-else
          x="72"
          y="26"
          text-anchor="middle"
        >
          {{ node.label.length > 18 ? node.label.slice(0, 17) + '…' : node.label }}
        </text>
        <text
          :x="layout.nodeWidth / 2"
          :y="
            variant === 'tasks' && node.titleLines.length > 1 ? 68 : variant === 'tasks' ? 60 : 49
          "
          text-anchor="middle"
          class="status"
        >
          {{ node.disabled ? '本轮不执行' : (statuses?.[node.id] ?? node.id) }}
        </text>
      </g>
    </svg>
  </div>
</template>
<style scoped>
.execution-graph {
  overflow-x: auto;
  color: #64748b;
  border: 1px solid #94a3b84d;
  border-radius: 12px;
  margin: 12px 0;
}
rect {
  fill: var(--bg-card, #f8fafc);
  stroke: #94a3b8;
}
g {
  cursor: pointer;
}
g:focus rect,
.active rect {
  stroke: #3b82f6;
  stroke-width: 3;
}
text {
  fill: var(--text-primary, #334155);
  font: 13px sans-serif;
}
.status {
  font-size: 11px;
}
.disabled {
  opacity: 0.45;
}
</style>
