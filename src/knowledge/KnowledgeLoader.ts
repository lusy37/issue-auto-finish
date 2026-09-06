import fs from "node:fs";
import path from "node:path";
import { logger as rootLogger } from "../logger.js";
import type { ProjectKnowledge } from "./ProjectKnowledge.js";
import { KNOWLEDGE_DEFAULTS } from "./KnowledgeDefaults.js";
import { resolveDataDir } from "../paths.js";

const logger = rootLogger.child("KnowledgeLoader");

let _cachedKnowledge: ProjectKnowledge | null | undefined;
function resolveKnowledgePath(explicitPath?: string): string | null {
  const file =
    explicitPath ?? path.join(resolveDataDir(), "knowledge", "knowledge.json");
  return fs.existsSync(file) ? file : null;
}

function deepMerge(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    const val = overrides[key];
    if (val !== null && val !== undefined) {
      if (
        typeof val === "object" &&
        !Array.isArray(val) &&
        typeof result[key] === "object" &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          val as Record<string, unknown>,
        );
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}

/**
 * Load knowledge from knowledge.json, merging with defaults for any missing fields.
 */
export function loadKnowledge(explicitPath?: string): ProjectKnowledge | null {
  const filePath = resolveKnowledgePath(explicitPath);
  if (!filePath) {
    logger.info("No knowledge.json found, will use defaults");
    _cachedKnowledge = null;
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProjectKnowledge>;
    if (parsed.version !== 1)
      throw new Error("不支持的项目知识格式，只支持当前 version=1");
    const merged = deepMerge(
      KNOWLEDGE_DEFAULTS as unknown as Record<string, unknown>,
      parsed as unknown as Record<string, unknown>,
    ) as unknown as ProjectKnowledge;
    _cachedKnowledge = merged;
    logger.info("Knowledge loaded", {
      path: filePath,
      version: merged.version,
    });
    return merged;
  } catch (err) {
    logger.warn("无法读取项目知识", {
      path: filePath,
      error: (err as Error).message,
    });
    _cachedKnowledge = undefined;
    throw new Error(`无法读取项目知识：${(err as Error).message}`);
  }
}

/**
 * Get cached knowledge (or null if not loaded or file not found).
 */
export function getProjectKnowledge(): ProjectKnowledge | null {
  if (_cachedKnowledge === undefined) {
    return loadKnowledge();
  }
  return _cachedKnowledge;
}

/**
 * Clear cache and reload.
 */
export function reloadKnowledge(
  explicitPath?: string,
): ProjectKnowledge | null {
  _cachedKnowledge = undefined;
  return loadKnowledge(explicitPath);
}

/**
 * Reset the cache (for testing).
 */
export function resetKnowledgeCache(): void {
  _cachedKnowledge = undefined;
}
