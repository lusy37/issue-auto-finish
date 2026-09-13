import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'sdk-worker': 'src/ai-runner/sdk-worker.ts',
    cli: 'src/cli/index.ts',
    index: 'src/index.ts',
    lib: 'src/lib.ts',
    run: 'src/run.ts',
  },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: true,
  dts: false,
  external: [
    '@openai/codex-sdk',
    'express',
    'dotenv',
    'marked',
    'vue',
    'commander',
    'open',
  ],
});
