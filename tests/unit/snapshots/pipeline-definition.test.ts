import { describe, it, expect, vi } from 'vitest';

// Mock i18n
vi.mock('../../../src/i18n/index.js', async () => {
  const { zhCN } = await import('../../../src/i18n/locales/zh-CN.js');
  const messages = new Map<string, Record<string, string>>();
  messages.set('zh-CN', zhCN);

  function t(key: string, params?: Record<string, string | number>): string {
    const msgs = messages.get('zh-CN');
    if (!msgs) return key;
    let text = msgs[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  }

  return {
    t,
    setLocale: vi.fn(),
    getLocale: () => 'zh-CN' as const,
    registerLocale: vi.fn(),
  };
});

// Mock PhaseFactory to avoid pulling in heavy dependencies
vi.mock('../../../src/phases/PhaseFactory.js', () => ({
  registerPhase: vi.fn(),
}));

import {
  PLAN_MODE_PIPELINE,
} from '../../../src/pipeline/PipelineMetadata.js';

describe('Pipeline Definitions', () => {
  it('PLAN_MODE_PIPELINE definition (snapshot)', () => {
    expect(PLAN_MODE_PIPELINE).toMatchSnapshot();
  });

  it('PLAN_MODE_PIPELINE phase names', () => {
    const phaseNames = PLAN_MODE_PIPELINE.phases.map(p => p.name);
    expect(phaseNames).toMatchSnapshot();
  });

  it('PLAN_MODE_PIPELINE phase kinds', () => {
    const kinds = PLAN_MODE_PIPELINE.phases.map(p => ({ name: p.name, kind: p.kind }));
    expect(kinds).toMatchSnapshot();
  });

  it('PLAN_MODE_PIPELINE artifacts', () => {
    const artifacts = PLAN_MODE_PIPELINE.phases
      .filter(p => p.artifacts && p.artifacts.length > 0)
      .map(p => ({ name: p.name, artifacts: p.artifacts }));
    expect(artifacts).toMatchSnapshot();
  });

});
