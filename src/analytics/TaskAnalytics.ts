import type {TaskSummary} from '../shared/workbench.js';
import { retryAttempts, type IssueRecord } from "../tracker/IssueRecord.js";
/** 统计读取持久化记录，不依赖进程内计数器。 */
export function summarizeTasks(
  records: IssueRecord[],
  range: "7d" | "30d" | "all",
  now = Date.now(),
): TaskSummary {
  const cutoff =
    range === "all" ? 0 : now - (range === "7d" ? 7 : 30) * 86400000;
  const tasks = records.filter((r) => Date.parse(r.createdAt) >= cutoff);
  const completed = tasks.filter((r) => r.lifecycle.kind === 'completed'),
    failed = tasks.filter((r) => r.lifecycle.kind === 'failed');
  const terminal = [...completed, ...failed];
  const durations = terminal
    .map((r) =>
      Math.max(
        0,
        Date.parse(r.completedAt ?? r.updatedAt) - Date.parse(r.createdAt),
      ),
    )
    .filter(Number.isFinite);
  const phases: Record<
    string,
    { runs: number; durationMs: number; failures: number }
  > = {};
  let retries = 0,
    interventions = 0,
    uatPassed = 0,
    uatFailed = 0;
  for (const task of tasks) {
    retries += retryAttempts(task);
    const history = [
      ...(task.archivedPhaseHistory ?? []),
      ...task.phaseHistory,
    ];
    for (const entry of history) {
      if (
        !["completed", "failed", "retried-from"].includes(entry.outcome) ||
        entry.phaseId === "review"
      )
        continue;
      const phase = (phases[entry.phaseId] ??= {
        runs: 0,
        durationMs: 0,
        failures: 0,
      });
      phase.runs++;
      if (entry.endedAt)
        phase.durationMs +=
          Math.max(
            0,
            Date.parse(entry.endedAt) - Date.parse(entry.startedAt),
          ) || 0;
      if (entry.outcome === "failed" || entry.outcome === "retried-from")
        phase.failures++;
    }
    interventions += history.filter(
      (e) => e.outcome === "gate-approved" || e.outcome === "gate-rejected",
    ).length;
    const uat = task.phaseProgress?.uat;
    if (uat?.status === "completed") uatPassed++;
    else if (uat?.status === "failed") uatFailed++;
  }
  return {
    range,
    total: tasks.length,
    completed: completed.length,
    failed: failed.length,
    successRate: terminal.length ? completed.length / terminal.length : null,
    totalDurationMs: durations.reduce((a, b) => a + b, 0),
    averageDurationMs: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
    retries,
    interventions,
    phases,
    uat: {
      passed: uatPassed,
      failed: uatFailed,
      passRate:
        uatPassed + uatFailed ? uatPassed / (uatPassed + uatFailed) : null,
    },
  };
}
