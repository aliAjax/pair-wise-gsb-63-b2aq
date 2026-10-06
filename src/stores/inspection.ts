import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedRecords } from '../data/seed'
import { createOfflineInspection } from '../services/api'
import { mergeOperations, migrateRecord } from '../services/sync'
import type {
  AuditEntry,
  InspectionDraft,
  InspectionRecord,
  InspectionStatus,
  ItemPatch,
  OfflineOperation
} from '../types'

const STORAGE_KEY = 'gsb63:inspection-platform-v2'

interface PersistedState {
  records: InspectionRecord[]
  audit: AuditEntry[]
  queue: OfflineOperation[]
}

function readPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        records: (parsed.records ?? []).map(migrateRecord),
        audit: parsed.audit ?? [],
        queue: parsed.queue ?? []
      }
    }
  } catch {
    /* fall through to seed */
  }
  return { records: seedRecords.map(migrateRecord), audit: structuredClone(seedAudit), queue: [] }
}

let seq = 0
function uid() {
  seq += 1
  return `${Date.now().toString(36)}-${seq}`
}

export const useInspectionStore = defineStore('inspection', () => {
  const initial = readPersisted()
  const records = ref<InspectionRecord[]>(initial.records)
  const audit = ref<AuditEntry[]>(initial.audit)
  const queue = ref<OfflineOperation[]>(initial.queue)
  const keyword = ref('')
  const status = ref<InspectionStatus | '全部'>('全部')
  const area = ref('全部')
  const online = ref(true)
  const networkFault = ref(false)
  const liveMessage = ref('本地实时通道已就绪')
  const lastSyncAt = ref('')
  const lastSyncSummary = ref('')

  /** 看板、详情、审计共用同一份"有效批次"口径：缺班次标识的旧记录先待核 */
  const validRecords = computed(() => records.value.filter((r) => r.verifyState === '有效'))
  const pendingRecords = computed(() => records.value.filter((r) => r.verifyState === '待核'))
  const validIdSet = computed(() => new Set(validRecords.value.map((r) => r.id)))

  const filtered = computed(() => validRecords.value.filter((record) => {
    const haystack = `${record.id} ${record.deviceCode} ${record.deviceName} ${record.inspector} ${record.assignedTo}`.toLowerCase()
    return (!keyword.value || haystack.includes(keyword.value.toLowerCase()))
      && (status.value === '全部' || record.status === status.value)
      && (area.value === '全部' || record.area === area.value)
  }))

  const stats = computed(() => ({
    total: validRecords.value.length,
    blocked: validRecords.value.filter((item) => item.stopped).length,
    overdue: validRecords.value.filter((item) => item.dueDate && item.dueDate < '2026-09-29' && !['已关闭'].includes(item.status)).length,
    closed: validRecords.value.filter((item) => item.status === '已关闭').length,
    pending: pendingRecords.value.length,
    queued: queue.value.filter((op) => op.status !== '已合并').length,
    failed: queue.value.filter((op) => op.status === '失败').length
  }))

  function getRecord(id: string) {
    return records.value.find((item) => item.id === id)
  }

  function addRecord(draft: InspectionDraft) {
    const record = createOfflineInspection(draft)
    records.value.unshift(record)
    addAudit(record.id, '创建检验记录', draft.inspector, '新建设备班次检验任务')
    return record
  }

  function addAudit(recordId: string, action: string, operator: string, detail: string, dedupKey?: string) {
    if (dedupKey && audit.value.some((a) => a.dedupKey === dedupKey)) return
    audit.value.unshift({
      id: `${recordId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      recordId,
      action,
      operator,
      detail,
      createdAt: new Date().toISOString(),
      dedupKey
    })
  }

  // —— 离线队列：断网记录留在平板 / 值班室，恢复后合并 ——
  function enqueueOperation(op: Omit<OfflineOperation, 'uid' | 'status' | 'recordedAt'> & { recordedAt?: string }) {
    queue.value.push({
      ...op,
      uid: uid(),
      recordedAt: op.recordedAt ?? new Date().toISOString(),
      status: '待补传'
    })
  }

  /** 平板现场记录（锁扣、制动油温等），断网时留在平板 */
  function tabletEntry(params: { targetId: string; deviceCode: string; shift: string; operator: string; note: string; patch: ItemPatch; recordedAt?: string }) {
    enqueueOperation({ type: '现场录入', ...params })
  }

  /** 值班室改同张设备单 */
  function dutyEdit(params: { targetId: string; deviceCode: string; shift: string; operator: string; note: string; patch: ItemPatch; recordedAt?: string }) {
    enqueueOperation({ type: '值班室编辑', ...params })
  }

  function tabletNewBatch(params: { deviceCode: string; deviceName: string; area: string; shift: string; operator: string; note: string; recordedAt?: string }) {
    enqueueOperation({ type: '新建批次', ...params })
  }

  /** 回连补传：只处理未完成项；已合并项不重复入库、不追加审计（幂等） */
  function syncNow() {
    if (!online.value) return { ok: false, message: '仍处于断网状态，无法补传' }
    if (networkFault.value) {
      queue.value.forEach((op) => {
        if (op.status !== '已合并') {
          op.status = '失败'
          op.failReason = '网络不可达，补传失败，恢复后重试未完成项'
        }
      })
      lastSyncSummary.value = '补传失败：网络不可达，未完成项已保留待重试'
      return { ok: false, message: lastSyncSummary.value }
    }

    const pending = queue.value.filter((op) => op.status !== '已合并')
    if (!pending.length) {
      lastSyncSummary.value = '重复回连：无未完成项，未追加审计'
      return { ok: true, message: lastSyncSummary.value, repeated: true }
    }

    const result = mergeOperations(records.value, pending, audit.value)
    records.value = result.records
    lastSyncAt.value = new Date().toISOString()
    const parts: string[] = []
    if (result.merged.length) parts.push(`合并 ${result.merged.length} 条`)
    if (result.voidedRechecks) parts.push(`作废未执行复测 ${result.voidedRechecks} 项`)
    if (result.releaseReset) parts.push(`放行按新值重判 ${result.releaseReset} 单`)
    if (result.reviewsAdded) parts.push(`办结单列复审项 ${result.reviewsAdded} 项`)
    const failed = pending.filter((op) => op.status === '失败')
    if (failed.length) parts.push(`${failed.length} 条失败待重试`)
    lastSyncSummary.value = parts.join('，') || '无变更'
    return { ok: !failed.length, message: lastSyncSummary.value }
  }

  function clearFinishedQueue() {
    queue.value = queue.value.filter((op) => op.status !== '已合并')
  }

  // —— 待核处理 ——
  function resolveShift(id: string, shift: string, operator = '值班主管') {
    const record = getRecord(id)
    if (!record || !shift) return
    record.shift = shift
    record.verifyState = '有效'
    record.pendingReason = record.pendingReason.filter((reason) => !reason.includes('班次'))
    record.version += 1
    record.updatedAt = new Date().toISOString()
    addAudit(id, '班次核实', operator, `缺班次旧记录核实为${shift}，批次转为有效`)
  }

  function resolveAssignee(id: string, assignedTo: string, operator = '值班主管') {
    const record = getRecord(id)
    if (!record) return
    record.assignedTo = assignedTo
    record.assigneeDisputed = false
    record.pendingReason = record.pendingReason.filter((reason) => !reason.includes('整改责任人'))
    record.version += 1
    record.updatedAt = new Date().toISOString()
    addAudit(id, '争议裁定', operator, `整改责任人争议裁定为：${assignedTo}`)
  }

  function resolveStopped(id: string, stopped: boolean, operator = '值班主管') {
    const record = getRecord(id)
    if (!record) return
    record.stopped = stopped
    record.stoppedDisputed = false
    record.pendingReason = record.pendingReason.filter((reason) => !reason.includes('停用判断'))
    record.version += 1
    record.updatedAt = new Date().toISOString()
    addAudit(id, '争议裁定', operator, `停用判断争议裁定为：${stopped ? '停用隔离' : '正常开放'}`)
  }

  // —— 在线直接编辑（同样走结果联动） ——
  function saveInspection(id: string, patch: {
    assignedTo?: string
    dueDate?: string
    risk?: InspectionRecord['risk']
    stopped?: boolean
    items?: InspectionRecord['items']
  }, operator = '当前用户') {
    const record = getRecord(id)
    if (!record) return
    const before = new Map(record.items.map((i) => [i.id, { ...i }]))
    const at = new Date().toISOString()

    if (patch.items) {
      patch.items.forEach((incoming) => {
        const item = record.items.find((i) => i.id === incoming.id)
        if (!item) return
        const changed = incoming.result !== item.result || incoming.reading !== item.reading || incoming.note !== item.note
        if (changed) {
          item.versions.push({ source: '值班室', operator, recordedAt: at, result: incoming.result, reading: incoming.reading, note: incoming.note })
          item.result = incoming.result
          item.reading = incoming.reading
          item.note = incoming.note
          item.resultConflict = new Set(item.versions.map((v) => v.result)).size > 1
          item.readingConflict = new Set(item.versions.map((v) => v.reading)).size > 1
        }
      })
    }
    if (patch.assignedTo !== undefined) record.assignedTo = patch.assignedTo
    if (patch.dueDate !== undefined) record.dueDate = patch.dueDate
    if (patch.risk !== undefined) record.risk = patch.risk
    if (patch.stopped !== undefined) record.stopped = patch.stopped

    record.version += 1
    record.updatedAt = at
    cascadeAfterChange(record, Array.from(before.keys()), before, operator, at)
    addAudit(id, '保存检验记录', operator, `记录更新至版本 V${record.version}`)
  }

  function cascadeAfterChange(
    record: InspectionRecord,
    changedIds: string[],
    before: Map<string, { result: string; reading: string }>,
    operator: string,
    at: string
  ) {
    const realChanges = changedIds.filter((id) => {
      const b = before.get(id)
      const now = record.items.find((i) => i.id === id)
      return b && now && (b.result !== now.result || b.reading !== now.reading)
    })
    if (!realChanges.length) return

    record.rechecks.forEach((rc) => {
      if (realChanges.includes(rc.itemId) && rc.status === '待复测') {
        rc.status = '已作废'
        rc.voidedAt = at
        rc.voidReason = '检验结果改动，未执行复测作废，按新值重新判定'
        addAudit(record.id, '复测作废', operator, `「${rc.itemName}」结果改动，原复测单 ${rc.id} 作废`)
      }
    })

    if (record.release.state === '已放行' || record.release.state === '驳回') {
      addAudit(record.id, '放行重判', operator, '检验结果改动，原放行结论失效，按新值重新判定')
      record.release = { state: '待判定' }
    }

    if (record.status === '已关闭' && record.closure) {
      realChanges.forEach((id) => {
        const b = before.get(id)!
        const now = record.items.find((i) => i.id === id)!
        record.reviews.push({
          id: `RV-${id}-${record.reviews.length + 1}`,
          field: now.name,
          original: `${b.result} / ${b.reading}`,
          changedTo: `${now.result} / ${now.reading}`,
          reason: '办结后结果改动，保留原依据并列复审',
          createdAt: at
        })
      })
      record.status = '需复核'
      addAudit(record.id, '办结回退', operator, '办结批次结果改动：原办结依据保留，并列复审项后转需复核')
    }
  }

  // —— 状态流转 / 复测 / 放行 / 办结 ——
  function transition(id: string, next: InspectionStatus, detail: string) {
    const record = getRecord(id)
    if (!record) return { ok: false, message: '记录不存在' }
    if (record.verifyState === '待核') return { ok: false, message: '批次待核：先补齐班次标识' }
    if (next === '已关闭' && record.items.some((item) => item.result === '异常')) {
      return { ok: false, message: '仍有异常项，不能关闭任务' }
    }
    if (next === '待复测') {
      if (record.stoppedDisputed) return { ok: false, message: '停用判断存在争议，禁止进入复测，请先由值班主管裁定' }
      if (record.stopped && record.release.state !== '已放行') return { ok: false, message: '停用设备须先通过放行审批，才能安排复测' }
      if (record.assigneeDisputed) return { ok: false, message: '整改责任人存在争议，请先裁定' }
    }
    if (next === '已关闭' && !record.closure) {
      record.closure = {
        closedAt: new Date().toISOString(),
        status: record.status,
        stopped: record.stopped,
        risk: record.risk,
        assignedTo: record.assignedTo,
        operator: '当前用户',
        items: record.items.map(({ versions: _v, resultConflict: _r, readingConflict: _g, ...rest }) => ({ ...rest }))
      }
    }
    record.status = next
    record.version += 1
    record.updatedAt = new Date().toISOString()
    addAudit(id, `状态流转：${next}`, '当前用户', detail)
    return { ok: true, message: `已流转至${next}` }
  }

  function createRecheck(id: string, itemId: string, reason: string) {
    const record = getRecord(id)
    const item = record?.items.find((i) => i.id === itemId)
    if (!record || !item) return { ok: false, message: '检验项不存在' }
    if (record.stoppedDisputed) return { ok: false, message: '停用判断有争议，停用设备不得进入复测' }
    if (record.stopped && record.release.state !== '已放行') return { ok: false, message: '停用设备须先通过放行审批' }
    const order = {
      id: `RC-${record.deviceCode}-${record.rechecks.length + 1}`,
      itemId,
      itemName: item.name,
      status: '待复测' as const,
      reason,
      createdAt: new Date().toISOString()
    }
    record.rechecks.push(order)
    addAudit(id, '新建复测单', '当前用户', `「${item.name}」建立复测单 ${order.id}：${reason}`)
    return { ok: true, message: `已建立复测单 ${order.id}` }
  }

  function completeRecheck(id: string, recheckId: string) {
    const record = getRecord(id)
    const order = record?.rechecks.find((r) => r.id === recheckId)
    if (!record || !order) return
    if (order.status !== '待复测') return
    order.status = '已完成'
    addAudit(id, '复测完成', '当前用户', `复测单 ${order.id}（${order.itemName}）已完成；结果改动不会追溯作废已完成复测`)
  }

  /** 放行审批按当前（新）值重判 */
  function decideRelease(id: string, approve: boolean, operator = '值班主管') {
    const record = getRecord(id)
    if (!record) return { ok: false, message: '记录不存在' }
    if (record.stoppedDisputed) return { ok: false, message: '停用判断有争议，不能放行' }
    const hasAbnormal = record.items.some((i) => i.result === '异常')
    const hasConflict = record.items.some((i) => i.resultConflict || i.readingConflict)
    if (approve && hasAbnormal) return { ok: false, message: '按新值仍有异常项，不能放行' }
    if (approve && hasConflict) return { ok: false, message: '存在冲突值两版未统一，不能放行' }
    const at = new Date().toISOString()
    record.release = approve
      ? { state: '已放行', decidedAt: at, basis: `按合并后有效值判定：${record.items.every((i) => i.result === '正常') ? '全部项目正常' : '无异常项'}`, reason: '' }
      : { state: '驳回', decidedAt: at, basis: '', reason: '按新值判定不满足放行条件' }
    addAudit(id, approve ? '放行通过' : '放行驳回', operator, approve ? '按合并后新值审批通过，可安排复测/开放' : '按新值审批驳回')
    return { ok: true, message: approve ? '已放行' : '已驳回' }
  }

  function requestRelease(id: string) {
    const record = getRecord(id)
    if (!record) return
    if (record.release.state === '已放行') return
    record.release = { state: '待判定' }
    addAudit(id, '放行申请', '当前用户', '提交放行审批，系统将按当前有效值判定')
  }

  function resetDemo() {
    records.value = seedRecords.map(migrateRecord)
    audit.value = structuredClone(seedAudit)
    queue.value = []
    online.value = true
    networkFault.value = false
    lastSyncAt.value = ''
    lastSyncSummary.value = ''
  }

  watch([records, audit, queue, online, networkFault], () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ records: records.value, audit: audit.value, queue: queue.value }))
  }, { deep: true })

  return {
    records, audit, queue, online, networkFault, liveMessage, lastSyncAt, lastSyncSummary,
    keyword, status, area,
    filtered, validRecords, pendingRecords, validIdSet, stats,
    getRecord, addRecord, saveInspection, transition,
    enqueueOperation, tabletEntry, dutyEdit, tabletNewBatch, syncNow, clearFinishedQueue,
    resolveShift, resolveAssignee, resolveStopped,
    createRecheck, completeRecheck, requestRelease, decideRelease,
    resetDemo
  }
})
