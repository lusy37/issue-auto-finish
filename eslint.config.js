import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import globals from 'globals';

/** Shared TS rules for backend and frontend */
const tsRules = {
  ...js.configs.recommended.rules,
  ...tseslint.configs.recommended.reduce((acc, cfg) => ({ ...acc, ...cfg.rules }), {}),
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-console': 'off',
};

export default [
  // Global ignores
  {
    ignores: [
      'dist/',
      'node_modules/',
      'data/',
      '**/*.proto',
      'src/web/frontend/dist/',
      '*.config.js',
      '*.config.ts',
      '*.config.cjs',
    ],
  },

  // Backend TypeScript files (excluding frontend)
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/web/frontend/**'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...tsRules,
    },
  },

  // Frontend Vue files — spread flat/essential to keep processor intact
  ...pluginVue.configs['flat/essential'].map((cfg) => ({
    ...cfg,
    files: ['src/web/frontend/src/**/*.vue'],
  })),
  {
    files: ['src/web/frontend/src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...tsRules,
      'no-undef': 'off',
      'vue/multi-word-component-names': 'off',
      // Vue 3 reactive prop 子字段双向绑定（v-model="prop.nested.field"）是项目内
      // 统一的 form/settings 模式（参考 SettingsPanel/SetupWizard/E2eConfigSection），
      // 与 Vue 3 reactive 共享语义一致。只禁止直接替换 prop 本身，不限制嵌套字段。
      'vue/no-mutating-props': ['error', { shallowOnly: true }],
    },
  },

  // Frontend TypeScript files (non-Vue)
  {
    files: ['src/web/frontend/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...tsRules,
      'no-undef': 'off',
    },
  },

  // Test files
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...tsRules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
];
