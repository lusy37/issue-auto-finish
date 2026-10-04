import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { queryClient } from './api/queryClient.js';
import App from './App.vue';
import { i18nPlugin } from './i18n/index.js';
import '@vue-flow/core/dist/style.css';
import './style.css';
createApp(App).use(i18nPlugin).use(VueQueryPlugin, { queryClient }).mount('#app');
