import type { ProjectKnowledge } from './ProjectKnowledge.js';

/**
 * Default knowledge matching current hardcoded behavior.
 * Used as fallback when knowledge.json does not exist.
 */
export const KNOWLEDGE_DEFAULTS: ProjectKnowledge = {
  version: 1,
  generatedAt: '2024-01-01T00:00:00Z',
  repoPath: '',
  structure: {
    primaryLanguage: 'TypeScript',
    frameworks: ['Node.js'],
    isMonorepo: false,
    hasFrontendBackendSplit: true,
    frontendDir: '.',
    e2eDir: 'frontend/e2e/dynamic',
    e2eTool: 'Playwright',
  },
  toolchain: {
    packageManager: 'npm',
    installCommand: 'npm install',
    installFallbackCommand: 'npm install',
    lintCommand: 'npm run lint',
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    testFilesCommand: 'npm test -- {files}',
    dependencyCheckPath: 'node_modules/.bin/eslint',
  },
  codeStyle: {
    indentStyle: 'spaces',
    indentSize: 2,
    lineWidth: 120,
  },
  businessContext: {
    purpose: '',
    targetUsers: '',
    domain: '',
    coreFeatures: [],
  },
  architecture: {
    overview: '',
    keyModules: [],
    dataFlow: '',
    designPatterns: [],
    externalDependencies: [],
  },
  domainConcepts: [],
  agentKnowledge: {
    summary: '',
    rules: [],
    conventions: [],
  },ruleTriggers: [],knownIssues: [],
};
