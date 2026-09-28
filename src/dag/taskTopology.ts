import type { TaskDefinition } from './contracts.js';

/** 同一依赖定义同时供 LangGraph 汇合调度和页面绘图使用。 */
export function taskTopology(tasks: readonly TaskDefinition[]) {
  const predecessors = new Set(tasks.flatMap((task) => task.dependsOn));
  return {
    nodes: tasks.map((task) => task.id),
    joins: tasks.map((task) => ({ sources: [...task.dependsOn], target: task.id })),
    leaves: tasks.filter((task) => !predecessors.has(task.id)).map((task) => task.id),
  };
}
