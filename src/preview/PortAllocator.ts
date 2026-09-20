import { PREVIEW_DEFAULTS } from '../shared/runtime/defaults.js';
import net from 'node:net';
import { PortExhaustionError } from '../errors/index.js';
import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child('PortAllocator');

export interface PortPair {
  backendPort: number;
  frontendPort: number;
}

export interface PortAllocatorOptions {
  backendPortBase: number;
  frontendPortBase: number;
  maxPorts: number;
}

const DEFAULT_OPTIONS: PortAllocatorOptions = {
  backendPortBase: PREVIEW_DEFAULTS.backendPortBase,
  frontendPortBase: PREVIEW_DEFAULTS.frontendPortBase,
  maxPorts: PREVIEW_DEFAULTS.maxPorts,
};

async function checkPortAvailable(port: number): Promise<boolean> {
  // Windows 上通配地址可与回环地址复用端口，先检查真实连接，避免误分配正在服务的端口。
  const listening = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  if (listening) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

export class PortAllocator {
  private allocated = new Map<number, PortPair>();
  private options: PortAllocatorOptions;

  constructor(options?: Partial<PortAllocatorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async allocate(issueIid: number): Promise<PortPair> {
    const existing = this.allocated.get(issueIid);
    if (existing) {
      logger.info('Returning already allocated ports', { issueIid, ports: existing });
      return existing;
    }

    const usedBackend = new Set([...this.allocated.values()].map((p) => p.backendPort));
    const usedFrontend = new Set([...this.allocated.values()].map((p) => p.frontendPort));

    for (let offset = 1; offset <= this.options.maxPorts; offset++) {
      const backendPort = this.options.backendPortBase + offset;
      const frontendPort = this.options.frontendPortBase + offset;

      if (usedBackend.has(backendPort) || usedFrontend.has(frontendPort)) {
        continue;
      }

      const [beOk, feOk] = await Promise.all([
        checkPortAvailable(backendPort),
        checkPortAvailable(frontendPort),
      ]);

      if (beOk && feOk) {
        const pair: PortPair = { backendPort, frontendPort };
        this.allocated.set(issueIid, pair);
        logger.info('Ports allocated', { issueIid, ...pair });
        return pair;
      }

      logger.debug('Port pair unavailable, trying next', {
        backendPort,
        frontendPort,
        beOk,
        feOk,
      });
    }

    throw new PortExhaustionError(
      `No available port pair found for issue #${issueIid} ` +
      `(scanned ${this.options.maxPorts} offsets from ` +
      `backend=${this.options.backendPortBase} frontend=${this.options.frontendPortBase})`,
    );
  }

  release(issueIid: number): void {
    const pair = this.allocated.get(issueIid);
    if (pair) {
      this.allocated.delete(issueIid);
      logger.info('Ports released', { issueIid, ...pair });
    }
  }

  getPortsForIssue(issueIid: number): PortPair | undefined {
    return this.allocated.get(issueIid);
  }

  getAllAllocated(): Map<number, PortPair> {
    return new Map(this.allocated);
  }

  restore(issueIid: number, ports: PortPair): void {
    this.allocated.set(issueIid, ports);
    logger.info('Ports restored from persistence', { issueIid, ...ports });
  }
}
