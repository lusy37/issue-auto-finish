<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui/es/button';
import { NEmpty } from 'naive-ui/es/empty';
import { NTag } from 'naive-ui/es/tag';
import { Check, ExternalLink, RefreshCw, ShieldCheck, X } from '@lucide/vue';
import * as api from '@/api/client';
import type { UatResult as UatRun } from '../../../../shared/workbench.js';
import { useAction } from '@/composables/useAction';

const props = defineProps<{ issueIid?: number }>();
const runs = ref<UatRun[]>([]);
const { busy, error, run } = useAction();

async function load() {
  if (props.issueIid) runs.value = await api.fetchUatRuns(props.issueIid);
}
watch(
  () => props.issueIid,
  () => run(load),
  { immediate: true },
);
</script>

<template>
  <section
    class="native-verification-panel surface"
    aria-label="验收结果"
  >
    <header class="native-verification-head">
      <div>
        <div class="native-verification-kicker">UAT / BROWSER EVIDENCE</div>
        <h2>验收结果</h2>
        <p>只认本轮 Playwright 退出码与有效报告，模型文字不会替代验收证据。</p>
      </div>
      <NButton
        :loading="busy"
        @click="run(load)"
      >
        <template #icon><RefreshCw :size="15" /></template>
        刷新结果
      </NButton>
    </header>
    <div
      v-if="error"
      class="native-verification-error"
      role="alert"
    >
      {{ error }}
    </div>
    <NEmpty
      v-if="!runs.length && !busy"
      description="暂无本轮验收记录"
      class="native-verification-empty"
    >
      <template #icon><ShieldCheck :size="30" /></template>
    </NEmpty>
    <div
      v-else
      class="native-verification-list"
    >
      <article
        v-for="item in runs"
        :key="item.runId"
        class="native-verification-card"
        :class="{ passed: item.passed, failed: !item.passed }"
      >
        <header>
          <div class="native-verification-status">
            <span class="native-verification-icon">
              <Check
                v-if="item.passed"
                :size="16"
              />
              <X
                v-else
                :size="16"
              />
            </span>
            <div>
              <h3>{{ item.passed ? '验收通过' : '验收未通过' }}</h3>
              <p>{{ new Date(item.startedAt).toLocaleString('zh-CN') }} · 运行 {{ item.runId }}</p>
            </div>
          </div>
          <NTag
            :type="item.passed ? 'success' : 'error'"
            :bordered="false"
          >
            {{ item.passed ? 'PASS' : 'FAIL' }}
          </NTag>
        </header>
        <dl class="native-verification-stats">
          <div>
            <dt>通过</dt>
            <dd>{{ item.passedTests }}</dd>
          </div>
          <div>
            <dt>失败</dt>
            <dd>{{ item.failedTests }}</dd>
          </div>
          <div>
            <dt>跳过</dt>
            <dd>{{ item.skippedTests }}</dd>
          </div>
        </dl>
        <p
          v-if="item.error"
          class="native-verification-detail"
        >
          {{ item.error }}
        </p>
        <div class="native-verification-links">
          <a
            v-if="item.reportAvailable"
            :href="`/api/uat/runs/${item.runId}/files/report/index.html`"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink :size="14" />
            打开本次 HTML 报告
          </a>
          <a
            v-for="shot in item.screenshots"
            :key="shot"
            :href="`/api/uat/runs/${item.runId}/files/${shot}`"
            target="_blank"
            rel="noreferrer"
          >
            查看截图 · {{ shot }}
          </a>
        </div>
        <div
          v-if="item.screenshots?.length"
          class="native-verification-shots"
        >
          <a
            v-for="shot in item.screenshots"
            :key="`preview-${shot}`"
            :href="`/api/uat/runs/${item.runId}/files/${shot}`"
            target="_blank"
            rel="noreferrer"
          >
            <img
              :src="`/api/uat/runs/${item.runId}/files/${shot}`"
              :alt="shot"
            />
          </a>
        </div>
      </article>
    </div>
  </section>
</template>
