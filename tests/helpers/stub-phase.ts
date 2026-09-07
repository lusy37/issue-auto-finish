/**
 * StubPhase + PhaseScript — 编排调度层专用的轻量 Phase 替身。
 *
 * 不继承 BasePhase（避免拉入 AIRunner/Git/Plan 等依赖），
 * 仅实现编排器需要的 duck-type 接口。
 *
 * PR 2 注：返回类型已从 PhaseOutcome 迁移到 PhaseIntent。
 */
import type { PhaseContext } from '../../src/phases/BasePhase.js';
import type { PhaseCallbacks } from '../../src/phases/PhaseCallbacks.js';
import type { PhaseIntent } from '../../src/orchestration/Intent.js';
import type { GitOperations } from '../../src/git/GitOperations.js';

export interface PhaseCallBehavior {
  /** 正常返回的 PhaseIntent（部分字段即可，会与默认值合并） */
  result?: Partial<PhaseIntent> | PhaseIntent;
  /** 模拟阶段抛异常 */
  throws?: Error;
  /** run 被调用时的回调（用于断言 phaseCtx 内容如 fixContext） */
  onExecute?: (ctx: PhaseContext) => void;
}

const DEFAULT_SUCCESS: PhaseIntent = {
  kind: 'completed',
  output: 'stub ok',
  sessionId: 'stub-session',
};

/**
 * 轻量 Phase 替身，duck-type 兼容编排器的调用接口。
 */
export class StubPhase {
  readonly phaseName: string;
  readonly calls: PhaseContext[] = [];

  private behaviors: PhaseCallBehavior[];
  private callIdx = 0;

  constructor(name: string, behaviors: PhaseCallBehavior | PhaseCallBehavior[]) {
    this.phaseName = name;
    this.behaviors = Array.isArray(behaviors) ? behaviors : [behaviors];
  }

  setWtGitMap(_map: Map<string, GitOperations>): void {
    // no-op for stub
  }

  getResultFiles(): Array<{ filename: string; label: string }> {
    return [];
  }

  async run(ctx: PhaseContext, _callbacks?: PhaseCallbacks): Promise<PhaseIntent> {
    this.calls.push(JSON.parse(JSON.stringify(ctx)));

    const idx = Math.min(this.callIdx, this.behaviors.length - 1);
    this.callIdx++;
    const behavior = this.behaviors[idx];

    if (behavior.onExecute) {
      behavior.onExecute(ctx);
    }

    if (behavior.throws) {
      throw behavior.throws;
    }

    if (!behavior.result) return DEFAULT_SUCCESS;

    if ('kind' in behavior.result) return behavior.result as PhaseIntent;

    return { ...DEFAULT_SUCCESS, ...(behavior.result as Partial<PhaseIntent>) } as PhaseIntent;
  }
}

/**
 * PhaseScript — 声明式编排脚本。
 *
 * 用法（PR 2 之后）：
 * ```ts
 * const script = new PhaseScript()
 *   .on('plan', { result: { kind: 'completed', output: 'ok' } })
 *   .on('verify', [
 *     { result: { kind: 'requestRetryFrom', targetPhaseId: 'build', reason: 'verify-failed' } },
 *     { result: { kind: 'completed', output: 'all green' } },
 *   ]);
 * ```
 */
export class PhaseScript {
  private registry = new Map<string, StubPhase>();

  on(name: string, behavior: PhaseCallBehavior | PhaseCallBehavior[]): this {
    this.registry.set(name, new StubPhase(name, behavior));
    return this;
  }

  resolve(name: string, ..._args: unknown[]): StubPhase {
    const stub = this.registry.get(name);
    if (!stub) {
      throw new Error(`PhaseScript: no behavior registered for phase "${name}"`);
    }
    return stub;
  }

  getStub(name: string): StubPhase | undefined {
    return this.registry.get(name);
  }
}
