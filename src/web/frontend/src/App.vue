<script setup lang="ts">
import {ref} from 'vue';
import SettingsPanel from './components/SettingsPanel.vue';
const tabs = ['任务工作台','需求拆分','知识与经验','蒸馏','任务统计','设置'];
const active = ref('设置');
</script>
<template><main class="max-w-7xl mx-auto p-8"><h1 class="text-3xl font-bold mb-6">Issue Auto-Finish</h1><nav class="flex gap-3 border-b pb-3 mb-6" aria-label="工作台导航"><button v-for="tab in tabs" :key="tab" @click="active=tab" :class="active===tab ? 'bg-gray-800 text-white' : 'bg-white'">{{tab}}</button></nav><SettingsPanel v-if="active==='设置'"/><section v-else><h2>{{active}}</h2></section></main></template>
