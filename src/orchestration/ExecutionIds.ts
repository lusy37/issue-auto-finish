import { PHASE_IDS, type PhaseId } from './WorkflowState.js';

const PHASE_CALL_PREFIX = '$phase:';

export function phaseCallId(phase: PhaseId): string {
  return PHASE_CALL_PREFIX + phase;
}

export function parsePhaseCallId(value: string): PhaseId | undefined {
  if (!value.startsWith(PHASE_CALL_PREFIX)) return undefined;
  const phase = value.slice(PHASE_CALL_PREFIX.length);
  const matched = PHASE_IDS.find((id) => id === phase);
  if (!matched) throw new Error(`未知阶段调用标识：${value}`);
  return matched;
}
