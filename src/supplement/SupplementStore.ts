import fs from 'node:fs';
import path from 'node:path';
import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child('SupplementStore');

export interface SupplementInfo {
  requirements: string;
  acceptanceCriteria: string;
  scope: string;
  constraints: string;
  references: string;
  freeText: string;
  updatedAt: string;
}

export class SupplementStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'supplements');
  }

  private filePath(issueIid: number): string {
    return path.join(this.dir, `${issueIid}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  get(issueIid: number): SupplementInfo | null {
    const fp = this.filePath(issueIid);
    if (!fs.existsSync(fp)) return null;
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      return JSON.parse(raw) as SupplementInfo;
    } catch (err) {
      logger.error('Failed to read supplement', { issueIid, error: (err as Error).message });
      return null;
    }
  }

  save(issueIid: number, data: Omit<SupplementInfo, 'updatedAt'>): SupplementInfo {
    this.ensureDir();
    const info: SupplementInfo = {
      ...data,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.filePath(issueIid), JSON.stringify(info, null, 2), 'utf-8');
    logger.info('Supplement saved', { issueIid });
    return info;
  }

  delete(issueIid: number): boolean {
    const fp = this.filePath(issueIid);
    if (!fs.existsSync(fp)) return false;
    try {
      fs.unlinkSync(fp);
      logger.info('Supplement deleted', { issueIid });
      return true;
    } catch {
      return false;
    }
  }

  toPromptText(issueIid: number): string {
    const info = this.get(issueIid);
    if (!info) return '';

    const sections: string[] = [];

    if (info.requirements.trim()) {
      sections.push(`### 补充需求说明\n${info.requirements.trim()}`);
    }
    if (info.acceptanceCriteria.trim()) {
      sections.push(`### 验收标准\n${info.acceptanceCriteria.trim()}`);
    }
    if (info.scope.trim()) {
      sections.push(`### 变更范围\n${info.scope.trim()}`);
    }
    if (info.constraints.trim()) {
      sections.push(`### 约束条件\n${info.constraints.trim()}`);
    }
    if (info.references.trim()) {
      sections.push(`### 参考链接\n${info.references.trim()}`);
    }
    if (info.freeText.trim()) {
      sections.push(`### 其他补充\n${info.freeText.trim()}`);
    }

    if (sections.length === 0) return '';
    return `## 补充信息\n\n${sections.join('\n\n')}`;
  }
}
