import { structuredPlanOutput } from './structured-plan.js';
/**
 * ScriptedAIRunner — 阶段功能层专用的可编程 AI Runner。
 *
 * 实现 AIRunner 接口，按调用序号返回不同结果，
 * 支持 stream event 模拟和副作用（如写产物文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AIRunner, RunOptions, RunResult, StreamEvent } from '../../src/ai-runner/index.js';

// ---------------------------------------------------------------------------
// Script types
// ---------------------------------------------------------------------------

export type SideEffect = ((options: RunOptions) => void | Promise<void>) & { artifact?: { filename: string; content: string } };

export interface AICallScript {
  /** 返回的 RunResult */
  result: RunResult;
  /** 模拟的 stream events（在返回结果前依次触发 onStreamEvent） */
  streamEvents?: StreamEvent[];
  /** 副作用回调（如写产物文件），在返回结果前执行 */
  sideEffect?: SideEffect;
  /** 模拟延迟（ms） */
  delayMs?: number;
  /** 声明式产物文件映射：相对于 .claude-plan/issue-{number}/ 的 { filename: content }。
   *  当 run() 被调用时自动写入 workDir 对应目录。需配合 issueIid 使用。 */
  artifacts?: Record<string, string>;
  /** 声明式 todolist 内容——写入 01-plan.md 中的 checkbox 列表，
   *  供 TodolistExtractor 消费。等效于 artifacts: { '01-plan.md': content } */
  todolistContent?: string;
}

// ---------------------------------------------------------------------------
// ScriptedAIRunner
// ---------------------------------------------------------------------------

export class ScriptedAIRunner implements AIRunner {
  private scripts: AICallScript[];
  private callIdx = 0;

  /** 记录所有 run() 调用的 options */
  readonly runCalls: RunOptions[] = [];
  /** 记录所有 killAll/killByWorkDir 调用 */
  readonly killCalls: Array<{ method: 'killAll' | 'killByWorkDir'; workDir?: string }> = [];

  constructor(scripts: AICallScript[]) {
    this.scripts = scripts;
  }

  async run(options: RunOptions): Promise<RunResult> {
    this.runCalls.push(options);

    if (this.callIdx >= this.scripts.length) {
      throw new Error(
        `ScriptedAIRunner: no more scripts. Got ${this.callIdx + 1} calls but only ${this.scripts.length} scripts.`,
      );
    }

    const script = this.scripts[this.callIdx];
    this.callIdx++;

    // Simulate delay
    if (script.delayMs && script.delayMs > 0) {
      await new Promise(r => setTimeout(r, script.delayMs));
    }

    // Emit stream events
    if (script.streamEvents && options.onStreamEvent) {
      for (const event of script.streamEvents) {
        options.onStreamEvent(event);
      }
    }

    let planText = script.todolistContent ?? script.artifacts?.['01-plan.md'];
    // Write declarative artifacts (requires issueIid extractable from workDir)
    if (script.artifacts) {
      const iidMatch = options.workDir.match(/issue-(\d+)/);
      const number = iidMatch ? parseInt(iidMatch[1], 10) : 0;
      const planDir = path.join(process.env.DATA_DIR!, 'issues', String(number), 'artifacts');
      fs.mkdirSync(planDir, { recursive: true });
      for (const [filename, content] of Object.entries(script.artifacts)) {
        if (options.mode === 'plan' && filename === '01-plan.md') continue;
        fs.writeFileSync(path.join(planDir, filename), content);
      }
    }

    // Write todolist as 01-plan.md artifact
    if (script.todolistContent && options.mode !== 'plan') {
      const iidMatch = options.workDir.match(/issue-(\d+)/);
      const number = iidMatch ? parseInt(iidMatch[1], 10) : 0;
      const planDir = path.join(process.env.DATA_DIR!, 'issues', String(number), 'artifacts');
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, '01-plan.md'), script.todolistContent);
    }

    // Execute side effect
    if (script.sideEffect) {
      await script.sideEffect(options);
    }

    planText ??= script.sideEffect?.artifact?.filename === '01-plan.md' ? script.sideEffect.artifact.content : undefined;
    const report = script.artifacts?.['02-verify-report.md'] ?? (script.sideEffect?.artifact?.filename === '02-verify-report.md' ? script.sideEffect.artifact.content : undefined);
    if (options.phaseName === 'verify' && report) return { ...script.result, output: report };
    if (options.mode === 'plan' && script.result.success && (planText || script.result.output.length >= 50)) {
      return { ...script.result, output: structuredPlanOutput(planText ?? script.result.output) };
    }
    return script.result;
  }

  killAll(): void {
    this.killCalls.push({ method: 'killAll' });
  }

  killByWorkDir(targetWorkDir: string): number {
    this.killCalls.push({ method: 'killByWorkDir', workDir: targetWorkDir });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Convenience factories
// ---------------------------------------------------------------------------

/** 创建一个成功脚本 */
export function successScript(
  overrides?: Partial<RunResult>,
  sideEffect?: SideEffect,
  extra?: Pick<AICallScript, 'artifacts' | 'todolistContent' | 'streamEvents'>,
): AICallScript {
  return {
    result: {
      success: true,
      output: 'AI completed successfully.',
      sessionId: 'scripted-session',
      exitCode: 0,
      ...overrides,
    },
    sideEffect,
    ...extra,
  };
}

/** 创建一个失败脚本 */
export function failureScript(
  errorMessage: string,
  overrides?: Partial<RunResult>,
): AICallScript {
  return {
    result: {
      success: false,
      output: '',
      errorMessage,
      exitCode: 1,
      ...overrides,
    },
  };
}

/** 创建一个超时脚本 */
export function timeoutScript(type: 'wall-clock' | 'idle'): AICallScript {
  return {
    result: {
      success: false,
      output: '',
      errorMessage: `AI runner timed out (${type})`,
      exitCode: null,
      timeoutType: type,
    },
  };
}

/**
 * 创建一个写产物文件的 SideEffect。
 *
 * 用于模拟 AI Agent 在 workDir 下写入 .claude-plan/issue-{number}/filename。
 * BasePhase.validatePhaseOutput 会检查这些文件。
 */
export function writeArtifact(
  issueIid: number,
  filename: string,
  content: string,
): SideEffect {
  return Object.assign((_options: RunOptions) => {
    const planDir = path.join(process.env.DATA_DIR!, 'issues', String(issueIid), 'artifacts');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, filename), content);
  }, { artifact: { filename, content } });
}
