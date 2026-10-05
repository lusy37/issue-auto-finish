import { ref, type App } from 'vue';
import { zhCN } from './locales/zh-CN.js';
import { en } from './locales/en.js';

export type Locale = 'zh-CN' | 'en';

const messages: Record<string, Record<string, string>> = {
  'zh-CN': zhCN,
  'en': en,
};

export const locale = ref<Locale>(
  (localStorage.getItem('iaf-locale') as Locale) || 'zh-CN',
);

export function t(key: string, params?: Record<string, string | number>): string {
  const msg = messages[locale.value]?.[key] ?? messages['zh-CN']?.[key] ?? key;
  if (!params) return msg;
  let result = msg;
  for (const [k, v] of Object.entries(params)) {
    result = result.replaceAll(`{${k}}`, String(v));
  }
  return result;
}

export function setLocale(l: Locale): void {
  locale.value = l;
  localStorage.setItem('iaf-locale', l);
}

export function getLocale(): Locale {
  return locale.value;
}

export const i18nPlugin = {
  install(app: App) {
    app.config.globalProperties.$t = t;
  },
};
