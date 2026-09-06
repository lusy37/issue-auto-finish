<script setup lang="ts">
import {ref,onMounted} from 'vue';
import {json} from '../api/http';
import {useAction} from '../composables/useAction';
const issues=ref<Array<{number:number;title:string;html_url?:string}>>([]);
const {busy,error,run}=useAction();
async function refresh(){issues.value=(await json<{issues:typeof issues.value}>('/api/github/issues')).issues;}
onMounted(()=>run(refresh));
</script>
<template><section><h2>浏览 GitHub Issue</h2><button :disabled="busy" @click="run(refresh)">刷新</button><p v-if="error" role="alert">{{error}}</p><ul><li v-for="issue in issues" :key="issue.number"><a :href="issue.html_url" target="_blank" rel="noreferrer">#{{issue.number}} {{issue.title}}</a></li></ul></section></template>
