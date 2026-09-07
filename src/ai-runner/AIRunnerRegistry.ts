import type { AIRunner } from "./AIRunner.js";
import { CodexRunner } from "./CodexRunner.js";
import { findExecutable } from "../utils/process.js";
export interface AIConfig {
  mode: string;
  binary: string;
  phaseTimeoutMs: number;
  model?: string;
}
export interface RunnerCapabilities {
  nativePlanMode: boolean;
  planModeResumable?: boolean;
}
export interface RunnerRegistryEntry {
  ctor?: new (binary: string, model?: string) => AIRunner;
  factoryFn?: (binary: string, model?: string) => AIRunner;
  defaultBinary: string;
  binaryEnvKey: string;
  capabilities: RunnerCapabilities;
}
const registry: Record<string, RunnerRegistryEntry> = {
  codex: {
    ctor: CodexRunner,
    defaultBinary: "",
    binaryEnvKey: "CODEX_BINARY",
    capabilities: { nativePlanMode: true, planModeResumable: true },
  },
};
export function registerAIRunner(
  mode: string,
  entry: RunnerRegistryEntry,
): void {
  registry[mode] = entry;
}
export function getRegisteredRunnerModes(): string[] {
  return Object.keys(registry);
}
export function isRegisteredRunner(mode: string): boolean {
  return !!registry[mode];
}
export function resolveRunnerMode(raw: string): string {
  return raw || "codex";
}
export function getDefaultBinary(mode: string): string {
  return registry[mode]?.defaultBinary ?? mode;
}
export function getBinaryEnvKey(mode: string): string | undefined {
  return registry[mode]?.binaryEnvKey;
}
export function getRegistryEntry(
  mode: string,
): RunnerRegistryEntry | undefined {
  return registry[mode];
}
export function getRunnerCapabilities(
  mode: string,
): RunnerCapabilities | undefined {
  return registry[mode]?.capabilities;
}
export function supportsPlanModeResume(mode: string): boolean {
  return registry[mode]?.capabilities.planModeResumable === true;
}
export function validateRunnerRegistry(modes: string[]): void {
  for (const mode of modes)
    if (!registry[mode]) throw new Error(`未注册执行器：${mode}`);
}
export function createAIRunner(ai: AIConfig): AIRunner {
  validateRunnerRegistry([ai.mode]);
  const entry = registry[ai.mode];
  return entry.factoryFn
    ? entry.factoryFn(ai.binary, ai.model)
    : new entry.ctor!(ai.binary, ai.model);
}
export async function isBinaryAvailable(binary: string): Promise<boolean> {
  return !!findExecutable(binary);
}
