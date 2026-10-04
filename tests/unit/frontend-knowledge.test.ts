import { beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../../src/web/frontend/src/api/http.js';
import { fetchKnowledge, setRuleEnabled } from '../../src/web/frontend/src/api/knowledge.js';

vi.mock('../../src/web/frontend/src/api/http.js', () => ({ json: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe('知识 API 数据边界', () => {
  it('直接读取服务端解包后的知识领域对象', async () => {
    vi.mocked(json).mockResolvedValue({ entries: [
      { type: 'custom', title: '资料', content: '{正文不是 JSON}' },
      { type: 'memory', title: '经验', content: '经验正文', memory: { confidence: 0.8, evidence: ['diary-1'] } },
    ] });
    expect(await fetchKnowledge()).toMatchObject([
      { content: '{正文不是 JSON}' },
      { content: '经验正文', memory: { confidence: 0.8, evidence: ['diary-1'] } },
    ]);
  });

  it('切换规则后仍返回可展示的正文及退役状态', async () => {
    vi.mocked(json).mockResolvedValue({
      type: 'agent-rule', title: '规则', tags: ['enabled'],
      content: '先测试', deprecated: false,
    });
    expect(await setRuleEnabled('rule-1', true)).toMatchObject({
      content: '先测试', deprecated: false, tags: ['enabled'],
    });
  });

  it('不在浏览器端重复解析结构化知识正文', async () => {
    vi.mocked(json).mockResolvedValue({ entries: [
      { type: 'memory', title: '损坏经验', content: '旧纯文本格式' },
    ] });
    await expect(fetchKnowledge()).resolves.toMatchObject([
      { type: 'memory', content: '旧纯文本格式' },
    ]);
  });
});
