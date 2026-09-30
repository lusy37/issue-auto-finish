import { createApp } from 'vue';
import App from './App.vue';
import { i18nPlugin } from './i18n/index.js';
import '@vue-flow/core/dist/style.css';
import './style.css';
createApp(App).use(i18nPlugin).mount('#app');
