<script setup lang="ts">
import type {IssueRecord} from '@/types';
import type {VerifyFixLoopState} from '@/composables/repairProgress';
import {usePipeline} from '@/composables/usePipeline';
defineProps<{issue:IssueRecord;verifyFixLoop?:VerifyFixLoopState;vertical?:boolean}>();
const emit=defineEmits<{retryFromPhase:[phase:string]}>();
const {getPhaseNames,phaseLabel,phaseStatus}=usePipeline();
const labels:Record<string,string>={pending:'待执行',in_progress:'执行中',completed:'通过',failed:'失败',paused:'已暂停',gate_waiting:'等待审核'};
</script>
<template><section><h3 class="font-semibold mb-3">流水线进度</h3><div class="flex gap-2" :class="vertical?'flex-col':'flex-wrap'">
<div v-for="phase in getPhaseNames(issue)" :key="phase" class="border rounded-lg p-3 flex-1 min-w-24" :class="phaseStatus(issue,phase)==='completed'?'bg-green-50 border-green-200':phaseStatus(issue,phase)==='failed'?'bg-red-50 border-red-200':'bg-gray-50'">
<strong>{{phaseLabel(phase)}}</strong><p class="text-xs my-2">{{labels[phaseStatus(issue,phase)]}}</p>
<button v-if="issue.lifecycle.kind==='failed' && phase!=='review'" class="text-blue-600 text-xs" @click="emit('retryFromPhase',phase)">从此阶段重试</button>
</div></div><p v-if="issue.lifecycle.kind==='delivering'" class="my-3 text-blue-700">验收已通过，正在创建合并请求并回写结果。</p><p v-if="verifyFixLoop" class="mt-3 text-sm text-gray-600">集成修复：第 {{ verifyFixLoop.iteration }} / {{ verifyFixLoop.maxIterations }} 轮 · {{ verifyFixLoop.lastPassed ? "验收通过" : verifyFixLoop.active ? "进行中" : "已停止或等待继续" }}</p></section></template>
