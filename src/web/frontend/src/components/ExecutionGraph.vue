<script setup lang="ts">
import { computed, useId } from 'vue';
import type { GraphTopology } from '../../../../shared/workflowGraphs.js';
const props = defineProps<{ graph: GraphTopology; active?: string[]; statuses?: Record<string, string>; order?: string[] }>();
const emit = defineEmits<{ select: [id: string] }>();
const marker = `arrow-${useId()}`;
const layout = computed(() => {
  const ranks = new Map<string, number>();
  function rank(id: string, seen = new Set<string>()): number {
    if (ranks.has(id)) return ranks.get(id)!;
    if (seen.has(id)) return 0;
    const parents = props.graph.edges.filter(e => e.target === id).map(e => e.source);
    const value = props.order ? Math.max(0, props.order.indexOf(id)) : parents.length ? 1 + Math.max(...parents.map(p => rank(p, new Set([...seen, id])))) : 0;
    ranks.set(id, value); return value;
  }
  const rows = new Map<number, number>();
  const nodes = props.graph.nodes.map(node => {
    const column = rank(node.id), row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { ...node, x: 24 + column * 180, y: 30 + row * 104 };
  });
  return { nodes, width: Math.max(480, ...nodes.map(n => n.x + 180)), height: Math.max(210, ...nodes.map(n => n.y + 180)) };
});
const edges = computed(() => props.graph.edges.flatMap((edge, index) => {
  const source = layout.value.nodes.find(n => n.id === edge.source), target = layout.value.nodes.find(n => n.id === edge.target);
  if (!source || !target) return [];
  const back = target.x <= source.x;
  const sx = back ? source.x + 72 : source.x + 144, sy = back ? source.y + 66 : source.y + 33;
  const tx = back ? target.x + 72 : target.x, ty = back ? target.y + 66 : target.y + 33;
  const lower = Math.max(...layout.value.nodes.map(node => node.y + 66)) + 48 + (index % 3) * 18;
  return [{ ...edge, path: back ? `M ${sx} ${sy} C ${sx} ${lower}, ${tx} ${lower}, ${tx} ${ty}` : tx - sx > 36 ? `M ${sx} ${sy} H ${sx + 18} V ${lower} H ${tx - 18} V ${ty} H ${tx}` : `M ${sx} ${sy} C ${sx + 18} ${sy}, ${tx - 18} ${ty}, ${tx} ${ty}` }];
}));
</script>
<template>
  <div class="execution-graph" tabindex="0" aria-label="执行图，可横向滚动">
    <svg :width="layout.width" :height="layout.height" :viewBox="`0 0 ${layout.width} ${layout.height}`" role="group" aria-label="流程节点与依赖关系">
      <defs><marker :id="marker" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="currentColor" /></marker></defs>
      <path v-for="(edge, i) in edges" :key="i" :d="edge.path" fill="none" stroke="currentColor" :opacity="edge.disabled ? 0.15 : 0.5" :stroke-dasharray="edge.conditional ? '5 3' : undefined" :marker-end="`url(#${marker})`" />
      <g v-for="node in layout.nodes" :key="node.id" :transform="`translate(${node.x},${node.y})`" role="button" tabindex="0" :aria-label="`${node.label} ${statuses?.[node.id] ?? node.id}`" :class="{ active: active?.includes(node.id), disabled: node.disabled }" @click="emit('select', node.id)" @keydown.enter="emit('select', node.id)" @keydown.space.prevent="emit('select', node.id)">
        <title>{{ node.id }} · {{ node.label }} · {{ statuses?.[node.id] ?? (node.disabled ? '本轮不执行' : '') }}</title>
        <rect width="144" height="66" rx="10" />
        <text x="72" y="26" text-anchor="middle">{{ node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label }}</text>
        <text x="72" y="49" text-anchor="middle" class="status">{{ node.disabled ? '本轮不执行' : statuses?.[node.id] ?? node.id }}</text>
      </g>
    </svg>
  </div>
</template>
<style scoped>
.execution-graph { overflow-x: auto; color: #64748b; border: 1px solid #94a3b84d; border-radius: 12px; margin: 12px 0; }
rect { fill: var(--bg-card, #f8fafc); stroke: #94a3b8; }
g { cursor: pointer; } g:focus rect, .active rect { stroke: #3b82f6; stroke-width: 3; }
text { fill: var(--text-primary, #334155); font: 13px sans-serif; }.status { font-size: 11px; }.disabled { opacity: .45; }
</style>
