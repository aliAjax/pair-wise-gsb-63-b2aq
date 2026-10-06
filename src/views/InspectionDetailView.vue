<script setup lang="ts">
import { computed, h, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDataTable, NInput, NSelect, NTag, useDialog, useMessage } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'
import type { CheckResult, InspectionRecord, InspectionStatus } from '../types'

const route = useRoute()
const router = useRouter()
const store = useInspectionStore()
const message = useMessage()
const dialog = useDialog()
const record = computed(() => store.records.find((item) => item.id === route.params.id))
const form = reactive<Partial<InspectionRecord>>({})
const stopState = computed({
  get: () => form.stopped ? '停用隔离' : '正常开放',
  set: (value: string) => { form.stopped = value === '停用隔离' }
})

watch(record, (value) => {
  if (value) Object.assign(form, structuredClone(value))
}, { immediate: true })

const items = computed(() => record.value?.items ?? [])
const recordRetests = computed(() => store.retests.filter((item) => item.recordId === route.params.id))
const approval = computed(() => record.value ? store.approvals[record.value.id] : undefined)
const transitions: InspectionStatus[] = ['待检验', '需整改', '整改中', '待复测', '已关闭', '停用']

const approvalType = computed(() => approval.value?.decision === '放行' ? 'success' : approval.value?.decision === '不放行' ? 'error' : 'warning')

function save() {
  if (!record.value) return
  store.updateRecord(record.value.id, {
    assignedTo: form.assignedTo,
    dueDate: form.dueDate,
    risk: form.risk,
    stopped: form.stopped,
    shift: form.shift,
    items: form.items
  })
  message.success('检验记录已保存并生成新版本')
}

function changeStatus(next: InspectionStatus) {
  if (!record.value) return
  dialog.warning({
    title: `确认流转至${next}`,
    content: '系统会校验异常项、停用状态和复测要求，并写入操作审计。',
    positiveText: '确认流转',
    negativeText: '取消',
    onPositiveClick: () => {
      const result = store.transition(record.value!.id, next, `由${record.value!.status}流转至${next}`)
      result.ok ? message.success(result.message) : message.error(result.message)
    }
  })
}

function adopt(conflictId: string, sideIndex: 0 | 1) {
  if (!record.value) return
  store.resolveConflict(record.value.id, conflictId, sideIndex)
  message.success('已采用选定版本，放行审批按新值重判')
}

const columns = [
  { title: '检验项', key: 'name', width: 130 },
  { title: '结果', key: 'result', width: 120, render: (row: any, index: number) => h(NSelect, { value: row.result, options: ['正常', '异常', '不适用'].map((value) => ({ label: value, value })), onUpdateValue: (value: CheckResult) => { row.result = value } }) },
  { title: '实测值', key: 'reading', width: 160, render: (row: any) => h(NInput, { value: row.reading, onUpdateValue: (value: string) => { row.reading = value } }) },
  { title: '判定标准', key: 'limit', width: 150 },
  { title: '备注', key: 'note', render: (row: any) => h(NInput, { value: row.note, onUpdateValue: (value: string) => { row.note = value } }) }
]

function exportRecord() {
  if (!record.value) return
  const blob = new Blob([JSON.stringify(record.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${record.value.id}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section v-if="record" class="content detail-layout">
    <div class="detail-main">
      <div v-if="record.syncState === '待核'" class="verify-banner">
        该记录缺班次标识，暂列待核：核对班次前禁止流转与放行，请在下方补齐班次。
      </div>
      <div class="section-head">
        <div>
          <p>{{ record.deviceCode }} · {{ record.area }} · {{ record.shift || '班次待核' }}</p>
          <h2>{{ record.deviceName }}</h2>
        </div>
        <div class="head-actions">
          <NTag :type="record.stopped ? 'error' : record.status === '已关闭' ? 'success' : 'warning'" :bordered="false">{{ record.stopped ? '设备已停用' : record.status }}</NTag>
          <NTag v-if="record.syncState !== '已同步'" size="small" type="warning" :bordered="false">{{ record.syncState }}</NTag>
          <NButton @click="exportRecord">导出记录</NButton>
          <NButton type="primary" @click="save">保存新版本</NButton>
        </div>
      </div>

      <div class="form-band five">
        <label>整改责任人 <NInput v-model:value="form.assignedTo" /></label>
        <label>班次 <NSelect v-model:value="form.shift" :options="['早班', '中班', '晚班'].map((value) => ({ label: value, value }))" placeholder="待核补录" /></label>
        <label>截止日期 <input v-model="form.dueDate" class="native-date" type="date" /></label>
        <label>风险等级 <NSelect v-model:value="form.risk" :options="['低', '中', '高', '紧急'].map((value) => ({ label: value, value }))" /></label>
        <label>设备状态 <NSelect v-model:value="stopState" :options="['正常开放', '停用隔离'].map((value) => ({ label: value, value }))" /></label>
      </div>

      <div v-if="record.conflicts.length" class="merge-conflicts">
        <h3>回连冲突（两版均保留，值班室裁定后生效）</h3>
        <p class="conflict-tip">整改责任人与停用判断仅采用无争议值；以下争议项未自动落库，裁定前放行审批保持待复核。</p>
        <article v-for="conflict in record.conflicts" :key="conflict.id" :class="{ resolved: conflict.resolved }">
          <header>
            <strong>{{ conflict.label }}</strong>
            <NTag size="small" :type="conflict.resolved ? 'success' : 'warning'" :bordered="false">
              {{ conflict.resolved ? `已采用${conflict.adoptedSource}版` : '待裁定' }}
            </NTag>
          </header>
          <div class="conflict-sides">
            <div v-for="(side, index) in conflict.sides" :key="index" class="side">
              <small>{{ side.source }} · 记录于 {{ side.at }}</small>
              <p>{{ side.display }}</p>
              <NButton v-if="!conflict.resolved" size="tiny" tertiary @click="adopt(conflict.id, index as 0 | 1)">采用该版</NButton>
            </div>
          </div>
        </article>
      </div>

      <h3>逐项检验结果</h3>
      <NDataTable :columns="columns" :data="items" :bordered="false" size="small" />

      <div v-if="record.closedBasis" class="closure-panel">
        <strong>办结依据（保留原办结内容）</strong>
        <p>{{ record.closedBasis }}</p>
        <div v-if="record.reviewItems.length" class="review-items">
          并列复审项：<NTag v-for="item in record.reviewItems" :key="item" size="small" type="error" :bordered="false">{{ item }}</NTag>
        </div>
      </div>

      <div class="evidence-panel">
        <div><strong>现场证据</strong><span>{{ record.evidenceCount }} 张照片 · 最近上传 09:31</span></div>
        <div class="evidence-list"><span>锁止间隙近景</span><span>设备铭牌</span><span>制动测试仪表</span><button @click="record.evidenceCount += 1; message.success('已模拟上传现场照片')">上传照片</button></div>
      </div>
    </div>

    <aside class="detail-side">
      <div>
        <span class="side-label">当前流程</span>
        <strong>{{ record.status }}</strong>
        <small>版本 V{{ record.version }} · 更新于 {{ record.updatedAt.replace('T', ' ').slice(0, 16) }}</small>
        <small>有效批次 {{ record.batchId || store.activeBatch?.id || '基线数据' }}</small>
      </div>
      <div v-if="approval" class="approval-panel">
        <span class="side-label">放行审批</span>
        <NTag :type="approvalType" :bordered="false">{{ approval.decision }}</NTag>
        <small>{{ approval.basis }}</small>
      </div>
      <div v-if="recordRetests.length" class="retest-panel">
        <span class="side-label">复测单</span>
        <p v-for="retest in recordRetests" :key="retest.id">
          <NTag size="small" :type="retest.status === '待执行' ? 'warning' : retest.status === '已作废' ? 'error' : 'success'" :bordered="false">{{ retest.status }}</NTag>
          {{ retest.id }} · {{ retest.reason }}
        </p>
      </div>
      <div class="flow-list">
        <button v-for="status in transitions" :key="status" :class="{ active: status === record.status }" @click="changeStatus(status)">
          <span>{{ status }}</span><small>{{ status === record.status ? '当前状态' : '执行流转' }}</small>
        </button>
      </div>
      <div class="rule-note">
        <strong>闭环校验</strong>
        <p>异常项存在时禁止关闭；紧急风险必须先停用设备；停用隔离中的设备不得进入复测。所有操作均写入审计。</p>
      </div>
      <NButton block @click="router.push('/audit')">查看完整审计</NButton>
    </aside>
  </section>
  <section v-else class="content empty-state">未找到检验记录</section>
</template>
