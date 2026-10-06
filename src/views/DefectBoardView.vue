<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NTag } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'

const store = useInspectionStore()
const router = useRouter()
const columns = ['需整改', '整改中', '待复测', '需复核', '已关闭'] as const
const riskOrder = { 紧急: 0, 高: 1, 中: 2, 低: 3 }
const grouped = computed(() =>
  Object.fromEntries(columns.map((status) => [
    status,
    store.validRecords.filter((item) => item.status === status).sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk])
  ]))
)

const conflictCount = computed(() => store.validRecords.filter((r) => r.items.some((i) => i.resultConflict || i.readingConflict)).length)
const voidedCount = computed(() => store.validRecords.reduce((n, r) => n + r.rechecks.filter((rc) => rc.status === '已作废').length, 0))
</script>

<template>
  <section class="content">
    <div class="board-intro">
      <div>
        <h2>缺陷处置泳道</h2>
        <p>仅展示有效批次（缺班次旧记录先待核）；停用设备须放行后复测，结果改动自动联动复测/放行/办结。</p>
      </div>
      <NButton @click="store.resetDemo()">恢复演示数据</NButton>
    </div>

    <div class="link-strip">
      <article><span>冲突值保留两版</span><strong>{{ conflictCount }}</strong><small>整改人/停用争议待裁定</small></article>
      <article><span>已作废复测单</span><strong>{{ voidedCount }}</strong><small>结果改动后未执行复测</small></article>
      <article><span>待核批次</span><strong>{{ store.pendingRecords.length }}</strong><small>核实班次后进入泳道</small></article>
      <article><span>离线待补传</span><strong>{{ store.queue.filter((q) => q.status !== '已合并').length }}</strong><small>回连后重试未完成项</small></article>
    </div>

    <div class="kanban">
      <div v-for="column in columns" :key="column" class="kanban-column">
        <header><span>{{ column }}</span><b>{{ grouped[column].length }}</b></header>
        <article v-for="record in grouped[column]" :key="record.id" @click="router.push(`/records/${record.id}`)">
          <div>
            <NTag :type="record.risk === '紧急' ? 'error' : record.risk === '高' ? 'warning' : 'default'" size="small" :bordered="false">{{ record.risk }}风险</NTag>
            <small>V{{ record.version }}</small>
          </div>
          <h3>{{ record.deviceName }}</h3>
          <p>{{ record.deviceCode }} · {{ record.area }} · {{ record.shift }}</p>
          <p v-if="record.items.some((i) => i.resultConflict || i.readingConflict)" class="conflict-flag">冲突值已保留两版</p>
          <p v-if="record.status === '需复核'" class="conflict-flag">办结后改动，需按原依据复审 {{ record.reviews.length }} 项</p>
          <footer>
            <span :class="{ disputed: record.assigneeDisputed }">{{ record.assigneeDisputed ? '责任人待裁定' : record.assignedTo }}</span>
            <span :class="{ overdue: record.dueDate <= '2026-09-29' }">{{ record.dueDate ? `${record.dueDate} 截止` : '未定截止' }}</span>
          </footer>
          <footer v-if="record.stopped || record.stoppedDisputed">
            <NTag size="tiny" type="error" :bordered="false">{{ record.stoppedDisputed ? '停用有争议·禁复测' : '停用隔离·待放行' }}</NTag>
            <NTag size="tiny" :type="record.release.state === '已放行' ? 'success' : 'default'" :bordered="false">放行：{{ record.release.state }}</NTag>
          </footer>
        </article>
        <div v-if="!grouped[column].length" class="kanban-empty">暂无任务</div>
      </div>
    </div>

    <div class="conflict-table">
      <h3>联动说明</h3>
      <p>平板与值班室断网记录在回连后按「同设备 + 同班次 + 记录时刻」并单：检验项冲突保留两版；整改人、停用判断只采用无争议值；停用有争议按未停用处理并禁止复测；结果改动作废未执行复测、放行按新值重判、已办结保留原依据并列复审项；补传仅重试未完成项，重复回连不追加审计。</p>
    </div>
  </section>
</template>
