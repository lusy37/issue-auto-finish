import type { AIRunner } from '../ai-runner/index.js';
import { GitOperations } from '../git/GitOperations.js';
import { PlanPersistence } from '../persistence/PlanPersistence.js';
import { Config } from '../config.js';
import { PhaseNotRegisteredError, UnregisteredPhasesError } from '../errors/index.js';
import { BasePhase } from './BasePhase.js';
import { VerifyPhase } from './VerifyPhase.js';
import { PlanPhase } from './PlanPhase.js';
import { UatPhase } from './UatPhase.js';
import type { PhaseSessionStore } from './PhaseSessionStore.js';

type PhaseArgs = [AIRunner, GitOperations, PlanPersistence, Config, PhaseSessionStore?];
export type PhaseExecutor = Pick<BasePhase, 'phaseName' | 'run' | 'getResultFiles'>;
export type PhaseConstructor = new (...args: PhaseArgs) => PhaseExecutor;

// ---------------------------------------------------------------------------
// Phase Registry
// ---------------------------------------------------------------------------

const PHASE_REGISTRY = new Map<string, PhaseConstructor>();

/** 注册一个阶段构造器。重复注册同一 name 会覆盖。 */
export function registerPhase(name: string, ctor: PhaseConstructor): void {
  PHASE_REGISTRY.set(name, ctor);
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
  PHASE_REGISTRY.set('plan', PlanPhase);
  PHASE_REGISTRY.set('verify', VerifyPhase);
  PHASE_REGISTRY.set('uat', UatPhase);
}

registerBuiltinPhases();

// ---------------------------------------------------------------------------
// Factory / validation
// ---------------------------------------------------------------------------

export function createPhase(name: string, ...args: PhaseArgs): PhaseExecutor {
  const Ctor = PHASE_REGISTRY.get(name);
  if (!Ctor) {
    throw new PhaseNotRegisteredError(name, [...PHASE_REGISTRY.keys()]);
  }
  return new Ctor(...args);
}

/** 校验 PipelineDef 中的所有 AI phase 都已注册，应在启动时调用 */
export function validatePhaseRegistry(phaseNames: string[]): void {
  const missing = phaseNames.filter(name => !PHASE_REGISTRY.has(name));
  if (missing.length > 0) {
    throw new UnregisteredPhasesError(missing, [...PHASE_REGISTRY.keys()]);
  }
}
