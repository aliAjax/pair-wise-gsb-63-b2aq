<script setup lang="ts">
import { computed, h, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NDataTable, NInput, NSelect, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useInspectionStore } from '../stores/inspection'
import type { CheckResult, InspectionRecord, InspectionStatus } from '../types'

const route = useRoute()
const router = useRouter()
const store = useInspectionStore()
const message = useMessage()
const dialog = useDialog()
const record = computed(() => store.getRecord(String(route.params.id)))
const isValid = computed(() => record.value?.verifyState === '有效')
const form = reactive<Partial<InspectionRecord>>({})

const offlineForm = reactive({
  source: '平板' as '平板' | '值班室',
  itemId: 'lock',
  result: '异常' as CheckResult,
  reading: '',
  note: '',
  recordedAt: ''
})

watch(record, (value) => {
  if (value) Object.assign(form, structuredClone(value))
}, { immediate: true })

const items = computed(() => record.value?.items ?? [])
const transitions: InspectionStatus[] = ['待检验', '需整改', '整改中', '待复测', '需复核', '已关闭', '停用']
const shiftOptions = ['早班', '中班', '晚班'].map((value) => ({ label: value, value }))

const stopState = computed({
  get: () => form.stopped ? '停用隔离' : '正常开放',
  set: (value: string) => { form.stopped = value === '停用隔离' }
})

function save() {
  if (!record.value) return
  const payload = {
    assignedTo: form.assignedTo,
    dueDate: form.dueDate,
    risk: form.risk,
    stopped: form.stopped,
    items: form.items
  }
  if (!store.online) {
    // 断网：值班室改动留在本地队列，回连后合并
    const changedItem = payload.items?.find((i) => i.result !== record.value?.items.find((x) => x.id === i.id)?.result
      || i.reading !== record.value?.items.find((x) => x.id === i.id)?.reading)
    store.enqueueOperation({
      type: '值班室编辑',
      targetId: record.value.id,
      deviceCode: record.value.deviceCode,
      shift: record.value.shift,
      operator: '值班室',
      note: '值班室离线编辑设备单（责任/停用/检验项）',
      patch: {
        assignedTo: payload.assignedTo,
        stopped: payload.stopped,
        ...(changedItem ? { itemId: changedItem.id, result: changedItem.result, reading: changedItem.reading } : {})
      }
    })
    message.warning('当前断网：改动已留在值班室队列，回连后合并，不会覆盖平板版本')
    return
  }
  store.saveInspection(record.value.id, payload)
  message.success('检验记录已保存并生成新版本')
}

function changeStatus(next: InspectionStatus) {
  if (!record.value) return
  dialog.warning({
    title: `确认流转至${next}`,
    content: '系统会校验异常项、停用争议、放行状态和复测要求，并写入操作审计。',
    positiveText: '确认流转',
    negativeText: '取消',
    onPositiveClick: () => {
      const result = store.transition(record.value!.id, next, `由${record.value!.status}流转至${next}`)
      result.ok ? message.success(result.message) : message.error(result.message)
    }
  })
}

function renderVersions(row: any) {
  const versions = row.versions ?? []
  const tags = versions.map((v: any, idx: number) =>
    h(NTag, {
      size: 'small',
      bordered: false,
      type: v.source === '平板' ? 'info' : 'warning',
      style: 'margin-right:4px'
    }, { default: () => `${v.source}·${(v.recordedAt || '').replace('T', ' ').slice(5, 16)} ${v.result}/${v.reading || '—'}${idx === versions.length - 1 ? '（有效）' : ''}` })
  )
  return h('div', { style: 'display:flex;flex-wrap:wrap;gap:2px' }, tags)
}

const columns = [
  { title: '检验项', key: 'name', width: 110 },
  { title: '结果', key: 'result', width: 110, render: (row: any, index: number) => h(NSelect, { value: row.result, options: ['正常', '异常', '不适用'].map((value) => ({ label: value, value })), onUpdateValue: (value: CheckResult) => { row.result = value } }) },
  { title: '实测值', key: 'reading', width: 150, render: (row: any) => h(NInput, { value: row.reading, onUpdateValue: (value: string) => { row.reading = value } }) },
  { title: '判定标准', key: 'limit', width: 120 },
  {
    title: '并单版本（冲突保留两版）', key: 'versions',
    render: (row: any) => h('div', null, [
      h('div', null, renderVersions(row)),
      row.resultConflict || row.readingConflict
        ? h(NTag, { size: 'small', type: 'error', bordered: false, style: 'margin-top:3px' }, { default: () => `冲突：${[row.resultConflict && '结果', row.readingConflict && '读数'].filter(Boolean).join('、')}两版不一致，有效值取记录时刻最新版` })
        : h('small', { style: 'color:#8a9895' }, '多源一致')
    ])
  }
]

// —— 离线录入（平板锁扣 / 值班室制动油温场景） ——
function queueOfflineEntry() {
  if (!record.value) return
  const params = {
    targetId: record.value.id,
    deviceCode: record.value.deviceCode,
    shift: record.value.shift,
    operator: offlineForm.source === '平板' ? (record.value.inspector || '检验员') : '值班室',
    note: `${offlineForm.source}记录「${items.value.find((i) => i.id === offlineForm.itemId)?.name}」：${offlineForm.result} ${offlineForm.reading}`.trim(),
    recordedAt: offlineForm.recordedAt || undefined,
    patch: { itemId: offlineForm.itemId, result: offlineForm.result, reading: offlineForm.reading, note: offlineForm.note }
  }
  if (offlineForm.source === '平板') store.tabletEntry(params)
  else store.dutyEdit(params)
  message.success(`断网记录已留在${offlineForm.source}，回连后按记录时刻并单`)
  offlineForm.reading = ''
  offlineForm.note = ''
}

/** 一键：早班平板记录座舱锁扣 */
function simulateTablet() {
  if (!record.value) return
  store.tabletEntry({
    targetId: record.value.id, deviceCode: record.value.deviceCode, shift: record.value.shift,
    operator: record.value.inspector || '早班检验员', note: '平板记录座舱锁扣：锁止机构异常',
    recordedAt: '2026-10-06T08:15:00',
    patch: { itemId: 'lock', result: '异常', reading: '锁扣间隙偏大', note: '座舱锁扣回弹' }
  })
  message.success('早班平板锁扣记录已留在本地')
}

/** 一键：晚班值班室改同张设备单（制动油温） */
function simulateDuty() {
  if (!record.value) return
  store.dutyEdit({
    targetId: record.value.id, deviceCode: record.value.deviceCode, shift: record.value.shift,
    operator: '晚班值班员', note: '值班室改同张设备单：制动油温偏高',
    recordedAt: '2026-10-06T20:40:00',
    patch: { itemId: 'brake', result: '异常', reading: '制动油温 92℃', note: '高于限值' }
  })
  message.success('晚班值班室改动已留在本地')
}

/** 一键复现：早班平板锁扣异常 vs 晚班值班室改同张单（制动油温+整改人） */
function simulateStory() {
  if (!record.value) return
  store.tabletEntry({
    targetId: record.value.id, deviceCode: record.value.deviceCode, shift: record.value.shift,
    operator: record.value.inspector || '早班检验员', note: '平板记录座舱锁扣：锁止机构异常',
    recordedAt: '2026-10-06T08:15:00',
    patch: { itemId: 'lock', result: '异常', reading: '锁扣间隙偏大', note: '座舱锁扣回弹' }
  })
  store.dutyEdit({
    targetId: record.value.id, deviceCode: record.value.deviceCode, shift: record.value.shift,
    operator: '晚班值班员', note: '值班室改同张设备单：制动油温偏高',
    recordedAt: '2026-10-06T20:40:00',
    patch: { itemId: 'brake', result: '异常', reading: '制动油温 92℃', note: '高于限值' }
  })
  store.dutyEdit({
    targetId: record.value.id, deviceCode: record.value.deviceCode, shift: record.value.shift,
    operator: '晚班值班员', note: '值班室改整改责任人为电气班组',
    recordedAt: '2026-10-06T20:42:00',
    patch: { assignedTo: '电气班组' }
  })
  message.success('已构造断网场景：早班平板锁扣记录 + 晚班值班室改动，回连后可补传并单')
}

// —— 复测 ——
const recheckForm = reactive({ itemId: 'lock', reason: '' })
function addRecheck() {
  if (!record.value) return
  const result = store.createRecheck(record.value.id, recheckForm.itemId, recheckForm.reason || '整改后复测')
  result.ok ? message.success(result.message) : message.error(result.message)
  recheckForm.reason = ''
}

function closureColumns(closureItems: any[]) {
  return [
    { title: '检验项', key: 'name', width: 130 },
    { title: '原结果', key: 'result', width: 100 },
    { title: '原实测值', key: 'reading', width: 160 }
  ]
}

function approveRelease() {
  if (!record.value) return
  const r = store.decideRelease(record.value.id, true)
  if (r.ok) message.success(r.message)
  else message.error(r.message)
}

function rejectRelease() {
  if (!record.value) return
  const r = store.decideRelease(record.value.id, false)
  if (r.ok) message.success(r.message)
  else message.error(r.message)
}

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
      <div class="section-head">
        <div>
          <p>{{ record.deviceCode }} · {{ record.area }} · {{ record.shift || '班次待核' }} · 批次{{ record.verifyState }}</p>
          <h2>{{ record.deviceName }}</h2>
          <small class="merge-line">
            来源：{{ (record.sources || []).join(' / ') || '历史导入' }}
            <template v-if="record.lastMergedAt"> · 最近并单 {{ record.lastMergedAt.replace('T', ' ').slice(0, 16) }}</template>
          </small>
        </div>
        <div class="head-actions">
          <NTag :type="record.stopped ? 'error' : record.status === '已关闭' ? 'success' : 'warning'" :bordered="false">{{ record.stopped ? '设备已停用' : record.status }}</NTag>
          <NButton @click="exportRecord">导出记录</NButton>
          <NButton type="primary" @click="save">{{ store.online ? '保存新版本' : '断网：留存值班室' }}</NButton>
        </div>
      </div>

      <div v-if="record.verifyState === '待核'" class="warn-band">
        <strong>批次待核：</strong>{{ record.pendingReason.join('；') }}
        <span class="inline-resolve">
          核实班次：
          <NSelect size="tiny" style="width: 110px" :options="shiftOptions" @update:value="(v: string) => store.resolveShift(record!.id, v)" placeholder="选择班次" />
        </span>
      </div>
      <div v-for="reason in record.pendingReason.filter((r) => !r.includes('班次'))" :key="reason" class="warn-band">
        <strong>争议待裁定：</strong>{{ reason }}
      </div>

      <div v-if="record.assigneeDisputed || record.stoppedDisputed" class="dispute-band">
        <template v-if="record.assigneeDisputed">
          <label>整改责任人争议裁定
            <NInput size="small" style="width: 150px" placeholder="输入裁定责任人" @keydown.enter="(e: any) => { store.resolveAssignee(record!.id, e.target.value); e.target.value = '' }" />
          </label>
        </template>
        <template v-if="record.stoppedDisputed">
          <label>停用判断争议裁定
            <NSelect size="small" style="width: 150px" :options="['正常开放', '停用隔离'].map((v) => ({ label: v, value: v }))" @update:value="(v: string) => store.resolveStopped(record!.id, v === '停用隔离')" />
          </label>
        </template>
      </div>

      <div class="form-band">
        <label>整改责任人 <NInput v-model:value="form.assignedTo" :disabled="record.assigneeDisputed" /></label>
        <label>截止日期 <input v-model="form.dueDate" class="native-date" type="date" /></label>
        <label>风险等级 <NSelect v-model:value="form.risk" :options="['低', '中', '高', '紧急'].map((value) => ({ label: value, value }))" /></label>
        <label>设备状态 <NSelect v-model:value="stopState" :options="['正常开放', '停用隔离'].map((value) => ({ label: value, value }))" :disabled="record.stoppedDisputed" /></label>
      </div>

      <h3>逐项检验结果（并单后有效值）</h3>
      <NDataTable :columns="columns" :data="items" :bordered="false" size="small" />

      <div class="offline-panel">
        <header>
          <strong>断网记录入口</strong>
          <span>网络：<NSwitch size="small" :value="store.online" @update:value="(v: boolean) => (store.online = v)"><template #checked>在线</template><template #unchecked>断网</template></NSwitch></span>
        </header>
        <p class="panel-note">断网时平板/值班室的记录先留在本地，回连后按同设备同班次、记录时刻并单；冲突值保留两版。</p>
        <div class="offline-form">
          <label>来源 <NSelect v-model:value="offlineForm.source" size="small" style="width: 104px" :options="[{ label: '平板', value: '平板' }, { label: '值班室', value: '值班室' }]" /></label>
          <label>检验项 <NSelect v-model:value="offlineForm.itemId" size="small" style="width: 130px" :options="items.map((i) => ({ label: i.name, value: i.id }))" /></label>
          <label>结果 <NSelect v-model:value="offlineForm.result" size="small" style="width: 100px" :options="['正常', '异常', '不适用'].map((v) => ({ label: v, value: v }))" /></label>
          <label>读数 <NInput v-model:value="offlineForm.reading" size="small" style="width: 160px" placeholder="如 制动油温 92℃" /></label>
          <label>记录时刻 <NInput v-model:value="offlineForm.recordedAt" size="small" style="width: 190px" placeholder="2026-10-06T08:15:00" /></label>
          <NButton size="small" type="primary" @click="queueOfflineEntry">留在本地</NButton>
          <NButton size="small" tertiary @click="simulateTablet">一键：平板锁扣记录</NButton>
          <NButton size="small" tertiary @click="simulateDuty">一键：值班室改油温</NButton>
          <NButton size="small" quaternary @click="simulateStory">构造早/晚班完整冲突场景</NButton>
        </div>
      </div>

      <div class="recheck-panel">
        <header><strong>复测单</strong><span>结果改动后未执行的复测自动作废；已完成复测不追溯</span></header>
        <div v-if="!record.rechecks.length" class="panel-note">暂无复测单</div>
        <div v-for="rc in record.rechecks" :key="rc.id" class="recheck-row" :class="rc.status">
          <NTag size="small" :bordered="false" :type="rc.status === '已完成' ? 'success' : rc.status === '已作废' ? 'error' : 'warning'">{{ rc.status }}</NTag>
          <strong>{{ rc.id }} · {{ rc.itemName }}</strong>
          <span>{{ rc.reason }}</span>
          <small>建单 {{ rc.createdAt.replace('T', ' ').slice(5, 16) }}</small>
          <small v-if="rc.voidReason" class="void-reason">{{ rc.voidReason }}</small>
          <NButton v-if="rc.status === '待复测'" size="tiny" @click="store.completeRecheck(record!.id, rc.id)">完成复测</NButton>
        </div>
        <div class="offline-form">
          <label>检验项 <NSelect v-model:value="recheckForm.itemId" size="small" style="width: 130px" :options="items.map((i) => ({ label: i.name, value: i.id }))" /></label>
          <label>复测原因 <NInput v-model:value="recheckForm.reason" size="small" style="width: 240px" placeholder="如 整改后复测" /></label>
          <NButton size="small" @click="addRecheck">新建复测单</NButton>
          <small v-if="record.stoppedDisputed" class="void-reason">停用判断有争议，停用设备禁止进入复测</small>
          <small v-else-if="record.stopped && record.release.state !== '已放行'" class="void-reason">停用设备须先通过放行审批</small>
        </div>
      </div>

      <div v-if="record.closure" class="closure-panel">
        <header><strong>办结留档</strong><span>原办结依据保留；结果改动后转「需复核」并按下列复审项复审</span></header>
        <p class="panel-note">
          办结于 {{ record.closure.closedAt.replace('T', ' ').slice(0, 16) }} · 办结人 {{ record.closure.operator }}
          · 原状态 {{ record.closure.status }} · 原停用 {{ record.closure.stopped ? '是' : '否' }} · 原责任人 {{ record.closure.assignedTo }}
        </p>
        <NDataTable :columns="closureColumns(record.closure.items)" :data="record.closure.items" :bordered="false" size="small" />
        <div v-if="record.reviews.length" class="review-list">
          <h4>复审项（{{ record.reviews.length }}）</h4>
          <div v-for="rv in record.reviews" :key="rv.id" class="review-row">
            <NTag size="small" type="warning" :bordered="false">待复审</NTag>
            <strong>{{ rv.field }}</strong>
            <span>原依据：{{ rv.original }}</span>
            <span>新值：{{ rv.changedTo }}</span>
            <small>{{ rv.reason }}</small>
          </div>
        </div>
      </div>
    </div>

    <aside class="detail-side">
      <div>
        <span class="side-label">当前流程</span>
        <strong>{{ record.status }}</strong>
        <small>版本 V{{ record.version }} · 更新于 {{ record.updatedAt.replace('T', ' ').slice(0, 16) }}</small>
      </div>
      <div class="flow-list">
        <button v-for="s in transitions" :key="s" :class="{ active: s === record.status, disabled: !isValid }" @click="changeStatus(s)">
          <span>{{ s }}</span><small>{{ s === record.status ? '当前状态' : '执行流转' }}</small>
        </button>
      </div>

      <div class="release-box">
        <span class="side-label">放行审批（按当前新值）</span>
        <NTag size="small" :bordered="false" :type="record.release.state === '已放行' ? 'success' : record.release.state === '驳回' ? 'error' : record.release.state === '待判定' ? 'warning' : 'default'">
          {{ record.release.state }}
        </NTag>
        <p v-if="record.release.basis" class="panel-note">{{ record.release.basis }}</p>
        <p v-if="record.release.reason" class="void-reason">{{ record.release.reason }}</p>
        <div class="release-actions">
          <NButton size="tiny" @click="record && store.requestRelease(record.id)">提交放行</NButton>
          <NButton size="tiny" type="primary" @click="approveRelease">通过(按新值)</NButton>
          <NButton size="tiny" @click="rejectRelease">驳回</NButton>
        </div>
      </div>

      <div class="rule-note">
        <strong>闭环校验</strong>
        <p>异常项存在时禁止关闭；停用判断/整改人有争议只采用无争议值；停用设备须先放行再复测；结果改动后复测作废、放行重判、办结留原依据并列复审项。</p>
      </div>
      <NButton block @click="router.push('/audit')">查看完整审计</NButton>
    </aside>
  </section>
  <section v-else class="content empty-state">
    未找到检验记录（待核批次请先在总览核实班次）
    <div style="margin-top:10px"><NButton @click="router.push('/')">返回总览</NButton></div>
  </section>
</template>
