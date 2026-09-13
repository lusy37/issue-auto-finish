import { describe, it, expect } from 'vitest';
import { IssueState } from '../../src/tracker/IssueState.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import { ActionLifecycleManager } from '../../src/lifecycle/ActionLifecycleManager.js';

const OLD_TERMINAL_STATES = new Set([IssueState.Completed, IssueState.Failed, IssueState.Skipped, IssueState.Cancelled, IssueState.Deployed]);

const allStates = Object.values(IssueState) as IssueState[];

describe('ActionLifecycleManager', () => {
  describe('plan-mode pipeline', () => {
    const lm = new ActionLifecycleManager(PLAN_MODE_PIPELINE);

    describe('resolve', () => {
      it('maps Pending to init:idle', () => {
        expect(lm.resolve(IssueState.Pending))
          .toEqual({ action: 'init', status: 'idle' });
      });

      it('maps BranchCreated to init:ready', () => {
        expect(lm.resolve(IssueState.BranchCreated))
          .toEqual({ action: 'init', status: 'ready' });
      });

      it('maps PhaseRunning + plan to plan:running', () => {
        expect(lm.resolve(IssueState.PhaseRunning, 'plan'))
          .toEqual({ action: 'plan', status: 'running' });
      });

      it('maps PhaseDone + plan to plan:ready', () => {
        expect(lm.resolve(IssueState.PhaseDone, 'plan'))
          .toEqual({ action: 'plan', status: 'ready' });
      });

      it('maps PhaseWaiting + review to review:waiting', () => {
        expect(lm.resolve(IssueState.PhaseWaiting, 'review'))
          .toEqual({ action: 'review', status: 'waiting' });
      });

      it('maps PhaseApproved + review to review:ready', () => {
        expect(lm.resolve(IssueState.PhaseApproved, 'review'))
          .toEqual({ action: 'review', status: 'ready' });
      });

      it('maps PhaseRunning + build to build:running', () => {
        expect(lm.resolve(IssueState.PhaseRunning, 'build'))
          .toEqual({ action: 'build', status: 'running' });
      });

      it('maps PhaseDone + build to build:ready', () => {
        expect(lm.resolve(IssueState.PhaseDone, 'build'))
          .toEqual({ action: 'build', status: 'ready' });
      });

      it('maps Completed to verify:done', () => {
        expect(lm.resolve(IssueState.Completed))
          .toEqual({ action: 'verify', status: 'done' });
      });

      it('maps Failed to init:failed', () => {
        expect(lm.resolve(IssueState.Failed))
          .toEqual({ action: 'init', status: 'failed' });
      });

      it('maps Skipped to init:skipped', () => {
        expect(lm.resolve(IssueState.Skipped))
          .toEqual({ action: 'init', status: 'skipped' });
      });

      it('maps ResolvingConflict to conflict:running', () => {
        expect(lm.resolve(IssueState.ResolvingConflict))
          .toEqual({ action: 'conflict', status: 'running' });
      });
    });

    describe('isTerminal', () => {
      for (const state of allStates) {
        it(`${state}: isTerminal=${OLD_TERMINAL_STATES.has(state)}`, () => {
          expect(lm.isTerminal(state)).toBe(OLD_TERMINAL_STATES.has(state));
        });
      }
    });

    describe('isInProgress', () => {
      it('PhaseRunning is in-progress', () => {
        expect(lm.isInProgress(IssueState.PhaseRunning)).toBe(true);
      });

      it('ResolvingConflict is in-progress', () => {
        expect(lm.isInProgress(IssueState.ResolvingConflict)).toBe(true);
      });

      it('PhaseWaiting is NOT in-progress', () => {
        expect(lm.isInProgress(IssueState.PhaseWaiting)).toBe(false);
      });

      it('PhaseDone is NOT in-progress', () => {
        expect(lm.isInProgress(IssueState.PhaseDone)).toBe(false);
      });

      it('Pending is NOT in-progress', () => {
        expect(lm.isInProgress(IssueState.Pending)).toBe(false);
      });

      it('Completed is NOT in-progress', () => {
        expect(lm.isInProgress(IssueState.Completed)).toBe(false);
      });
    });

    describe('isBlocked', () => {
      it('PhaseWaiting is blocked', () => {
        expect(lm.isBlocked(IssueState.PhaseWaiting)).toBe(true);
      });
      it('other states are not blocked', () => {
        expect(lm.isBlocked(IssueState.PhaseRunning)).toBe(false);
        expect(lm.isBlocked(IssueState.Completed)).toBe(false);
        expect(lm.isBlocked(IssueState.Failed)).toBe(false);
      });
    });

    describe('isDrivable — plan-mode', () => {
      const maxRetries = 3;

      it('Pending is drivable', () => {
        expect(lm.isDrivable(IssueState.Pending, 0, maxRetries)).toBe(true);
      });

      it('BranchCreated is drivable', () => {
        expect(lm.isDrivable(IssueState.BranchCreated, 0, maxRetries)).toBe(true);
      });

      it('PhaseApproved is drivable', () => {
        expect(lm.isDrivable(IssueState.PhaseApproved, 0, maxRetries)).toBe(true);
      });

      it('PhaseDone is drivable', () => {
        expect(lm.isDrivable(IssueState.PhaseDone, 0, maxRetries)).toBe(true);
      });

      it('PhaseWaiting is NOT drivable', () => {
        expect(lm.isDrivable(IssueState.PhaseWaiting, 0, maxRetries)).toBe(false);
      });

      it('Failed is drivable under retry limit', () => {
        expect(lm.isDrivable(IssueState.Failed, 2, maxRetries)).toBe(true);
      });

      it('Failed is NOT drivable at retry limit', () => {
        expect(lm.isDrivable(IssueState.Failed, 3, maxRetries)).toBe(false);
      });

      it('Completed is NOT drivable', () => {
        expect(lm.isDrivable(IssueState.Completed, 0, maxRetries)).toBe(false);
      });
    });

    describe('getPhasePreState', () => {
      it('plan → BranchCreated', () => {
        expect(lm.getPhasePreState('plan')).toBe(IssueState.BranchCreated);
      });

      it('review → PhaseDone (prev=plan)', () => {
        expect(lm.getPhasePreState('review')).toBe(IssueState.PhaseDone);
      });

      it('build → PhaseApproved (prev=review gate)', () => {
        expect(lm.getPhasePreState('build')).toBe(IssueState.PhaseApproved);
      });

      it('verify → PhaseDone (prev=build)', () => {
        expect(lm.getPhasePreState('verify')).toBe(IssueState.PhaseDone);
      });

      it('returns undefined for unknown phase', () => {
        expect(lm.getPhasePreState('nonexistent')).toBeUndefined();
      });
    });

    describe('getPhaseStates', () => {
      it('returns correct states for review gate', () => {
        expect(lm.getPhaseStates('review')).toEqual({
          startState: IssueState.PhaseWaiting,
          doneState: IssueState.PhaseApproved,
          approvedState: IssueState.PhaseApproved,
        });
      });

      it('returns correct states for build', () => {
        expect(lm.getPhaseStates('build')).toEqual({
          startState: IssueState.PhaseRunning,
          doneState: IssueState.PhaseDone,
          approvedState: undefined,
        });
      });

      it('returns correct states for plan', () => {
        expect(lm.getPhaseStates('plan')).toEqual({
          startState: IssueState.PhaseRunning,
          doneState: IssueState.PhaseDone,
          approvedState: undefined,
        });
      });

      it('returns correct states for verify', () => {
        expect(lm.getPhaseStates('verify')).toEqual({
          startState: IssueState.PhaseRunning,
          doneState: IssueState.Completed,
          approvedState: undefined,
        });
      });

      it('returns undefined for unknown phase', () => {
        expect(lm.getPhaseStates('nonexistent')).toBeUndefined();
      });
    });

    describe('collectStateLabels', () => {
      it('produces composite keys for generic phases', () => {
        const labels = lm.collectStateLabels();
        expect(labels.has('phase_running:plan')).toBe(true);
        expect(labels.has('phase_done:plan')).toBe(true);
        expect(labels.has('phase_running:build')).toBe(true);
        expect(labels.has('phase_done:build')).toBe(true);
        // gate uses generic PhaseWaiting/PhaseApproved → composite keys
        expect(labels.has('phase_waiting:review')).toBe(true);
        expect(labels.has('phase_approved:review')).toBe(true);
      });
    });

    describe('derivePhaseStatuses', () => {
      it('PhaseRunning + plan → plan in_progress, rest pending', () => {
        const result = lm.derivePhaseStatuses(IssueState.PhaseRunning, 'plan');
        expect(result).toEqual({
          plan: 'in_progress',
          review: 'pending',
          build: 'pending',
          verify: 'pending',
        });
      });

      it('PhaseWaiting + review → plan completed, review in_progress (gate startState)', () => {
        const result = lm.derivePhaseStatuses(IssueState.PhaseWaiting, 'review');
        expect(result.plan).toBe('completed');
        expect(result.review).toBe('in_progress');
      });

      it('Completed → all completed', () => {
        const result = lm.derivePhaseStatuses(IssueState.Completed);
        expect(result).toEqual({
          plan: 'completed',
          review: 'completed',
          build: 'completed',
          verify: 'completed',
        });
      });

      it('Pending → all pending', () => {
        const result = lm.derivePhaseStatuses(IssueState.Pending);
        expect(result).toEqual({
          plan: 'pending',
          review: 'pending',
          build: 'pending',
          verify: 'pending',
        });
      });

      it('Skipped → all pending', () => {
        const result = lm.derivePhaseStatuses(IssueState.Skipped);
        expect(result).toEqual({
          plan: 'pending',
          review: 'pending',
          build: 'pending',
          verify: 'pending',
        });
      });

      it('BranchCreated → all pending', () => {
        const result = lm.derivePhaseStatuses(IssueState.BranchCreated);
        expect(result).toEqual({
          plan: 'pending',
          review: 'pending',
          build: 'pending',
          verify: 'pending',
        });
      });

      it('Failed → all pending', () => {
        const result = lm.derivePhaseStatuses(IssueState.Failed);
        expect(result).toEqual({
          plan: 'pending',
          review: 'pending',
          build: 'pending',
          verify: 'pending',
        });
      });

      it('ResolvingConflict → all completed', () => {
        const result = lm.derivePhaseStatuses(IssueState.ResolvingConflict);
        expect(result).toEqual({
          plan: 'completed',
          review: 'completed',
          build: 'completed',
          verify: 'completed',
        });
      });
    });
  });

  // ─── Pipeline Protocol query methods ───

  describe('Pipeline Protocol queries — plan-mode', () => {
    const lm = new ActionLifecycleManager(PLAN_MODE_PIPELINE);

    it('getRetryablePhases excludes review gate', () => {
      expect(lm.getRetryablePhases()).toEqual(['plan', 'build', 'verify']);
    });

    it('isRetryable returns false for review gate', () => {
      expect(lm.isRetryable('review')).toBe(false);
    });

    it('isRetryable returns true for ai phases', () => {
      expect(lm.isRetryable('plan')).toBe(true);
      expect(lm.isRetryable('build')).toBe(true);
      expect(lm.isRetryable('verify')).toBe(true);
    });

    it('isRetryable returns false for unknown phases', () => {
      expect(lm.isRetryable('nonexistent')).toBe(false);
    });

    it('getGatePhase returns review gate spec', () => {
      const gate = lm.getGatePhase();
      expect(gate).toBeDefined();
      expect(gate!.name).toBe('review');
      expect(gate!.kind).toBe('gate');
    });

    it('shouldDeployPreview is true for build', () => {
      expect(lm.shouldDeployPreview('build')).toBe(true);
    });

    it('shouldDeployPreview is false for non-deploy phases', () => {
      expect(lm.shouldDeployPreview('plan')).toBe(false);
      expect(lm.shouldDeployPreview('verify')).toBe(false);
    });

    it('collectArtifacts returns plan-mode artifacts', () => {
      const artifacts = lm.collectArtifacts();
      expect(artifacts.map(a => a.filename)).toEqual([
        '01-plan.md',
        'review-feedback.md', 'review-history.json',
        '02-verify-report.md',
      ]);
    });

    it('getExecutablePhaseNames excludes gate', () => {
      expect(lm.getExecutablePhaseNames()).toEqual(['plan', 'build', 'verify']);
    });
  });
});
