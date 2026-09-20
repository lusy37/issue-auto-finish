import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { DevServerManager } from '../../src/preview/DevServerManager.js';

describe('DevServerManager', () => {
  let manager: DevServerManager;

  beforeEach(() => {
    manager = new DevServerManager({
      startupTimeoutMs: 5_000,
      readinessIntervalMs: 500,
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
