import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';
import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child('SupplementStore');
const supplementSchema = z.object({
  requirements: z.string(), acceptanceCriteria: z.string(), scope: z.string(),
  constraints: z.string(), references: z.string(), freeText: z.string(), updatedAt: z.string(),
});

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
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      return supplementSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`无法读取补充资料 ${fp}：${(err as Error).message}`, { cause: err });
    }
  }

  save(issueIid: number, data: Omit<SupplementInfo, 'updatedAt'>): SupplementInfo {
    this.ensureDir();
    const info: SupplementInfo = {
      ...data,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomicSync(this.filePath(issueIid), supplementSchema.parse(info));
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

}
