import { PREVIEW_DEFAULTS } from '../shared/runtime/defaults.js';
import { waitForReadiness } from './readiness.js';
import { spawnProcess as spawn, stopProcess, type ManagedProcess } from '../utils/process.js';
import fs from 'node:fs';
import path from 'node:path';
import type { PortPair } from './PortAllocator.js';
import type { WorktreeContext } from '../git/WorktreeContext.js';
import { logger as rootLogger } from '../logger.js';
import { resolveDataDir } from '../paths.js';

const logger = rootLogger.child('DevServerManager');

interface ServerSet {
  startup: AbortController;
  ready: boolean;
  backend: ManagedProcess;
  frontend: ManagedProcess;
  ports: PortPair;
  workDir: string;
  startedAt: string;
  backendLog: fs.WriteStream;
  frontendLog: fs.WriteStream;
}

export interface DevServerManagerOptions {
  onProcessStarted?: (number: number, pid: number, workDir: string) => string;
  onProcessExited?: (number: number, callId: string) => void;
  startupTimeoutMs?: number;
  readinessIntervalMs?: number;
  backendReadyUrl?: string;
  frontendReadyUrl?: string;
  frontendDir?: string;
  backendCommand?: { bin: string; args: string[] };
  frontendCommand?: { bin: string; args: string[] };
}

const DEFAULT_OPTIONS: DevServerManagerOptions = {};

export class DevServerManager {
  private servers = new Map<number, ServerSet>();
  private starting = new Map<number, Promise<void>>();
  private startups = new Map<number, AbortController>();
  private stopping = new Map<number, Promise<void>>();
  async waitForStopped(issueIid: number): Promise<void> {
    await this.stopping.get(issueIid);
  }
  async stopAllAndWait(): Promise<void> {
    this.stopAll();
    await Promise.allSettled(this.starting.values());
    await Promise.all(this.stopping.values());
  }
  private options: DevServerManagerOptions;
  private logDir: string;

  constructor(options?: Partial<DevServerManagerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.logDir = path.join(resolveDataDir(), 'preview-logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  getLogPath(issueIid: number, type: 'backend' | 'frontend'): string | null {
    const filePath = path.join(this.logDir, `${issueIid}-${type}.log`);
    return fs.existsSync(filePath) ? filePath : null;
  }

  async startServers(wtCtx: WorktreeContext, ports: PortPair, signal?: AbortSignal): Promise<void> {
    const pending = this.starting.get(wtCtx.issueIid);
    if (pending) return pending;
    signal?.throwIfAborted();
    const startup = new AbortController();
    this.startups.set(wtCtx.issueIid, startup);
    const operation = this.start(
      wtCtx,
      ports,
      signal ? AbortSignal.any([signal, startup.signal]) : startup.signal,
    );
    this.starting.set(wtCtx.issueIid, operation);
    try {
      await operation;
    } finally {
      this.starting.delete(wtCtx.issueIid);
      this.startups.delete(wtCtx.issueIid);
    }
  }

  private async start(
    wtCtx: WorktreeContext,
    ports: PortPair,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.waitForStopped(wtCtx.issueIid);
    signal?.throwIfAborted();
    if (this.servers.has(wtCtx.issueIid)) {
      logger.info('Servers already running for issue', { issueIid: wtCtx.issueIid });
      return;
    }

    logger.info('Starting dev servers', { issueIid: wtCtx.issueIid, ...ports });

    const backendLogPath = path.join(this.logDir, `${wtCtx.issueIid}-backend.log`);
    const frontendLogPath = path.join(this.logDir, `${wtCtx.issueIid}-frontend.log`);
    const backendLog = fs.createWriteStream(backendLogPath, { flags: 'a' });
    const frontendLog = fs.createWriteStream(frontendLogPath, { flags: 'a' });

    const tsLine = (stream: string, data: Buffer) =>
      `[${new Date().toISOString()}] [${stream}] ${data.toString().trimEnd()}\n`;
    let backendOutput = '';
    let frontendOutput = '';
    const rememberOutput = (current: string, data: Buffer) =>
      (current + data.toString()).slice(-20_000);

    const backendEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PORT: String(ports.backendPort),
      E2E_PORT_OVERRIDE: '1',
      ENV_PATH: '.env.development.local',
    };

    let startupError: Error | undefined;
    const reportEarlyExit = (name: string, code: number | null, output: string) => {
      if (serverSet?.ready || serverSet?.startup.signal.aborted) return;
      startupError ??= new Error(
        `${name} 预览进程提前退出：退出码=${code ?? '信号终止'}\n${output}`,
      );
    };
    const backendCmd = this.options.backendCommand ?? { bin: 'npm', args: ['run', 'dev:backend'] };
    const backend = spawn(
      backendCmd.bin,
      backendCmd.args.map((a) => a.replaceAll('{port}', String(ports.backendPort))),
      {
        cwd: wtCtx.workDir,
        env: backendEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let backendCall: string | undefined;
    try {
      if (backend.pid)
        backendCall = this.options.onProcessStarted?.(wtCtx.issueIid, backend.pid, wtCtx.workDir);
    } catch (error) {
      await stopProcess(backend);
      await backend;
      backendLog.end();
      frontendLog.end();
      throw error;
    }
    void backend.then(() => {
      if (backendCall) {
        try {
          this.options.onProcessExited?.(wtCtx.issueIid, backendCall);
        } catch (error) {
          logger.error('预览退出凭证写入失败', { error: String(error) });
        }
      }
    });
    backend.nodeChildProcess.on('error', (error) => {
      startupError = error;
      this.stopServers(wtCtx.issueIid);
    });
    backend.nodeChildProcess.unref();
    backend.nodeChildProcess.stdout?.on('data', (data: Buffer) => {
      backendOutput = rememberOutput(backendOutput, data);
      if (!backendLog.writableEnded) backendLog.write(tsLine('stdout', data));
    });
    backend.nodeChildProcess.stderr?.on('data', (data: Buffer) => {
      backendOutput = rememberOutput(backendOutput, data);
      if (!backendLog.writableEnded) backendLog.write(tsLine('stderr', data));
    });
    backend.nodeChildProcess.on('exit', (code) => {
      logger.info('Backend process exited', { issueIid: wtCtx.issueIid, code });
      reportEarlyExit('后端', code, backendOutput);
      this.stopServers(wtCtx.issueIid);
    });

    const frontendDir = path.resolve(wtCtx.workDir, this.options.frontendDir ?? '.');
    const frontendEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      BACKEND_PORT: String(ports.backendPort),
      FRONTEND_PORT: String(ports.frontendPort),
      VITE_API_PORT: String(ports.backendPort),
    };

    const frontendCmd = this.options.frontendCommand ?? {
      bin: 'npm',
      args: ['run', 'dev:frontend', '--', '--port', String(ports.frontendPort)],
    };
    const frontend = spawn(
      frontendCmd.bin,
      frontendCmd.args.map((a) => a.replaceAll('{port}', String(ports.frontendPort))),
      {
        cwd: frontendDir,
        env: frontendEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let frontendCall: string | undefined;
    try {
      if (frontend.pid)
        frontendCall = this.options.onProcessStarted?.(wtCtx.issueIid, frontend.pid, frontendDir);
    } catch (error) {
      await Promise.allSettled([stopProcess(backend), stopProcess(frontend)]);
      await Promise.allSettled([backend, frontend]);
      backendLog.end();
      frontendLog.end();
      throw error;
    }
    void frontend.then(() => {
      if (frontendCall) {
        try {
          this.options.onProcessExited?.(wtCtx.issueIid, frontendCall);
        } catch (error) {
          logger.error('预览退出凭证写入失败', { error: String(error) });
        }
      }
    });
    frontend.nodeChildProcess.on('error', (error) => {
      startupError = error;
      this.stopServers(wtCtx.issueIid);
    });
    frontend.nodeChildProcess.unref();
    frontend.nodeChildProcess.stdout?.on('data', (data: Buffer) => {
      frontendOutput = rememberOutput(frontendOutput, data);
      if (!frontendLog.writableEnded) frontendLog.write(tsLine('stdout', data));
    });
    frontend.nodeChildProcess.stderr?.on('data', (data: Buffer) => {
      frontendOutput = rememberOutput(frontendOutput, data);
      if (!frontendLog.writableEnded) frontendLog.write(tsLine('stderr', data));
    });
    frontend.nodeChildProcess.on('exit', (code) => {
      logger.info('Frontend process exited', { issueIid: wtCtx.issueIid, code });
      reportEarlyExit('前端', code, frontendOutput);
      this.stopServers(wtCtx.issueIid);
    });

    const serverSet: ServerSet = {
      startup: new AbortController(),
      ready: false,
      backend,
      frontend,
      ports,
      workDir: wtCtx.workDir,
      startedAt: new Date().toISOString(),
      backendLog,
      frontendLog,
    };
    this.servers.set(wtCtx.issueIid, serverSet);
    logger.info('Dev servers spawned, waiting for startup', { issueIid: wtCtx.issueIid, ...ports });

    const startupSignal = signal
      ? AbortSignal.any([signal, serverSet.startup.signal])
      : serverSet.startup.signal;
    try {
      if (startupError) throw startupError;
      if (backend.nodeChildProcess.exitCode !== null || frontend.nodeChildProcess.exitCode !== null)
        throw new Error('预览进程已退出，请查看预览日志');
      await waitForReadiness(
        [
          { port: ports.backendPort, url: this.options.backendReadyUrl },
          { port: ports.frontendPort, url: this.options.frontendReadyUrl },
        ],
        this.options.startupTimeoutMs ?? PREVIEW_DEFAULTS.startupTimeoutMs,
        this.options.readinessIntervalMs ?? PREVIEW_DEFAULTS.readinessIntervalMs,
        startupSignal,
      );
      startupSignal.throwIfAborted();
      serverSet.ready = true;
      logger.info('预览服务已就绪', { issueIid: wtCtx.issueIid, ...ports });
    } catch (error) {
      this.stopServers(wtCtx.issueIid);
      await this.waitForStopped(wtCtx.issueIid);
      throw startupError ?? error;
    }
  }

  stopServers(issueIid: number): void {
    this.startups.get(issueIid)?.abort(new Error('预览启动已取消'));
    const set = this.servers.get(issueIid);
    if (!set) return;

    logger.info('Stopping dev servers', { issueIid, ports: set.ports });

    set.startup.abort(new Error('预览已停止或进程已退出，请查看预览日志'));
    set.backendLog.end();
    set.frontendLog.end();

    this.servers.delete(issueIid);
    const done = Promise.allSettled([stopProcess(set.backend), stopProcess(set.frontend)])
      .then(() => Promise.allSettled([set.backend, set.frontend]))
      .then(() => {
        this.stopping.delete(issueIid);
      });
    this.stopping.set(issueIid, done);
  }

  stopAll(): void {
    for (const number of new Set([...this.servers.keys(), ...this.startups.keys()])) {
      this.stopServers(number);
    }
  }

  getStatus(issueIid: number): { running: boolean; ports?: PortPair; startedAt?: string } {
    const set = this.servers.get(issueIid);
    if (!set) return { running: false };
    return {
      running:
        set.ready &&
        set.backend.nodeChildProcess.exitCode === null &&
        set.frontend.nodeChildProcess.exitCode === null,
      ports: set.ports,
      startedAt: set.startedAt,
    };
  }

  getRunningIssues(): number[] {
    return [...this.servers.keys()];
  }
}
