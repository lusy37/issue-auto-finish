import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPhase, registerPhase, _resetPhaseRegistry } from '../../src/phases/PhaseFactory.js';
import { VerifyPhase } from '../../src/phases/VerifyPhase.js';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { BuildPhase } from '../../src/phases/BuildPhase.js';
import {
  createMockAIRunner,
  createMockGitOperations,
  createTestConfig,
} from '../helpers/mock-factories.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';

describe('PhaseFactory', () => {
  beforeEach(() => {
    _resetPhaseRegistry();
  });

  afterEach(() => {
    _resetPhaseRegistry();
  });

  const planModeArgs = [
    createMockAIRunner(),
    createMockGitOperations(),
    new PlanPersistence('/tmp/test', 1),
    createTestConfig(),
  ] as any;

  it('creates PlanPhase', () => {
    expect(createPhase('plan', ...planModeArgs)).toBeInstanceOf(PlanPhase);
  });

  it('creates BuildPhase', () => {
    expect(createPhase('build', ...planModeArgs)).toBeInstanceOf(BuildPhase);
  });

  it('creates VerifyPhase', () => {
    expect(createPhase('verify', ...planModeArgs)).toBeInstanceOf(VerifyPhase);
  });

  it('throws for unknown phase', () => {
    expect(() => createPhase('unknown', ...planModeArgs)).toThrow('Unknown phase: unknown');
  });

  describe('registerPhase', () => {
    it('allows registering a custom phase and creating it', () => {
      registerPhase('custom-phase', PlanPhase);
      expect(createPhase('custom-phase', ...planModeArgs)).toBeInstanceOf(PlanPhase);
    });

    it('overwrites an existing registration', () => {
      registerPhase('plan', BuildPhase);
      expect(createPhase('plan', ...planModeArgs)).toBeInstanceOf(BuildPhase);
    });
  });
});
