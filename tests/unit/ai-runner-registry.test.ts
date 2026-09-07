import { describe, it, expect } from 'vitest';
import {
  getRunnerCapabilities,
  isRegisteredRunner,
} from '../../src/ai-runner/AIRunnerRegistry.js';

describe('AIRunnerRegistry capabilities', () => {
  it('returns capabilities for registered runners', () => {
    expect(isRegisteredRunner('codex')).toBe(true);
    expect(isRegisteredRunner('cursor-agent')).toBe(false);
    expect(isRegisteredRunner('codebuddy')).toBe(false);
  });

  it('returns undefined for unregistered runner', () => {
    const caps = getRunnerCapabilities('nonexistent-runner');
    expect(caps).toBeUndefined();
  });
});
