import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DevServerManager } from '../../src/deploy/DevServerManager.js';
import type { WorktreeContext } from '../../src/git/WorktreeContext.js';

function makeWtCtx(number: number): WorktreeContext {
  return {
    gitRootDir: `/tmp/wt-${number}`,
    workDir: `/tmp/wt-${number}/app/project`,
    branchName: `feat/issue-${number}`,
    issueIid: number,
  };
}

describe('DevServerManager', () => {
  let manager: DevServerManager;

  beforeEach(() => {
    manager = new DevServerManager({
      healthCheckTimeoutMs: 5_000,
      healthCheckIntervalMs: 500,
    });
  });

  afterEach(() => {
    manager.stopAll();
  });

  it('getStatus returns not running for unstarted issue', () => {
    const status = manager.getStatus(1);
    expect(status.running).toBe(false);
    expect(status.ports).toBeUndefined();
  });

  it('getRunningIssues returns empty array initially', () => {
    expect(manager.getRunningIssues()).toEqual([]);
  });

  it('stopServers on non-existent issue is a no-op', () => {
    expect(() => manager.stopServers(999)).not.toThrow();
  });

  it('stopAll on empty manager is a no-op', () => {
    expect(() => manager.stopAll()).not.toThrow();
  });
});
