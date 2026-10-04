import type { AIRunner } from '../ai-runner/index.js';
import { GitOperations } from '../git/GitOperations.js';
import { PlanPersistence } from '../persistence/PlanPersistence.js';
import { Config } from '../config.js';
import { PhaseNotRegisteredError } from '../errors/index.js';
import { BasePhase } from './BasePhase.js';
import { VerifyPhase } from './VerifyPhase.js';
import { PlanPhase } from './PlanPhase.js';
import { UatPhase, type UatPhaseStore } from './UatPhase.js';
import type { PhaseSessionStore } from './PhaseSessionStore.js';

type PhaseArgs = [
  AIRunner, GitOperations, PlanPersistence, Config, (PhaseSessionStore & UatPhaseStore)?,
];
export type PhaseExecutor = Pick<BasePhase, 'phaseName' | 'run' | 'getResultFiles'>;
export type PhaseConstructor = new (...args: PhaseArgs) => PhaseExecutor;

// ---------------------------------------------------------------------------
// Phase Registry
// ---------------------------------------------------------------------------

const PHASE_REGISTRY = new Map<string, (...args: PhaseArgs) => PhaseExecutor>();

/** 注册一个阶段构造器。重复注册同一 name 会覆盖。 */
export function registerPhase(name: string, ctor: PhaseConstructor): void {
  PHASE_REGISTRY.set(name, (...args) => new ctor(...args));
}

/** 用于测试隔离：重置注册表并重新注册内置阶段 */
export function _resetPhaseRegistry(): void {
  PHASE_REGISTRY.clear();
  registerBuiltinPhases();
}

// ---------------------------------------------------------------------------
// Self-register built-in phases
// ---------------------------------------------------------------------------

function registerBuiltinPhases(): void {
  registerPhase('plan', PlanPhase);
  registerPhase('verify', VerifyPhase);
  PHASE_REGISTRY.set('uat', (runner, _git, plan, config, tracker) => {
    if (!tracker) throw new Error('UAT 阶段必须绑定运行存储');
    return new UatPhase(runner, plan, config, tracker);
  });
}

registerBuiltinPhases();

// ---------------------------------------------------------------------------
// Factory / validation
// ---------------------------------------------------------------------------

export function createPhase(name: string, ...args: PhaseArgs): PhaseExecutor {
  const create = PHASE_REGISTRY.get(name);
  if (!create) {
    throw new PhaseNotRegisteredError(name, [...PHASE_REGISTRY.keys()]);
  }
  return create(...args);
}
