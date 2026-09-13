import { describe, it, expect, beforeEach } from 'vitest';
import { PortAllocator } from '../../src/preview/PortAllocator.js';

describe('PortAllocator', () => {
  let allocator: PortAllocator;

  beforeEach(() => {
    allocator = new PortAllocator({
      backendPortBase: 14000,
      frontendPortBase: 19000,
      maxPorts: 10,
    });
  });

  it('allocates a unique port pair for an issue', async () => {
    const ports = await allocator.allocate(1);
    expect(ports.backendPort).toBeGreaterThan(14000);
    expect(ports.backendPort).toBeLessThanOrEqual(14010);
    expect(ports.frontendPort).toBeGreaterThan(19000);
    expect(ports.frontendPort).toBeLessThanOrEqual(19010);
  });

  it('returns the same ports for the same issue', async () => {
    const ports1 = await allocator.allocate(1);
    const ports2 = await allocator.allocate(1);
    expect(ports1).toEqual(ports2);
  });

  it('allocates different ports for different issues', async () => {
    const ports1 = await allocator.allocate(1);
    const ports2 = await allocator.allocate(2);
    expect(ports1.backendPort).not.toBe(ports2.backendPort);
    expect(ports1.frontendPort).not.toBe(ports2.frontendPort);
  });

  it('releases ports', async () => {
    const ports1 = await allocator.allocate(1);
    allocator.release(1);
    expect(allocator.getPortsForIssue(1)).toBeUndefined();

    const ports2 = await allocator.allocate(2);
    expect(ports2.backendPort).toBe(ports1.backendPort);
  });

  it('getPortsForIssue returns undefined for unallocated issue', () => {
    expect(allocator.getPortsForIssue(999)).toBeUndefined();
  });

  it('getAllAllocated returns all allocated ports', async () => {
    await allocator.allocate(1);
    await allocator.allocate(2);
    const all = allocator.getAllAllocated();
    expect(all.size).toBe(2);
    expect(all.has(1)).toBe(true);
    expect(all.has(2)).toBe(true);
  });

  it('restore adds ports without checking availability', () => {
    allocator.restore(99, { backendPort: 14005, frontendPort: 19005 });
    const ports = allocator.getPortsForIssue(99);
    expect(ports).toEqual({ backendPort: 14005, frontendPort: 19005 });
  });

  it('restore prevents duplicate allocation on restored ports', async () => {
    allocator.restore(99, { backendPort: 14001, frontendPort: 19001 });
    const ports = await allocator.allocate(100);
    expect(ports.backendPort).not.toBe(14001);
    expect(ports.frontendPort).not.toBe(19001);
  });

  it('release on non-existent issue is a no-op', () => {
    expect(() => allocator.release(999)).not.toThrow();
  });
});
