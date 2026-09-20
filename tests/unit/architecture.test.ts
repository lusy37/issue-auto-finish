import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '../../src');

// ---------------------------------------------------------------------------
// Helper: parse imports from a TypeScript/Vue file
// ---------------------------------------------------------------------------

/**
 * 从文件内容中解析所有 import 语句的模块路径。
 * 支持 ESM static import、dynamic import() 和 require()。
 */
function parseDependencies(filePath: string): string[] {
  let content = fs.readFileSync(filePath, 'utf-8');

  // 对 .vue 文件，只提取 <script> 段的内容
  if (filePath.endsWith('.vue')) {
    const scriptBlocks: string[] = [];
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRegex.exec(content)) !== null) {
      scriptBlocks.push(m[1]);
    }
    content = scriptBlocks.join('\n');
  }

  const deps: string[] = [];

  // 匹配 static import：
  //   import ... from 'xxx'
  //   import 'xxx'  (side-effect import)
  //   import type ... from 'xxx'
  // 使用 multiline 模式处理跨行导入
  //
  // 1) Side-effect imports: import 'xxx' / import "xxx"
  const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = sideEffectRegex.exec(content)) !== null) {
    deps.push(match[1]);
  }

  // 2) Named/default/type imports: import ... from 'xxx'
  const namedImportRegex = /import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = namedImportRegex.exec(content)) !== null) {
    // Avoid duplicates if sideEffectRegex already matched
    if (!deps.includes(match[1])) {
      deps.push(match[1]);
    }
  }

  // 匹配 dynamic import: import('xxx') / await import('xxx')
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    deps.push(match[1]);
  }

  // 匹配 require('xxx')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    deps.push(match[1]);
  }

  return deps;
}

// ---------------------------------------------------------------------------
// Helper: 递归获取 TypeScript 文件
// ---------------------------------------------------------------------------

function getTypeScriptFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx')),
    )
    .map((e) => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

function getAllFiles(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && exts.some((ext) => e.name.endsWith(ext)))
    .map((e) => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

// ---------------------------------------------------------------------------
// Helper: 判断一个 import 路径是否解析到目标模块目录
// ---------------------------------------------------------------------------

/**
 * 判断相对导入是否指向 src 下的指定模块目录。
 * 例如：文件 src/phases/Foo.ts 中的 '../tracker/Bar.js'
 *       会被解析为指向 src/tracker/ 目录。
 */
function depResolvesToModule(
  sourceFile: string,
  dep: string,
  targetModuleName: string,
): boolean {
  // 只检查相对路径（以 . 开头的导入）
  if (!dep.startsWith('.')) return false;

  const resolved = path.resolve(path.dirname(sourceFile), dep);
  const targetDir = path.join(SRC_DIR, targetModuleName);

  // 检查解析后的路径是否在目标模块目录下
  // 使用 normalize 后加 path.sep 确保精确匹配目录（如不会把 'tracker-utils' 误匹配为 'tracker'）
  return resolved.startsWith(targetDir + path.sep) || resolved === targetDir;
}

// ---------------------------------------------------------------------------
// Helper: 查找违规导入
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  dep: string;
}

function findViolatingImports(
  files: string[],
  targetModule: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const deps = parseDependencies(file);
    for (const dep of deps) {
      if (depResolvesToModule(file, dep, targetModule)) {
        violations.push({ file: path.relative(SRC_DIR, file), dep });
      }
    }
  }
  return violations;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  ${v.file} → ${v.dep}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Architecture Guard Tests
// ---------------------------------------------------------------------------

describe('Architecture Guards', () => {
  // ─── Rule 1 ──────────────────────────────────────────────────────────
  // phases/ 不应直接导入 tracker/
  it('phases/ does not import from tracker/', () => {
    const phaseFiles = getTypeScriptFiles(path.join(SRC_DIR, 'phases'));
    const violations = findViolatingImports(phaseFiles, 'tracker');

    expect(
      violations,
      `发现 phases/ → tracker/ 导入:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 2 ──────────────────────────────────────────────────────────
  // phases/ 不应导入 clients/（通过 hooks 间接调用）
  it('phases/ does not import from clients/', () => {
    const phaseFiles = getTypeScriptFiles(path.join(SRC_DIR, 'phases'));
    const violations = findViolatingImports(phaseFiles, 'clients');

    expect(
      violations,
      `发现 phases/ → clients/ 的违规导入:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 3 ──────────────────────────────────────────────────────────
  // ai-runner/ 不应导入 orchestrator/（下层不依赖上层）
  it('ai-runner/ does not import from orchestrator/', () => {
    const runnerFiles = getTypeScriptFiles(path.join(SRC_DIR, 'ai-runner'));
    const violations = findViolatingImports(runnerFiles, 'orchestrator');

    expect(
      violations,
      `发现 ai-runner/ → orchestrator/ 的违规导入:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 4 ──────────────────────────────────────────────────────────
  // tracker/ 不应导入 orchestrator/（数据层不依赖编排层）
  it('tracker/ does not import from orchestrator/', () => {
    const trackerFiles = getTypeScriptFiles(path.join(SRC_DIR, 'tracker'));
    const violations = findViolatingImports(trackerFiles, 'orchestrator');

    expect(
      violations,
      `发现 tracker/ → orchestrator/ 的违规导入:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 5 ──────────────────────────────────────────────────────────
  // errors/ 应该是自包含的——只允许内部互引、node: 内置和外部包
  it('errors/ does not import internal modules', () => {
    const errorsDir = path.join(SRC_DIR, 'errors');
    if (!fs.existsSync(errorsDir)) {
      return; // errors/ 还未创建，跳过
    }

    const errorFiles = getTypeScriptFiles(errorsDir);
    const violations: Violation[] = [];

    for (const file of errorFiles) {
      const deps = parseDependencies(file);
      for (const dep of deps) {
        const isNodeBuiltin = dep.startsWith('node:');
        const isExternalPackage = !dep.startsWith('.') && !dep.startsWith('/');
        const isRelative = dep.startsWith('./') || dep.startsWith('../');

        if (isNodeBuiltin || isExternalPackage) {
          // node: 内置和外部包允许
          continue;
        }

        if (isRelative) {
          // 相对导入：必须解析到 errors/ 目录内部
          const resolved = path.resolve(path.dirname(file), dep);
          // 去掉 .js 后缀以匹配 .ts 源文件所在目录
          const resolvedDir = path.dirname(resolved);
          const isWithinErrors =
            resolved.startsWith(errorsDir + path.sep) ||
            resolved === errorsDir ||
            resolvedDir.startsWith(errorsDir);
          if (!isWithinErrors) {
            violations.push({
              file: path.relative(SRC_DIR, file),
              dep,
            });
          }
        }
      }
    }

    expect(
      violations,
      `errors/ 导入了外部内部模块:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 6 ──────────────────────────────────────────────────────────
  // web/frontend/ 不应导入后端 src/ 代码
  it('共享类型契约不包含运行时代码', () => {
    const runtimeDir = path.join(SRC_DIR, 'shared', 'runtime') + path.sep;
    for (const file of getTypeScriptFiles(path.join(SRC_DIR, 'shared')).filter(file => !file.startsWith(runtimeDir))) {
      const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const invalid = ast.statements.filter(statement => !(
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(statement) && statement.isTypeOnly)
      ));
      expect(invalid.map(statement => statement.getText(ast)), file).toEqual([]);
    }
  });

  it('共享运行模块不依赖 Node、第三方包或服务端实现', () => {
    for (const file of getTypeScriptFiles(path.join(SRC_DIR, 'shared', 'runtime'))) {
      const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const dependencies = parseDependencies(file);
      for (const statement of ast.statements) {
        if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          dependencies.push(statement.moduleSpecifier.text);
        }
      }
      const invalid = dependencies.filter(dep => !depResolvesToModule(file, dep, path.join('shared', 'runtime')));
      expect(invalid, file).toEqual([]);
    }
  });

  it('web/frontend/ does not import backend src/ code', () => {
    const frontendDir = path.join(SRC_DIR, 'web', 'frontend');
    if (!fs.existsSync(frontendDir)) {
      return;
    }

    const frontendSrcDir = path.join(frontendDir, 'src');
    const tsFiles = getTypeScriptFiles(frontendSrcDir);
    const vueFiles = getAllFiles(frontendSrcDir, ['.vue']);
    const allFiles = [...tsFiles, ...vueFiles];

    const violations: Violation[] = [];

    for (const file of allFiles) {
      const deps = parseDependencies(file);
      for (const dep of deps) {
        // 跳过路径别名 (@/) 和外部包——这些不会指向后端代码
        if (!dep.startsWith('.') && !dep.startsWith('/')) continue;

        const resolved = path.resolve(path.dirname(file), dep);

        // 允许导入 web/ 目录下的任何内容
        const webDir = path.join(SRC_DIR, 'web');
        const isWithinWeb =
          resolved.startsWith(webDir + path.sep) || resolved === webDir;

        // 纯共享运行模块允许值导入；其他共享契约仍只允许显式类型导入。
        const sharedDir = path.join(SRC_DIR, 'shared');
        const isShared = resolved.startsWith(sharedDir + path.sep);
        const isSharedRuntime = resolved.startsWith(path.join(sharedDir, 'runtime') + path.sep);
        if (isWithinWeb || isSharedRuntime) continue;
        if (!isShared) { violations.push({file:path.relative(SRC_DIR,file),dep}); continue; }
        const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const references = ast.statements.filter(statement =>
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === dep);
        const onlyTypes = references.length > 0 && references.every(statement =>
          ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : ts.isExportDeclaration(statement) && statement.isTypeOnly);
        if (!isWithinWeb && !(isShared && onlyTypes)) {
          violations.push({
            file: path.relative(SRC_DIR, file),
            dep,
          });
        }
      }
    }

    expect(
      violations,
      `web/frontend/ 导入了后端代码:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 7 ──────────────────────────────────────────────────────────
  // ai-runner/ 不应导入 phases/（Runner 是被 Phase 调用的，反向不允许）
  it('ai-runner/ does not import from phases/', () => {
    const runnerFiles = getTypeScriptFiles(path.join(SRC_DIR, 'ai-runner'));
    const violations = findViolatingImports(runnerFiles, 'phases');

    expect(
      violations,
      `发现 ai-runner/ → phases/ 的违规导入:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 8 ──────────────────────────────────────────────────────────
  // clients/ 不应导入 orchestrator/（客户端层不依赖编排层）
  it('clients/ does not import from orchestrator/', () => {
    const clientFiles = getTypeScriptFiles(path.join(SRC_DIR, 'clients'));
    const violations = findViolatingImports(clientFiles, 'orchestrator');

    expect(
      violations,
      `发现 clients/ → orchestrator/ 的违规导入:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 9 ──────────────────────────────────────────────────────────
  // tracker/ 不应导入 phases/（数据层不依赖阶段实现）
  it('tracker/ does not import from phases/', () => {
    const trackerFiles = getTypeScriptFiles(path.join(SRC_DIR, 'tracker'));
    const violations = findViolatingImports(trackerFiles, 'phases');

    expect(
      violations,
      `发现 tracker/ → phases/ 的违规导入:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });

  // ─── Rule 10 ─────────────────────────────────────────────────────────
  // tracker/ 不应导入 clients/（数据层不直接调用外部 API）
  it('tracker/ does not import from clients/', () => {
    const trackerFiles = getTypeScriptFiles(path.join(SRC_DIR, 'tracker'));
    const violations = findViolatingImports(trackerFiles, 'clients');

    expect(
      violations,
      `发现 tracker/ → clients/ 的违规导入:\n${formatViolations(violations)}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseDependencies 单元测试
// ---------------------------------------------------------------------------

describe('parseDependencies', () => {
  it('parses static ESM imports with single and double quotes', () => {
    const tmpFile = path.join(SRC_DIR, '__test_parse_tmp.ts');
    fs.writeFileSync(
      tmpFile,
      `
import { foo } from './foo.js';
import bar from "../bar.js";
import './side-effect.js';
import type { Baz } from 'baz-pkg';
`,
    );
    try {
      const deps = parseDependencies(tmpFile);
      expect(deps).toContain('./foo.js');
      expect(deps).toContain('../bar.js');
      expect(deps).toContain('./side-effect.js');
      expect(deps).toContain('baz-pkg');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('parses multi-line imports', () => {
    const tmpFile = path.join(SRC_DIR, '__test_parse_multiline_tmp.ts');
    fs.writeFileSync(
      tmpFile,
      `
import {
  alpha,
  beta,
  gamma,
} from '../utils/helpers.js';
`,
    );
    try {
      const deps = parseDependencies(tmpFile);
      expect(deps).toContain('../utils/helpers.js');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('parses dynamic imports', () => {
    const tmpFile = path.join(SRC_DIR, '__test_parse_dynamic_tmp.ts');
    fs.writeFileSync(
      tmpFile,
      `
const mod = await import('./dynamic.js');
import("./lazy.js").then(m => m.run());
`,
    );
    try {
      const deps = parseDependencies(tmpFile);
      expect(deps).toContain('./dynamic.js');
      expect(deps).toContain('./lazy.js');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('parses Vue file script section only', () => {
    const tmpFile = path.join(SRC_DIR, '__test_parse_vue_tmp.vue');
    fs.writeFileSync(
      tmpFile,
      `
<template>
  <div>{{ msg }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { helper } from '../utils/helper.js';

const msg = ref('hello');
</script>

<style scoped>
div { color: red; }
</style>
`,
    );
    try {
      const deps = parseDependencies(tmpFile);
      expect(deps).toContain('vue');
      expect(deps).toContain('../utils/helper.js');
      expect(deps).toHaveLength(2);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
