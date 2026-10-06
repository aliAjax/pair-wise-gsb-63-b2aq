<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NDataTable, NDatePicker, NForm, NFormItem, NInput, NModal, NSelect, NSwitch, NTag, useMessage } from 'naive-ui'
import { useQuery } from '@tanstack/vue-query'
import { useInspectionStore } from '../stores/inspection'
import { loadInspectionSnapshot } from '../services/api'
import type { InspectionDraft, RiskLevel } from '../types'

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

const statusOptions = ['全部', '待检验', '需整改', '整改中', '待复测', '需复核', '已关闭', '停用'].map((value) => ({ label: value, value }))
const areaOptions = ['全部', ...new Set(store.records.map((item) => item.area))].map((value) => ({ label: value, value }))
const riskOptions: Array<{ label: RiskLevel; value: RiskLevel }> = ['低', '中', '高', '紧急'].map((value) => ({ label: value as RiskLevel, value: value as RiskLevel }))
const shiftOptions = ['早班', '中班', '晚班'].map((value) => ({ label: value, value }))

const hasConflict = (row: any) => row.items?.some((item: any) => item.resultConflict || item.readingConflict)

const columns = [
  { title: '检验编号', key: 'id', width: 140 },
  { title: '设备', key: 'deviceName', width: 125, render: (row: any) => `${row.deviceName} / ${row.deviceCode}` },
  { title: '班次', key: 'shift', width: 70, render: (row: any) => h(NTag, { size: 'small', bordered: false, type: 'info' }, { default: () => row.shift || '—' }) },
  { title: '区域', key: 'area', width: 90 },
  { title: '状态', key: 'status', width: 90, render: (row: any) => h(NTag, { type: row.stopped ? 'error' : row.status === '已关闭' ? 'success' : row.status === '需复核' ? 'warning' : 'default', bordered: false }, { default: () => row.status }) },
  { title: '并单', key: 'merge', width: 105, render: (row: any) => h('span', { style: 'font-size:12px' }, `${(row.sources || []).join('/') || '—'}${hasConflict(row) ? ' · 冲突两版' : ''}`) },
  { title: '风险', key: 'risk', width: 70 },
  { title: '责任人', key: 'assignedTo', width: 100, render: (row: any) => row.assigneeDisputed ? h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => '责任人待裁' }) : (row.assignedTo || '—') },
  { title: '截止', key: 'dueDate', width: 100, render: (row: any) => row.dueDate || '—' },
  { title: '版本', key: 'version', width: 64, render: (row: any) => `V${row.version}` },
  { title: '', key: 'actions', width: 70, render: (row: any) => h(NButton, { size: 'small', tertiary: true, onClick: () => router.push(`/records/${row.id}`) }, { default: () => '打开' }) }
]

const pendingColumns = [
  { title: '检验编号', key: 'id', width: 150 },
  { title: '设备', key: 'deviceName', width: 160 },
  { title: '区域', key: 'area', width: 100 },
  { title: '检验员', key: 'inspector', width: 110 },
  {
    title: '待核原因', key: 'reason', render: (row: any) => row.pendingReason.join('；')
  },
  {
    title: '核实班次', key: 'shiftResolve', width: 210,
    render: (row: any) => h(NSelect, {
      size: 'small',
      placeholder: '选择班次后转为有效批次',
      options: shiftOptions,
      onUpdateValue: (value: string) => { store.resolveShift(row.id, value); message.success(`${row.id} 已核实为${value}`) }
    })
  }
]

const queueColumns = [
  { title: '记录时刻', key: 'recordedAt', width: 155, render: (row: any) => row.recordedAt.replace('T', ' ').slice(0, 16) },
  { title: '来源', key: 'type', width: 110, render: (row: any) => h(NTag, { size: 'small', bordered: false, type: row.type === '值班室编辑' ? 'warning' : 'info' }, { default: () => row.type }) },
  { title: '设备/班次', key: 'target', width: 140, render: (row: any) => `${row.deviceCode ?? row.targetId ?? '—'} ${row.shift ? `· ${row.shift}` : ''}` },
  { title: '内容', key: 'note' },
  {
    title: '补传状态', key: 'status', width: 230,
    render: (row: any) => row.status === '已合并'
      ? h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => '已合并' })
      : row.status === '失败'
        ? h('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [
            h(NTag, { size: 'small', type: 'error', bordered: false }, { default: () => '失败待重试' }),
            h('small', { style: 'color:#b06a5f' }, row.failReason)
          ])
        : h(NTag, { size: 'small', type: 'default', bordered: false }, { default: () => '留在平板待补传' })
  }
]

const validDraft = computed(() => draft.value.deviceCode && draft.value.deviceName && draft.value.assignedTo && draft.value.dueDate)
const unfinishedQueue = computed(() => store.queue.filter((op) => op.status !== '已合并'))

function createRecord() {
  if (!validDraft.value) return
  const record = store.addRecord(draft.value)
  showCreate.value = false
  message.success(`已创建 ${record.id}`)
  router.push(`/records/${record.id}`)
}

function doSync() {
  const result = store.syncNow()
  if (result.ok) message.success(result.message)
  else message.warning(result.message)
}

function setOnline(value: boolean) {
  store.online = value
  if (value) message.info('网络已回连，可补传未完成项')
  else message.info('园区网络已断开，现场记录将留在平板')
}
</script>

<template>
  <section class="content">
    <div class="metric-strip">
      <article><span>今日有效批次</span><strong>{{ store.stats.total }}</strong><small>看板/详情/审计同一口径</small></article>
      <article><span>停用设备</span><strong>{{ store.stats.blocked }}</strong><small>争议停用不计入，先裁定</small></article>
      <article><span>临近超期</span><strong>{{ store.stats.overdue }}</strong><small>按整改截止日计算</small></article>
      <article><span>已闭环</span><strong>{{ store.stats.closed }}</strong><small>办结依据已留存</small></article>
      <article><span>待核批次</span><strong>{{ store.stats.pending }}</strong><small>旧记录缺班次标识</small></article>
      <article><span>待补传记录</span><strong>{{ store.stats.queued }}</strong><small>失败 {{ store.stats.failed }} 条待重试</small></article>
    </div>

    <div class="net-band">
      <div class="net-state" :class="{ offline: !store.online, fault: store.networkFault }">
        <i />
        <div>
          <strong>{{ store.online ? (store.networkFault ? '回连但网关异常' : '网络在线') : '园区断网中' }}</strong>
          <small v-if="store.lastSyncAt">上次补传 {{ store.lastSyncAt.replace('T', ' ').slice(0, 16) }} · {{ store.lastSyncSummary }}</small>
          <small v-else>断网期间记录留在平板，回连后按设备+班次并单</small>
        </div>
      </div>
      <div class="net-controls">
        <label class="switch-label"><span>网络</span><NSwitch :value="store.online" @update:value="setOnline"><template #checked>在线</template><template #unchecked>断网</template></NSwitch></label>
        <label class="switch-label"><span>模拟补传故障</span><NSwitch v-model:value="store.networkFault" /></label>
        <NButton type="primary" :disabled="!store.online || !unfinishedQueue.length" @click="doSync">
          回连补传（重试 {{ unfinishedQueue.length }} 项）
        </NButton>
        <NButton tertiary @click="store.clearFinishedQueue">清理已合并</NButton>
      </div>
    </div>

    <div v-if="store.pendingRecords.length" class="pending-band">
      <header>
        <strong>待核批次（{{ store.pendingRecords.length }}）</strong>
        <span>旧记录缺班次标识，不参与自动并单，核实后才进入有效批次看板</span>
      </header>
      <NDataTable :columns="pendingColumns" :data="store.pendingRecords" :bordered="false" :row-key="(row: any) => row.id" size="small" />
    </div>

    <div v-if="store.queue.length" class="queue-band">
      <header>
        <strong>平板 / 值班室离线队列</strong>
        <span>断网记录留在本地；回连后合并，重复回连不追加审计</span>
      </header>
      <NDataTable :columns="queueColumns" :data="store.queue" :bordered="false" :row-key="(row: any) => row.uid" size="small" />
    </div>

    <div class="toolbar">
      <NInput v-model:value="store.keyword" clearable placeholder="搜索设备、编号、检验员或责任人" />
      <NSelect v-model:value="store.status" :options="statusOptions" />
      <NSelect v-model:value="store.area" :options="areaOptions" />
      <NButton type="primary" @click="showCreate = true">新建检验任务</NButton>
      <span class="query-state">{{ isFetching ? '正在同步' : '仅显示有效批次' }}</span>
    </div>

    <NDataTable :columns="columns" :data="store.filtered" :bordered="false" :row-key="(row: any) => row.id" size="small" />

    <NModal v-model:show="showCreate" preset="card" title="新建日常检验任务" style="width: 620px">
      <NForm label-placement="left" label-width="92">
        <div class="form-grid">
          <NFormItem label="设备编号" required><NInput v-model:value="draft.deviceCode" placeholder="例如 RC-009" /></NFormItem>
          <NFormItem label="设备名称" required><NInput v-model:value="draft.deviceName" /></NFormItem>
          <NFormItem label="区域"><NSelect v-model:value="draft.area" :options="areaOptions.filter((item) => item.value !== '全部')" /></NFormItem>
          <NFormItem label="班次"><NSelect v-model:value="draft.shift" :options="shiftOptions" /></NFormItem>
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
