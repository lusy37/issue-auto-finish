import { IssueWorkflow } from './IssueWorkflow.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import { taskTopology } from '../dag/taskTopology.js';
import type { IssueGraphs } from '../shared/workflowGraphs.js';

export class GraphSnapshotChangedError extends Error {}

/** 只调用原生图的读取接口；无 invoke、AI、Git 或聚合事务。 */
export async function inspectWorkflow(tracker: IssueTracker, number: number): Promise<IssueGraphs> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = tracker.get(number);
    if (!record) throw new Error('Issue 不存在');
    const run = record.run;
    const version = run.version;
    const workflow = new IssueWorkflow({
      tracker,
      number,
      maxRetries: 0,
      maxRepairs: 0,
      maxVisualRetries: 0,
      context: {
        issueIid: number,
        demand: record.demandSpec,
        branchName: record.branchName,
        workDir: '',
      },
      runner: {
        run: async () => {
          throw new Error('图检查接口禁止执行阶段');
        },
      },
    });
    const read = await Promise.all([workflow.getGraph(), workflow.getState()]).catch((error) => {
      // 重做可能在原生读取期间切换线程；丢弃旧取样，不把正常代次切换报成服务错误。
      if (tracker.get(number)?.run.version !== version) return undefined;
      throw error;
    });
    if (!read || tracker.get(number)?.run.version !== version) continue;
    const [graph, snapshot] = read;
    const phaseIds = [...(run.workflow.definition?.phaseIds ?? [])];
    const enabled = new Set<string>(phaseIds);
    const plan =
      Object.keys(run.tasks).length && run.planRevision && run.planDigest
        ? tracker.store.readPlan(number, run.planRevision, run.planDigest)
        : undefined;
    const topology = taskTopology(plan?.tasks ?? []);
    return {
      issueNumber: number,
      version,
      planRevision: run.planRevision,
      buildGeneration: run.buildGeneration,
      workflowGeneration: run.workflow.generation,
      threadId: workflow.checkpointer.threadId,
      lifecycle: record.lifecycle.kind,
      buildEntry: run.buildEntry,
      repairRounds: run.repairRounds,
      repairReason: run.repairs.at(-1)?.report,
      phaseIds,
      workflow: {
        nodes: Object.keys(graph.nodes).map((id) => ({
          id,
          label: id,
          disabled: id === 'uat' || id === 'publish_uat' ? !enabled.has('uat') : false,
        })),
        edges: graph.edges.map((edge) => ({
          source: edge.source,
          target: edge.target,
          conditional: edge.conditional,
          disabled:
            (!enabled.has('uat') &&
              [edge.source, edge.target].some((id) => id === 'uat' || id === 'publish_uat')) ||
            (enabled.has('uat') && edge.source === 'publish_verify' && edge.target === 'deliver'),
        })),
      },
      checkpoint: {
        exists: Boolean(snapshot.createdAt),
        next: [...snapshot.next],
        tasks: snapshot.tasks.map((task) => ({
          id: task.id,
          name: task.name,
          error: task.error ? String(task.error) : undefined,
          interrupts: (task.interrupts ?? []).map((item) => item.value),
        })),
      },
      topology: {
        nodes: topology.nodes.map((id) => ({
          id,
          label: plan!.tasks.find((task) => task.id === id)!.title,
        })),
        edges: topology.joins.flatMap((join) =>
          join.sources.map((source) => ({ source, target: join.target })),
        ),
      },
      tasks: plan?.tasks.map((task) => ({ ...task, ...run.tasks[task.id] })) ?? [],
    };
  }
  throw new GraphSnapshotChangedError('执行状态正在更新，请刷新流程图');
}
