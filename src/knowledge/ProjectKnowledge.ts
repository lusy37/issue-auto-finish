export interface RuleTriggerConfig {
  filename: string;
  keywords: string[];
  description?: string;
}

export interface KnownIssueConfig {
  description: string;
  pattern?: string;
  advice: string;
}

export interface KeyModuleConfig {
  name: string;
  path: string;
  responsibility: string;
}

export interface DomainConceptConfig {
  term: string;
  definition: string;
}

export interface LocalRuleKnowledge {
  filename: string;
  purpose: string;
  keyPoints: string[];
}

export interface ProjectKnowledge {
  version: 1;
  generatedAt: string;
  repoPath: string;
  structure: {
    primaryLanguage: string;
    frameworks: string[];
    isMonorepo: boolean;
    hasFrontendBackendSplit: boolean;
    frontendDir?: string;
    e2eDir?: string;
    e2eTool?: string;
    description?: string;
  };
  toolchain: {
    packageManager: string;
    installCommand: string;
    installFallbackCommand?: string;
    lintCommand?: string;
    buildCommand?: string;
    testCommand?: string;
    testFilesCommand?: string;
    dependencyCheckPath?: string;
  };
  codeStyle: {
    indentStyle: 'spaces' | 'tabs';
    indentSize: number;
    lineWidth: number;
    additionalRules?: string[];
  };
  businessContext: {
    purpose: string;
    targetUsers: string;
    domain: string;
    coreFeatures: string[];
  };
  architecture: {
    overview: string;
    keyModules: KeyModuleConfig[];
    dataFlow: string;
    designPatterns: string[];
    externalDependencies: string[];
  };
  domainConcepts: DomainConceptConfig[];
  agentKnowledge: {
    summary: string;
    rules: LocalRuleKnowledge[];
    claudeMdSummary?: string;
    conventions: string[];
  };
  ruleTriggers: RuleTriggerConfig[];
  knownIssues: KnownIssueConfig[];
  custom?: Record<string, unknown>;
}
