import fs from 'node:fs';
import path from 'node:path';
import { getIssueNumber } from '../tracker/IssueRecordHelper.js';
import { IssueState, type IssueRecord } from '../tracker/IssueState.js';
import { orchestrationStateSchema } from '../tracker/OrchestrationStateSchema.js';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';
import { PLAN_FORMAT, RUN_FORMAT, newIssueRun, planDigest, validatePlan, validateRun, type PlanContent, type TaskPlan } from './contracts.js';

/** 同步事务中不执行异步副作用；单实例事件循环保证计算及替换之间不能交错。 */
export class IssueRunStore {
  private readonly records = new Map<number, IssueRecord>();
  private readonly locked = new Set<number>();
  private readonly blocked = new Set<number>();
  readonly root: string;
  constructor(readonly dataDir: string, private readonly write = writeJsonAtomicSync) {
    this.root = path.join(dataDir, 'issues');
    const legacy = path.join(dataDir, 'tracker.json');
    if (fs.existsSync(legacy)) this.invalid(legacy, '旧任务格式不支持');
    if (!fs.existsSync(this.root)) return;
    for (const name of fs.readdirSync(this.root)) {
      if (!/^\d+$/.test(name)) continue;
      const file = this.file(Number(name));
      if (!fs.existsSync(file)) continue;
      const record = this.readRecord(Number(name));
      this.records.set(Number(name), record);
      if (record.run!.planRevision) {
        const plan = this.readPlan(Number(name), record.run!.planRevision, record.run!.planDigest);
        if (record.run!.review || Object.keys(record.run!.tasks).length) {
          const ids = plan.tasks.map(task => task.id).sort();
          if (JSON.stringify(ids) !== JSON.stringify(Object.keys(record.run!.tasks).sort())) this.invalid(file, '运行任务与不可变计划不一致');
        }
      }
    }
  }
  private invalid(file: string, reason: string): never {
    throw new Error(`${reason}：${file}。请配置新的 DATA_DIR，或归档该数据目录后重新初始化；原文件已保留。`);
  }
  file(number: number): string { return path.join(this.root, String(number), 'run.json'); }
  planFile(number: number, revision: number): string { return path.join(this.root, String(number), 'plans', `${revision}.json`); }
  private readRecord(number: number): IssueRecord {
    const file = this.file(number);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.format !== RUN_FORMAT || !value.record?.run || value.record.demandSpec?.sourceRef?.source !== 'github-issue' || getIssueNumber(value.record) !== number) this.invalid(file, '聚合状态格式无效');
      if (!Object.values(IssueState).includes(value.record.state)) this.invalid(file, '父 Issue 状态无效');
      if (!orchestrationStateSchema.safeParse(value.record.orchestrationState).success) this.invalid(file, '编排状态快照缺失或无效');
      validateRun(value.record.run, number);
      return value.record as IssueRecord;
    } catch (error) { return this.invalid(file, `无法读取聚合状态：${(error as Error).message}`); }
  }
  get(number: number): IssueRecord | undefined {
    const value = this.records.get(number);
    return value && structuredClone(value);
  }
  all(): IssueRecord[] { return [...this.records.values()].map(r => structuredClone(r)); }
  isBlocked(number: number): boolean { return this.blocked.has(number); }
  insert(number: number, record: IssueRecord): void {
    if (this.records.has(number)) throw new Error(`Issue #${number} 已存在`);
    this.persist(number, { ...structuredClone(record), run: record.run ?? newIssueRun() });
  }
  private persist(number: number, record: IssueRecord): void {
    if (this.blocked.has(number)) throw new Error(`Issue #${number} 持久化失败后已停止调度，请重启并检查状态文件`);
    record.run!.version++;
    record.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(this.file(number)), { recursive: true });
      this.write(this.file(number), { format: RUN_FORMAT, record });
    } catch (error) { this.blocked.add(number); throw error; }
    this.records.set(number, structuredClone(record));
  }
  transaction(number: number, update: (record: IssueRecord) => void): IssueRecord {
    if (this.locked.has(number)) throw new Error(`Issue #${number} 不允许嵌套事务`);
    if (this.blocked.has(number)) throw new Error(`Issue #${number} 的状态写入已阻断`);
    this.locked.add(number);
    try {
      // 磁盘是权威来源，避免以旧投影覆盖同时完成的另一个任务。
      const record = this.readRecord(number);
      update(record);
      this.persist(number, record);
      return structuredClone(record);
    } finally { this.locked.delete(number); }
  }
  replace(record: IssueRecord): void {
    const number = getIssueNumber(record);
    const saved = this.transaction(number, current => {
      if (current.run!.version !== record.run!.version) throw new Error('聚合状态版本冲突');
      Object.assign(current, structuredClone(record));
    });
    Object.assign(record, saved);
  }
  delete(number: number): boolean {
    if (!this.records.has(number)) return false;
    const record = this.get(number)!;
    if (Object.values(record.run!.calls).some(c => c.status !== 'exited')) throw new Error('调用尚未退出，不能删除任务状态');
    fs.renameSync(this.file(number), path.join(this.root, String(number), `archived-${Date.now()}.json`));
    this.records.delete(number);
    return true;
  }
  savePlan(number: number, content: PlanContent, expectedVersion: number): TaskPlan {
    const record = this.get(number)!;
    if (record.run!.version !== expectedVersion) throw new Error('生成计划期间状态已改变');
    const revision = record.run!.planRevision + 1;
    const base = { ...validatePlan(content), format: PLAN_FORMAT, issueNumber: number, revision, demand: structuredClone(record.demandSpec!), createdAt: new Date().toISOString() };
    const plan: TaskPlan = { ...base, digest: planDigest(base) };
    const file = this.planFile(number, revision);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 单实例同步创建，不覆盖崩溃遗留版本；下一次显式重新规划仍保持版本单调。
    let nextRevision = revision;
    while (fs.existsSync(this.planFile(number, nextRevision))) nextRevision++;
    plan.revision = nextRevision;
    const { digest: _digest, ...unsigned } = plan;
    plan.digest = planDigest(unsigned);
    this.write(this.planFile(number, nextRevision), plan);
    this.transaction(number, current => {
      if (current.run!.version !== expectedVersion || current.run!.stopIntent) throw new Error('生成计划期间执行身份已失效');
      const run = current.run!;
      if (Object.values(run.tasks).some(task => task.attemptNo > 0)) throw new Error('已执行任务的计划只能通过完整重做替换');
      if (run.planRevision) {
        run.budgetHistory ??= [];
        run.budgetHistory.push({ planRevision: run.planRevision, buildGeneration: run.buildGeneration, retryUsed: run.retryUsed, phaseExecutions: run.phaseExecutions, repairRounds: run.repairRounds });
      }
      run.retryUsed = {};
      run.phaseExecutions = {};
      run.repairRounds = 0;
      run.repairs = [];
      run.buildEntry = 'execute-graph';
      run.candidateCommit = undefined; run.verify = undefined; run.uat = undefined; run.integrationBase = undefined; run.integrationHead = undefined;
      current.run!.planRevision = plan.revision;
      current.run!.planDigest = plan.digest;
      current.run!.review = { revision: plan.revision, decision: 'waiting' };
      current.run!.tasks = Object.fromEntries(plan.tasks.map(t => [t.id, { taskId: t.id, status: 'pending', attemptNo: 0, conflictCallsUsed: 0 }]));
    });
    return plan;
  }
  readPlan(number: number, revision: number, digest?: string): TaskPlan {
    const file = this.planFile(number, revision);
    try {
      const plan: TaskPlan = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { digest: storedDigest, ...base } = plan;
      const { title, description, acceptanceCriteria, tasks } = plan;
      validatePlan({ title, description, acceptanceCriteria, tasks });
      if (plan.format !== PLAN_FORMAT || plan.issueNumber !== number || plan.revision !== revision || planDigest(base) !== storedDigest || (digest && digest !== storedDigest)) this.invalid(file, '计划引用或摘要无效');
      return plan;
    } catch (error) { return this.invalid(file, `无法读取计划版本：${(error as Error).message}`); }
  }
}
