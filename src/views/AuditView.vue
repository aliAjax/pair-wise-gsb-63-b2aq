<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInput, NTag } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const store = useInspectionStore()
const keyword = ref('')

/** 值班室审计与看板、详情显示同一有效批次：待核批次的审计先不进入时间线 */
const entries = computed(() =>
  store.audit.filter((entry) => {
    if (!store.validIdSet.has(entry.recordId)) return false
    return !keyword.value || `${entry.recordId} ${entry.action} ${entry.operator} ${entry.detail}`.includes(keyword.value)
  })
)
const hiddenPending = computed(() => store.audit.filter((entry) => !store.validIdSet.has(entry.recordId)).length)

function tagType(action: string) {
  if (action.includes('作废') || action.includes('驳回')) return 'error'
  if (action.includes('并单') || action.includes('补传')) return 'info'
  if (action.includes('放行通过') || action.includes('复测完成') || action.includes('核实') || action.includes('裁定')) return 'success'
  if (action.includes('重判') || action.includes('办结回退')) return 'warning'
  return 'default'
}
</script>

<template>
  <section class="content audit-layout">
    <div class="audit-head">
      <div>
        <h2>操作审计与版本追溯</h2>
        <p>与看板、详情同一有效批次口径；重复回连不重复追加审计，待核批次核实后才进入时间线。</p>
      </div>
      <NInput v-model:value="keyword" clearable placeholder="按编号、操作人、动作搜索" style="max-width: 330px" />
    </div>

    <div v-if="hiddenPending" class="warn-band">
      <strong>待核审计暂存：</strong>{{ hiddenPending }} 条记录属于缺班次标识的旧批次，核实班次后自动并入本时间线。
    </div>

    <div class="timeline">
      <article v-for="entry in entries" :key="entry.id">
        <div class="time">{{ entry.createdAt.replace('T', ' ').slice(0, 16) }}</div>
        <i />
        <div class="audit-card">
          <header>
            <strong>{{ entry.action }}</strong>
            <NTag size="small" :bordered="false" :type="tagType(entry.action)">{{ entry.recordId }}</NTag>
          </header>
          <p>{{ entry.detail }}</p>
          <small>操作人：{{ entry.operator }}</small>
        </div>
      </article>
      <div v-if="!entries.length" class="kanban-empty">暂无有效批次审计</div>
    </div>
  </section>
</template>
