import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 架构测试 — 编排不变量（INV-1, INV-2）
 *
 * 这些测试通过扫描源码强制保证架构不变量：
 * 1. 任何 Strategy / 编排器实现不能用 `spec.name === 'xxx'` 字面量做特化分支
 *    （应该用 transitions 表达，或在阶段内部决策）。
 * 2. 阶段类（src/phases/*.ts）不能引用 tracker / eventBus / github — 阶段必须纯逻辑。
 *
 * INV-3 由 TypeScript 类型层保证（discriminated union 编译期检查），见 contracts/intent-schema.test.ts。
 * INV-4 由 Orchestrator 单测保证（不写全局 registry）。
 * INV-5 / INV-6 由 pipeline-matrix.test.ts 保证。
 */

const projectRoot = path.resolve(__dirname, '../..');

interface SourceFile {
  readonly absPath: string;
  readonly relPath: string;
  readonly content: string;
}

function readSourceFiles(dirRel: string, extensions: readonly string[] = ['.ts']): SourceFile[] {
  const dir = path.resolve(projectRoot, dirRel);
  if (!fs.existsSync(dir)) return [];
  const result: SourceFile[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        result.push({
          absPath: full,
          relPath: path.relative(projectRoot, full),
          content: fs.readFileSync(full, 'utf-8'),
        });
      }
    }
  }
  return result;
}

describe('Architecture: no phase-name switch (INV-1)', () => {
  it('编排器与 Strategy 实现不能含有 spec.name === / spec.id === phase 字面量比较', () => {
    const files = [
      ...readSourceFiles('src/orchestration'),
    ];

    const PHASE_NAMES = ['plan', 'review', 'build', 'verify', 'uat', 'release'];
    const violations: Array<{ file: string; line: string }> = [];

    for (const file of files) {
      // 跳过 Transitions.ts —— transitions 规则本来就是按阶段名声明的
      if (file.relPath.endsWith('Transitions.ts')) continue;

      const lines = file.content.split('\n');
      lines.forEach((line, idx) => {
        // 排除注释行
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

        for (const phaseName of PHASE_NAMES) {
          // 模式：spec.name === 'xxx' 或 spec.id === 'xxx'
          const re = new RegExp(`\\b(spec|phase|phaseSpec)\\.(name|id)\\s*===\\s*['"\`]${phaseName}['"\`]`);
          if (re.test(line)) {
            violations.push({ file: file.relPath, line: `${idx + 1}: ${line.trim()}` });
          }
        }
      });
    }

    expect(violations, `Found phase-name switch violations:\n${violations.map((v) => `  ${v.file}:${v.line}`).join('\n')}`).toEqual([]);
  });
});

describe('Architecture: phases are pure (INV-2)', () => {
  it('编排核心 src/orchestration/* 不能引用 tracker / eventBus / github / git / wtPlan', () => {
    const files = readSourceFiles('src/orchestration');

    const FORBIDDEN_IMPORTS = [
      'IssueTracker',
      'eventBus',
      'GitHubClient',
      'GitOperations',
      'PlanPersistence',
    ];

    const violations: Array<{ file: string; offender: string }> = [];

    for (const file of files) {
      for (const offender of FORBIDDEN_IMPORTS) {
        // 模式：from '...' 这一行包含 offender，或 import { offender } from
        const importRe = new RegExp(`import\\s+(type\\s+)?[^;]*\\b${offender}\\b[^;]*from`);
        if (importRe.test(file.content)) {
          violations.push({ file: file.relPath, offender });
        }
      }
    }

    expect(violations, `Found forbidden imports in orchestration core:\n${violations.map((v) => `  ${v.file}: ${v.offender}`).join('\n')}`).toEqual([]);
  });
});
