import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as atomic from '../../src/utils/atomicFile.js';
import { KnowledgeStore } from '../../src/knowledge/KnowledgeStore.js';
import { KNOWLEDGE_DEFAULTS } from '../../src/knowledge/KnowledgeDefaults.js';
import { getProjectKnowledge, loadKnowledge, reloadKnowledge, resetKnowledgeCache } from '../../src/knowledge/KnowledgeLoader.js';
import { readProjectProfile, writeProjectProfile } from '../../src/knowledge/ProjectProfile.js';
import { SupplementStore } from '../../src/supplement/SupplementStore.js';

let dir: string;
beforeEach(() => {
  const root = path.resolve('.iaf-mini/repair-tests');
  fs.mkdirSync(root, { recursive: true });
  dir = fs.mkdtempSync(path.join(root, '知识 保存 '));
  vi.stubEnv('DATA_DIR', dir);
  resetKnowledgeCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetKnowledgeCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedProfile() {
  const file = path.join(dir, 'custom.json');
  const knowledge = structuredClone(KNOWLEDGE_DEFAULTS);
  knowledge.businessContext.purpose = '原项目说明';
  knowledge.architecture.overview = '必须保留的架构';
  knowledge.knownIssues = [{ description: '历史问题', advice: '保留建议' }];
  knowledge.toolchain.testFilesCommand = 'pnpm test --filter {files}';
  fs.writeFileSync(file, JSON.stringify({ ...knowledge, extraField: { retained: true } }));
  loadKnowledge(file);
  return file;
}

describe('项目资料与知识来源', () => {
  it('默认位置首次缺失时可创建；后续读取使用同一文件', () => {
    expect(loadKnowledge()).toBeNull();
    writeProjectProfile({ ...readProjectProfile(), description: '首次填写' });
    expect(readProjectProfile().description).toBe('首次填写');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'knowledge/knowledge.json'), 'utf8')).businessContext.purpose).toBe('首次填写');
  });

  it.each([false, true])('自定义来源读写一致，默认文件存在=%s', defaultExists => {
    const file = seedProfile();
    const defaultFile = path.join(dir, 'knowledge/knowledge.json');
    if (defaultExists) {
      fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
      fs.writeFileSync(defaultFile, JSON.stringify({ version: 1, businessContext: { purpose: '另一份资料' } }));
    }
    const beforeDefault = defaultExists ? fs.readFileSync(defaultFile, 'utf8') : undefined;
    const profile = readProjectProfile();
    expect(profile.description).toBe('原项目说明');
    writeProjectProfile({ ...profile, description: '新项目说明' });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({
      businessContext: { purpose: '新项目说明' }, architecture: { overview: '必须保留的架构' },
      knownIssues: [{ description: '历史问题', advice: '保留建议' }],
      toolchain: { testFilesCommand: 'pnpm test --filter {files}' },
    });
    expect(getProjectKnowledge()?.businessContext.purpose).toBe('新项目说明');
    expect(reloadKnowledge()?.businessContext.purpose).toBe('新项目说明');
    expect(defaultExists ? fs.readFileSync(defaultFile, 'utf8') : fs.existsSync(defaultFile)).toBe(beforeDefault ?? false);
  });

  it.each(['缺失', '损坏', '错误结构'])('重新读取%s的文件时保留最近成功缓存', scenario => {
    const file = seedProfile();
    if (scenario === '缺失') fs.unlinkSync(file);
    else fs.writeFileSync(file, scenario === '损坏' ? '{' : JSON.stringify({ version: 1, structure: { frameworks: '不是数组' } }));
    expect(() => reloadKnowledge()).toThrow('无法读取项目知识');
    expect(getProjectKnowledge()?.businessContext.purpose).toBe('原项目说明');
    expect(() => readProjectProfile()).toThrow('无法读取项目知识');
  });

  it('替换失败时文件与缓存保持旧内容', () => {
    const file = seedProfile();
    const profile = readProjectProfile();
    const before = fs.readFileSync(file, 'utf8');
    vi.spyOn(atomic, 'writeJsonAtomicSync').mockImplementationOnce(() => { throw new Error('模拟磁盘写入失败'); });
    expect(() => writeProjectProfile({ ...profile, description: '不应提交' })).toThrow('模拟磁盘写入失败');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(getProjectKnowledge()?.businessContext.purpose).toBe('原项目说明');
  });
});

describe('知识索引与正文', () => {
  const entry = { type: 'custom' as const, title: '旧标题', content: '旧正文', tags: ['旧标签'] };
  const storeDir = () => path.join(dir, 'entries-store');
  const indexFile = () => path.join(storeDir(), 'index.json');

  it.each(['{', '{"version":2,"entries":[]}', '{"version":1,"entries":[{}]}'])('损坏索引不会被空索引覆盖：%s', raw => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(indexFile(), raw);
    const store = new KnowledgeStore(storeDir());
    expect(() => store.list()).toThrow('无法读取知识索引');
    expect(() => store.create(entry)).toThrow('无法读取知识索引');
    expect(fs.readFileSync(indexFile(), 'utf8')).toBe(raw);
  });

  it('索引缺失但已有正文时拒绝创建空索引', () => {
    const store = new KnowledgeStore(storeDir());
    const saved = store.create(entry);
    fs.unlinkSync(indexFile());
    expect(() => new KnowledgeStore(storeDir()).create(entry)).toThrow('索引缺失但正文仍存在');
    expect(fs.readFileSync(path.join(storeDir(), 'entries', saved.id + '.md'), 'utf8')).toBe('旧正文');
    expect(fs.existsSync(indexFile())).toBe(false);
  });

  it('索引引用的正文缺失时返回明确错误', () => {
    const store = new KnowledgeStore(storeDir());
    const saved = store.create(entry);
    fs.unlinkSync(path.join(storeDir(), 'entries', saved.id + '.md'));
    expect(() => store.get(saved.id)).toThrow('无法读取知识正文');
    expect(() => store.getAllEntries()).toThrow('无法读取知识正文');
  });

  it.each(['新增', '更新', '删除', '时间戳'])('%s索引提交失败时不发布新缓存', operation => {
    const store = new KnowledgeStore(storeDir());
    const saved = store.create(entry);
    const before = fs.readFileSync(indexFile(), 'utf8');
    vi.spyOn(atomic, 'writeJsonAtomicSync').mockImplementationOnce(() => { throw new Error('索引提交失败'); });
    const perform = () => {
      if (operation === '新增') store.create({ ...entry, title: '新条目' });
      else if (operation === '更新') store.update(saved.id, { title: '新标题', tags: ['新标签'] });
      else if (operation === '删除') store.delete(saved.id);
      else store.setLastAnalyzedAt('新时间');
    };
    expect(perform).toThrow('索引提交失败');
    expect(fs.readFileSync(indexFile(), 'utf8')).toBe(before);
    expect(store.list()).toEqual(JSON.parse(before).entries);
    expect(store.getStats().lastAnalyzedAt).toBeUndefined();
    expect(store.get(saved.id)?.content).toBe('旧正文');
  });

  it('正文已保存而索引失败时明确保留部分提交结果', () => {
    const store = new KnowledgeStore(storeDir());
    const saved = store.create(entry);
    vi.spyOn(atomic, 'writeJsonAtomicSync').mockImplementationOnce(() => { throw new Error('索引提交失败'); });
    expect(() => store.update(saved.id, { title: '新标题', content: '新正文' })).toThrow('索引提交失败');
    expect(store.get(saved.id)).toMatchObject({ title: '旧标题', content: '新正文' });
    expect(new KnowledgeStore(storeDir()).get(saved.id)).toMatchObject({ title: '旧标题', content: '新正文' });
  });

  it('删除后正文清理失败仍保持已提交的索引结果', () => {
    const store = new KnowledgeStore(storeDir());
    const saved = store.create(entry);
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('文件被占用'); });
    expect(store.delete(saved.id)).toBe(true);
    expect(store.get(saved.id)).toBeNull();
    expect(new KnowledgeStore(storeDir()).list()).toEqual([]);
    expect(fs.existsSync(path.join(storeDir(), 'entries', saved.id + '.md'))).toBe(true);
  });
});

it('补充资料损坏时明确报错，只有文件不存在才返回空', () => {
  const store = new SupplementStore(dir);
  expect(store.get(1)).toBeNull();
  fs.mkdirSync(path.join(dir, 'supplements'));
  const file = path.join(dir, 'supplements/1.json');
  for (const raw of ['{', '{}']) {
    fs.writeFileSync(file, raw);
    expect(() => store.get(1)).toThrow('无法读取补充资料');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  }
});
