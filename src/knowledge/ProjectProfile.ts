import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveDataDir } from "../paths.js";
import { KNOWLEDGE_DEFAULTS } from "./KnowledgeDefaults.js";
import { loadKnowledge } from "./KnowledgeLoader.js";

const text = z.string().max(10000);
export const profileSchema = z.object({
  description: text,
  language: text,
  frameworks: z.array(text).max(30),
  installCommand: text,
  lintCommand: text,
  buildCommand: text,
  testCommand: text,
  rules: text,
});
export type ProjectProfile = z.infer<typeof profileSchema>;

/** 工作台只编辑演示需要的项目上下文，其余知识字段使用当前格式默认值。 */
export function readProjectProfile(): ProjectProfile {
  const knowledge = loadKnowledge() ?? KNOWLEDGE_DEFAULTS;
  return {
    description: knowledge.businessContext.purpose,
    language: knowledge.structure.primaryLanguage,
    frameworks: knowledge.structure.frameworks,
    installCommand: knowledge.toolchain.installCommand,
    lintCommand: knowledge.toolchain.lintCommand ?? "",
    buildCommand: knowledge.toolchain.buildCommand ?? "",
    testCommand: knowledge.toolchain.testCommand ?? "",
    rules: knowledge.agentKnowledge.conventions.join("\n"),
  };
}

export function writeProjectProfile(input: unknown): ProjectProfile {
  const profile = profileSchema.parse(input);
  const knowledge = structuredClone(KNOWLEDGE_DEFAULTS);
  knowledge.generatedAt = new Date().toISOString();
  knowledge.businessContext.purpose = profile.description;
  knowledge.structure.primaryLanguage = profile.language;
  knowledge.structure.frameworks = profile.frameworks;
  knowledge.toolchain = {
    ...knowledge.toolchain,
    installCommand: profile.installCommand,
    lintCommand: profile.lintCommand,
    buildCommand: profile.buildCommand,
    testCommand: profile.testCommand,
  };
  knowledge.agentKnowledge.conventions = profile.rules
    .split("\n")
    .filter(Boolean);
  const file = path.join(resolveDataDir(), "knowledge", "knowledge.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(knowledge, null, 2));
  loadKnowledge(file);
  return profile;
}
