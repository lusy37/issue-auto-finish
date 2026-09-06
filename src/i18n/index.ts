export type Locale = 'zh-CN' | 'en';

type MessageMap = Record<string, string>;

const locales = new Map<Locale, MessageMap>();
let currentLocale: Locale = 'zh-CN';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function registerLocale(locale: Locale, messages: MessageMap): void {
  locales.set(locale, messages);
}

export function t(key: string, params?: Record<string, string | number>): string {
  const messages = locales.get(currentLocale) ?? locales.get('zh-CN');
  if (!messages) return key;
  let text = messages[key];
  if (text === undefined) {
    const fallback = locales.get('zh-CN');
    text = fallback?.[key] ?? key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

import { zhCN } from './locales/zh-CN.js';
import { en } from './locales/en.js';

registerLocale('zh-CN', zhCN);
registerLocale('en', en);
