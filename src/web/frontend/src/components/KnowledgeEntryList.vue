<script setup lang="ts">
import { NButton } from 'naive-ui/es/button';
import { NCard } from 'naive-ui/es/card';
import { NEmpty } from 'naive-ui/es/empty';
import { NSwitch } from 'naive-ui/es/switch';
import { NTag } from 'naive-ui/es/tag';
import { ArrowUpRight, BookOpen } from '@lucide/vue';
import { knowledgeLabels as labels, type KnowledgeEntry } from '@/api/knowledge';

defineProps<{
  section: {
    key: string;
    title: string;
    description: string;
    empty: string;
    entries: KnowledgeEntry[];
  };
  saving: boolean;
}>();
const emit = defineEmits<{
  create: [];
  edit: [entry: KnowledgeEntry];
  read: [entry: KnowledgeEntry];
  toggle: [entry: KnowledgeEntry, enabled: boolean];
}>();
</script>

<template>
  <section
    class="knowledge-layer-section"
  >
    <div class="knowledge-section-title">
      <div>
        <h2>
          {{ section.title }}
          <span>({{ section.entries.length }})</span>
        </h2>
        <p>{{ section.description }}</p>
      </div>
    </div>
    <NCard v-if="!section.entries.length" class="knowledge-section-empty">
      <NEmpty :description="section.empty">
        <template #extra>
          <NButton
            v-if="section.key === 'custom'"
            type="primary"
            @click="emit('create')"
          >
            新增知识
          </NButton>
        </template>
      </NEmpty>
    </NCard>
    <div v-else class="prototype-document-grid">
      <NCard
        v-for="entry in section.entries"
        :key="entry.id"
        class="prototype-document-card"
      >
        <BookOpen :size="25" class="prototype-document-icon" />
        <h2>{{ entry.title }}</h2>
        <p>{{ entry.content.slice(0, 110) || '暂无正文' }}</p>
        <div class="knowledge-card-tags">
          <NTag size="small" :bordered="false">{{ labels[entry.type] }}</NTag>
          <template v-if="entry.memory">
            <NTag size="small" :bordered="false">
              证据 {{ entry.memory.evidence.length }} 条
            </NTag>
            <NTag size="small" :bordered="false">
              置信度 {{ Math.round(entry.memory.confidence * 100) }}%
            </NTag>
          </template>
          <NTag v-if="entry.deprecated" size="small" type="warning">已退役</NTag>
          <NTag
            v-for="tag in entry.tags
              .filter((item) => entry.type !== 'agent-rule' || item !== 'enabled')
              .slice(0, 2)"
            :key="tag"
            size="small"
            :bordered="false"
          >{{ tag }}</NTag>
        </div>
        <template #action>
          <div class="knowledge-card-actions">
            <NButton text type="primary" @click="emit('read', entry)">
              阅读内容 <ArrowUpRight :size="15" />
            </NButton>
            <NSwitch
              v-if="entry.type === 'agent-rule'"
              :value="entry.tags.includes('enabled')"
              :disabled="saving || entry.deprecated"
              :aria-label="`${entry.tags.includes('enabled') ? '停用' : '启用'}规则 ${entry.title}`"
              @update:value="(enabled) => emit('toggle', entry, enabled)"
            />
            <NButton v-if="entry.type === 'custom'" text @click="emit('edit', entry)">
              编辑
            </NButton>
          </div>
        </template>
      </NCard>
    </div>
  </section>
</template>
