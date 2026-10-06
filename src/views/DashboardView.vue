<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NDataTable, NDatePicker, NForm, NFormItem, NInput, NModal, NSelect, NTag, useMessage } from 'naive-ui'
import { useQuery } from '@tanstack/vue-query'
import { useInspectionStore } from '../stores/inspection'
import { loadInspectionSnapshot } from '../services/api'
import type { InspectionDraft, InspectionRecord, RiskLevel } from '../types'

const store = useInspectionStore()
const router = useRouter()
const message = useMessage()
const showCreate = ref(false)
const draft = ref<InspectionDraft>({ deviceCode: '', deviceName: '', area: 'A区', shift: '早班', inspector: '周宁', risk: '中', assignedTo: '维修一组', dueDate: '2026-09-30' })

const { isFetching } = useQuery({
  queryKey: ['inspection-snapshot'],
  queryFn: () => loadInspectionSnapshot(store.records),
  staleTime: 60_000
})

const statusOptions = ['全部', '待检验', '需整改', '整改中', '待复测', '已关闭', '停用'].map((value) => ({ label: value, value }))
const areaOptions = ['全部', ...new Set(store.records.map((item) => item.area))].map((value) => ({ label: value, value }))
const riskOptions: Array<{ label: RiskLevel; value: RiskLevel }> = ['低', '中', '高', '紧急'].map((value) => ({ label: value as RiskLevel, value: value as RiskLevel }))

const syncTag = (row: InspectionRecord) => {
  if (row.syncState === '已同步') return null
  const type = row.syncState === '待核' ? 'warning' : row.syncState === '同步失败' ? 'error' : 'info'
  return h(NTag, { size: 'small', type, bordered: false, style: 'margin-left:6px' }, { default: () => row.syncState })
}

const columns = [
  { title: '检验编号', key: 'id', width: 145 },
  { title: '设备', key: 'deviceName', width: 130, render: (row: any) => `${row.deviceName} / ${row.deviceCode}` },
  { title: '区域', key: 'area', width: 90 },
  {
    title: '状态', key: 'status', width: 150, render: (row: any) => h('span', null, [
      h(NTag, { type: row.stopped ? 'error' : row.status === '已关闭' ? 'success' : 'warning', bordered: false }, { default: () => row.status }),
      syncTag(row as InspectionRecord)
    ])
  },
  { title: '风险', key: 'risk', width: 80 },
  { title: '责任人', key: 'assignedTo', width: 105 },
  { title: '截止', key: 'dueDate', width: 110 },
  { title: '有效批次', key: 'batchId', width: 165, render: (row: any) => row.batchId || '基线数据' },
  { title: '版本', key: 'version', width: 70, render: (row: any) => `V${row.version}` },
  { title: '', key: 'actions', width: 80, render: (row: any) => h(NButton, { size: 'small', tertiary: true, onClick: () => router.push(`/records/${row.id}`) }, { default: () => '打开' }) }
]

const validDraft = computed(() => draft.value.deviceCode && draft.value.deviceName && draft.value.assignedTo && draft.value.dueDate)

function createRecord() {
  if (!validDraft.value) return
  const record = store.addRecord(draft.value)
  showCreate.value = false
  message.success(store.online ? `已创建 ${record.id}` : `已离线创建 ${record.id}，记录留在平板待补传`)
  router.push(`/records/${record.id}`)
}

function reconnect() {
  const batch = store.setOnline(true)
  if (batch) {
    batch.failedOps
      ? message.warning(`批次 ${batch.id} 部分失败：并单 ${batch.mergedOps} 条，${batch.failedOps} 条待重试`)
      : message.success(`批次 ${batch.id} 合并完成：并单 ${batch.mergedOps} 条，冲突 ${batch.conflictCount} 项`)
  } else {
    message.info('通道已恢复，无待合并记录')
  }
}

function retry() {
  const batch = store.retryFailed()
  batch ? message.success(`重试完成：批次 ${batch.id}，并单 ${batch.mergedOps} 条`) : message.info('没有失败待重试的补传项')
}
</script>

<template>
  <section class="content">
    <div class="sync-banner" :class="{ offline: !store.online }">
      <div>
        <strong>{{ store.online ? '回连通道在线' : '园区断网中 · 检验记录留在平板本机' }}</strong>
        <p>
          待补传 {{ store.pendingOps.length }} 条 · 失败待重试 {{ store.failedOps.length }} 条 ·
          当前有效批次 {{ store.activeBatch?.id ?? '基线数据' }}
          <template v-if="store.activeBatch">（{{ store.activeBatch.status }}，冲突 {{ store.activeBatch.conflictCount }} 项）</template>
        </p>
      </div>
      <div class="sync-actions">
        <NButton v-if="store.failedOps.length && store.online" size="small" type="warning" @click="retry">重试未完成项</NButton>
        <NButton v-if="store.online" size="small" @click="store.setOnline(false)">模拟断网</NButton>
        <NButton v-else size="small" type="primary" @click="reconnect">恢复回连并合并</NButton>
      </div>
    </div>

    <div class="metric-strip five">
      <article><span>今日检验任务</span><strong>{{ store.stats.total }}</strong><small>含复用演示记录</small></article>
      <article><span>停用设备</span><strong>{{ store.stats.blocked }}</strong><small>需优先核实隔离状态</small></article>
      <article><span>临近超期</span><strong>{{ store.stats.overdue }}</strong><small>按整改截止日计算</small></article>
      <article><span>已闭环</span><strong>{{ store.stats.closed }}</strong><small>异常项已复核完成</small></article>
      <article><span>待核记录</span><strong>{{ store.stats.pendingVerify }}</strong><small>缺班次标识先待核</small></article>
    </div>

    <div class="toolbar">
      <NInput v-model:value="store.keyword" clearable placeholder="搜索设备、编号、检验员或责任人" />
      <NSelect v-model:value="store.status" :options="statusOptions" />
      <NSelect v-model:value="store.area" :options="areaOptions" />
      <NButton type="primary" @click="showCreate = true">新建检验任务</NButton>
      <span class="query-state">{{ isFetching ? '正在同步' : '本地数据已加载' }}</span>
    </div>

    <NDataTable :columns="columns" :data="store.filtered" :bordered="false" :row-key="(row: any) => row.id" size="small" />

    <NModal v-model:show="showCreate" preset="card" title="新建日常检验任务" style="width: 620px">
      <NForm label-placement="left" label-width="92">
        <div class="form-grid">
          <NFormItem label="设备编号" required><NInput v-model:value="draft.deviceCode" placeholder="例如 RC-009" /></NFormItem>
          <NFormItem label="设备名称" required><NInput v-model:value="draft.deviceName" /></NFormItem>
          <NFormItem label="区域"><NSelect v-model:value="draft.area" :options="areaOptions.filter((item) => item.value !== '全部')" /></NFormItem>
          <NFormItem label="班次"><NSelect v-model:value="draft.shift" :options="['早班', '中班', '晚班'].map((value) => ({ label: value, value }))" /></NFormItem>
          <NFormItem label="检验员"><NInput v-model:value="draft.inspector" /></NFormItem>
          <NFormItem label="风险等级"><NSelect v-model:value="draft.risk" :options="riskOptions" /></NFormItem>
          <NFormItem label="整改责任"><NInput v-model:value="draft.assignedTo" /></NFormItem>
          <NFormItem label="截止日期"><NDatePicker v-model:formatted-value="draft.dueDate" value-format="yyyy-MM-dd" type="date" /></NFormItem>
        </div>
      </NForm>
      <template #footer>
        <div class="modal-actions">
          <span v-if="!validDraft" class="validation">设备编号、名称、责任人和截止日期必填</span>
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :disabled="!validDraft" @click="createRecord">创建并进入检验</NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>
