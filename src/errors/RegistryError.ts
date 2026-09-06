import { AppError } from './BaseError.js';

export class PhaseNotRegisteredError extends AppError {
  public readonly phaseName: string;
  public readonly registeredPhases: string[];
  constructor(phaseName: string, registeredPhases: string[]) {
    super(
      'PHASE_NOT_REGISTERED',
      `Unknown phase: ${phaseName}. Registered phases: ${registeredPhases.join(', ')}`,
    );
    this.phaseName = phaseName;
    this.registeredPhases = registeredPhases;
  }
}

export class RunnerNotRegisteredError extends AppError {
  public readonly mode: string;
  public readonly registeredModes: string[];
  constructor(mode: string, registeredModes: string[]) {
    super(
      'RUNNER_NOT_REGISTERED',
      `Unknown AI runner mode: ${mode}. Registered modes: ${registeredModes.join(', ')}`,
    );
    this.mode = mode;
    this.registeredModes = registeredModes;
  }
}

export class PipelineNotFoundError extends AppError {
  public readonly pipelineMode: string;
  constructor(pipelineMode: string) {
    super('PIPELINE_NOT_FOUND', `Unknown pipeline mode: ${pipelineMode}`);
    this.pipelineMode = pipelineMode;
  }
}

export class UnregisteredPhasesError extends AppError {
  public readonly missingPhases: string[];
  public readonly registeredPhases: string[];
  constructor(missingPhases: string[], registeredPhases: string[]) {
    super(
      'UNREGISTERED_PHASES',
      `Pipeline defines unregistered phases: ${missingPhases.join(', ')}. Registered: ${registeredPhases.join(', ')}`,
    );
    this.missingPhases = missingPhases;
    this.registeredPhases = registeredPhases;
  }
}
