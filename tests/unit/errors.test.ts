import { describe, it, expect } from 'vitest';
import {
  AppError,
  GitHubApiError,
  AIExecutionError,
  IssueNotFoundError,
  InvalidPhaseError,
  InvalidStateError,
  PortExhaustionError,
  SessionLimitError,
  ServiceShutdownError,
  AIOutputParseError,
  PhaseNotRegisteredError,
  RunnerNotRegisteredError,
  PipelineNotFoundError,
} from '../../src/errors/index.js';

describe('Error Type Hierarchy', () => {
  // ── Base class ───────────────────────────────────────────────────────

  describe('AppError', () => {
    it('sets name, code, message', () => {
      const err = new AppError('TEST_CODE', 'test message');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('AppError');
      expect(err.code).toBe('TEST_CODE');
      expect(err.message).toBe('test message');
    });

    it('preserves cause chain', () => {
      const cause = new Error('root cause');
      const err = new AppError('X', 'wrapper', cause);
      expect(err.cause).toBe(cause);
    });

    it('serializes via toJSON()', () => {
      const err = new AppError('CODE', 'msg', new Error('cause'));
      const json = err.toJSON();
      expect(json).toEqual({
        name: 'AppError',
        code: 'CODE',
        message: 'msg',
        cause: 'cause',
      });
    });

    it('omits cause in toJSON() when absent', () => {
      const err = new AppError('CODE', 'msg');
      expect(err.toJSON()).not.toHaveProperty('cause');
    });
  });

  // ── API errors ──────────────────────────────────────────────────────

  describe('GitHubApiError', () => {
    it('extends AppError with statusCode', () => {
      const err = new GitHubApiError(404, 'Not found', '{"error":"not found"}');
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('GITHUB_API_ERROR');
      expect(err.statusCode).toBe(404);
      expect(err.responseBody).toBe('{"error":"not found"}');
    });

    it('isRetryable for 5xx', () => {
      expect(new GitHubApiError(500, 'error').isRetryable).toBe(true);
      expect(new GitHubApiError(503, 'error').isRetryable).toBe(true);
      expect(new GitHubApiError(400, 'error').isRetryable).toBe(false);
      expect(new GitHubApiError(0, 'network error').isRetryable).toBe(true);
    });
  });

  // ── AI errors ───────────────────────────────────────────────────────

  describe('AIExecutionError', () => {
    it('extends AppError with phase and output', () => {
      const err = new AIExecutionError('build', 'Phase failed', {
        output: 'stderr content',
        exitCode: 1,
      });
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('AI_EXECUTION_ERROR');
      expect(err.phase).toBe('build');
      expect(err.output).toBe('stderr content');
      expect(err.exitCode).toBe(1);
    });
  });

  describe('AIOutputParseError', () => {
    it('extends AppError with rawOutput', () => {
      const err = new AIOutputParseError('Parse failed', 'raw...');
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('AI_OUTPUT_PARSE_ERROR');
      expect(err.rawOutput).toBe('raw...');
    });
  });

  // ── NotFound errors ─────────────────────────────────────────────────

  describe('NotFound errors', () => {
    it('IssueNotFoundError', () => {
      const err = new IssueNotFoundError(42);
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('ISSUE_NOT_FOUND');
      expect(err.issueIid).toBe(42);
      expect(err.message).toContain('42');
    });
  });

  // ── Invalid operation errors ────────────────────────────────────────

  describe('Invalid operation errors', () => {
    it('InvalidPhaseError', () => {
      const err = new InvalidPhaseError('badphase');
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('INVALID_PHASE');
      expect(err.phase).toBe('badphase');
    });

    it('InvalidStateError', () => {
      const err = new InvalidStateError('BAD');
      expect(err.code).toBe('INVALID_STATE');
      expect(err.state).toBe('BAD');
    });

    it('PortExhaustionError', () => {
      const err = new PortExhaustionError();
      expect(err.code).toBe('PORT_EXHAUSTION');
    });

    it('SessionLimitError', () => {
      const err = new SessionLimitError(100);
      expect(err.code).toBe('SESSION_LIMIT');
      expect(err.limit).toBe(100);
      expect(err.message).toContain('100');
    });
  });

  // ── Shutdown ────────────────────────────────────────────────────────

  describe('ServiceShutdownError', () => {
    it('extends AppError', () => {
      const err = new ServiceShutdownError();
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('SERVICE_SHUTDOWN');
      expect(err.message).toBe('Service shutting down');
    });
  });

  // ── Registry errors ─────────────────────────────────────────────────

  describe('Registry errors', () => {
    it('PhaseNotRegisteredError', () => {
      const err = new PhaseNotRegisteredError('foo', ['plan', 'build', 'verify']);
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe('PHASE_NOT_REGISTERED');
      expect(err.phaseName).toBe('foo');
      expect(err.registeredPhases).toEqual(['plan', 'build', 'verify']);
    });

    it('RunnerNotRegisteredError', () => {
      const err = new RunnerNotRegisteredError('bad-mode', ['codex']);
      expect(err.code).toBe('RUNNER_NOT_REGISTERED');
      expect(err.mode).toBe('bad-mode');
    });

    it('PipelineNotFoundError', () => {
      const err = new PipelineNotFoundError('xxx');
      expect(err.code).toBe('PIPELINE_NOT_FOUND');
      expect(err.pipelineMode).toBe('xxx');
    });

  });

  // ── instanceof checks across hierarchy ──────────────────────────────

  describe('instanceof hierarchy', () => {
    it('all custom errors are instanceof Error', () => {
      const errors = [
        new GitHubApiError(500, 'err'),
        new AIExecutionError('p', 'm'),
        new IssueNotFoundError(1),
        new InvalidPhaseError('p'),
        new ServiceShutdownError(),
        new AIOutputParseError('m'),
        new PhaseNotRegisteredError('n', []),
      ];
      for (const e of errors) {
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(AppError);
      }
    });
  });
});
