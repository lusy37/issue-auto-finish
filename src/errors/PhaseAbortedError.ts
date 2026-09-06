import { AppError } from './BaseError.js';

/**
 * 用户主动中止/重做/重启阶段时抛出，中断 PhaseLoopStep 循环。
 *
 * 在 PipelineOrchestrator 的 catch 块中被特殊处理，
 * 不会进入 handleFailure 路径。
 */
export class PhaseAbortedError extends AppError {
  public readonly phaseName: string;
  public readonly action: 'abort' | 'redo' | 'restart';

  constructor(phaseName: string, action: 'abort' | 'redo' | 'restart') {
    super('PHASE_ABORTED', `Phase '${phaseName}' interrupted by user action '${action}'`);
    this.phaseName = phaseName;
    this.action = action;
  }
}
