<script setup lang="ts">
import { computed, useId } from 'vue';
import {
  Handle,
  MarkerType,
  Position,
  VueFlow,
  useVueFlow,
  type Edge,
  type Node,
} from '@vue-flow/core';
import type { GraphTopology } from '../../../../shared/workflowGraphs.js';
const props = defineProps<{
  graph: GraphTopology;
  active?: string[];
  statuses?: Record<string, string>;
  order?: string[];
  variant?: 'workflow' | 'tasks';
}>();
const emit = defineEmits<{ select: [id: string] }>();
const graphId = useId();
const { fitView, zoomIn, zoomOut } = useVueFlow({ id: graphId });
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
  const isTaskGraph = props.variant === 'tasks';
  const nodeWidth = isTaskGraph ? 208 : 144;
  const nodeHeight = isTaskGraph ? 84 : 66;
  const nodes: Node[] = props.graph.nodes.map((node) => {
    const column = rank(node.id),
      row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      id: node.id,
      type: 'execution',
      position: { x: column * (nodeWidth + 48), y: row * (nodeHeight + 42) },
      width: nodeWidth,
      height: nodeHeight,
      data: {
        label: node.label,
        status: node.disabled ? '本轮不执行' : (props.statuses?.[node.id] ?? node.id),
        disabled: node.disabled,
      },
      draggable: false,
      connectable: false,
      selectable: false,
      focusable: false,
    };
  });
  return {
    nodes,
    height: Math.max(260, ...nodes.map((node) => node.position.y + nodeHeight + 72)),
  };
});
const edges = computed<Edge[]>(() => {
  const nodeIds = new Set(props.graph.nodes.map((node) => node.id));
  return props.graph.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge, index) => ({
      id: `edge-${index}-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#66848d' },
      style: {
        stroke: '#66848d',
        opacity: edge.disabled ? 0.15 : 0.5,
        strokeDasharray: edge.conditional ? '5 3' : undefined,
      },
      selectable: false,
    }));
});

function resetView() {
  void fitView({ padding: 0.16, maxZoom: 1.1, duration: 200 });
}
</script>
<template>
  <div
    class="execution-graph"
    :style="{ height: `${layout.height}px` }"
    role="region"
    :aria-label="variant === 'workflow' ? '主流程图' : '构建任务依赖图'"
  >
    <VueFlow
      :id="graphId"
      :nodes="layout.nodes"
      :edges="edges"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :edges-updatable="false"
      :elements-selectable="false"
      :zoom-on-scroll="false"
      :min-zoom="0.15"
      :max-zoom="1.5"
      fit-view-on-init
      @node-click="emit('select', $event.node.id)"
    >
      <template #node-execution="{ id, data }">
        <div class="execution-node-frame">
          <Handle type="target" :position="Position.Left" />
          <button
            class="execution-node"
            :class="[
              variant === 'tasks' ? taskState(statuses?.[id]) : '',
              { active: active?.includes(id), disabled: data.disabled },
            ]"
            type="button"
            :aria-label="`${data.label} ${data.status}`"
            :aria-pressed="active?.includes(id) ?? false"
          >
            <strong :title="data.label">{{ data.label }}</strong>
            <span>{{ data.status }}</span>
          </button>
          <Handle type="source" :position="Position.Right" />
        </div>
      </template>
    </VueFlow>
    <div class="execution-graph-actions" role="group" aria-label="图形缩放">
      <button type="button" aria-label="放大流程图" @click="zoomIn()">＋</button>
      <button type="button" aria-label="缩小流程图" @click="zoomOut()">－</button>
      <button type="button" aria-label="适配流程图" @click="resetView">适配</button>
    </div>
  </div>
</template>
<style scoped>
.execution-graph {
  position: relative;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border: 1px solid #94a3b84d;
  border-radius: 12px;
  margin: 12px 0;
}
.vue-flow {
  width: 100%;
  height: 100%;
}
:deep(.vue-flow__node-execution) {
  border: 0;
  background: transparent;
  padding: 0;
}
:deep(.vue-flow__handle) {
  opacity: 0;
  pointer-events: none;
}
.execution-node-frame {
  width: 100%;
  height: 100%;
}
.execution-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 10px;
  color: #243b44;
  background: #fff;
  border: 1px solid #9bafb5;
  border-radius: 12px;
  cursor: pointer;
  text-align: center;
}
.execution-node strong {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 13px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.execution-node span {
  margin-top: 5px;
  color: #48636b;
  font-size: 11px;
}
.execution-node.merged {
  background: #e9f7f2;
  border-color: #4b9e8b;
}
.execution-node.running {
  background: #edf5ff;
  border-color: #4a87c6;
}
.execution-node.failed {
  background: #fff1f0;
  border-color: #bd5a5a;
}
.execution-node.disabled {
  opacity: 0.45;
}
.execution-node.active,
.execution-node:focus-visible {
  outline: 2px solid #168875;
  outline-offset: 1px;
}
.execution-graph-actions {
  position: absolute;
  z-index: 2;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
}
.execution-graph-actions button {
  min-width: 32px;
  min-height: 32px;
  height: 32px;
  padding: 3px 6px;
  color: #243b44;
  background: #fff;
  border: 1px solid #9bafb5;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.execution-graph-actions button:first-child,
.execution-graph-actions button:nth-child(2) {
  width: 32px;
  padding: 0;
  font-size: 16px;
}
.execution-graph-actions button:focus-visible {
  outline: 2px solid #168875;
}
</style>
