import type { TaskDefinition, TaskRun } from './workbench.js';

export interface GraphNode { id: string; label: string; disabled?: boolean }
export interface GraphEdge { source: string; target: string; conditional?: boolean; disabled?: boolean }
export interface GraphTopology { nodes: GraphNode[]; edges: GraphEdge[] }
export interface IssueGraphs {
  issueNumber: number;
  version: number;
  planRevision: number;
  buildGeneration: number;
  workflowGeneration: number;
  threadId: string;
  lifecycle: string;
  buildEntry: string;
  repairRounds: number;
  repairReason?: string;
  phaseIds: string[];
  workflow: GraphTopology;
  checkpoint: {
    exists: boolean;
    next: string[];
    tasks: Array<{ id: string; name: string; error?: string; interrupts: unknown[] }>;
  };
  topology: GraphTopology;
  tasks: Array<TaskDefinition & Partial<TaskRun>>;
}
