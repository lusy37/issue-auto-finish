import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadFixture(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf-8');
}

export function loadFixturesInDir(dir: string): Array<{ name: string; content: string }> {
  const absDir = path.join(__dirname, dir);
  if (!fs.existsSync(absDir)) return [];
  return fs.readdirSync(absDir)
    .filter(f => !f.endsWith('.ts'))
    .map(f => ({
      name: f,
      content: fs.readFileSync(path.join(absDir, f), 'utf-8'),
    }));
}

export function loadJsonlFixture(relativePath: string): Record<string, unknown>[] {
  const raw = loadFixture(relativePath);
  return raw.split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

export const FIXTURES_DIR = __dirname;
