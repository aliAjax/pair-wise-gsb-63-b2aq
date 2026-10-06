import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedApprovals, seedAudit, seedOfflineOps, seedRecords, seedRetests } from '../data/seed'
import { createOfflineInspection } from '../services/api'
import { adoptConflictSide, judgeRelease, mergeOpsInto } from '../services/sync'
import type { AuditEntry, InspectionDraft, InspectionRecord, InspectionStatus, OfflineOp, ReleaseApproval, RetestOrder, SyncBatch } from '../types'

const STORAGE_KEY = 'gsb63:inspection-platform'

interface PersistedState {
  records: InspectionRecord[]
  audit: AuditEntry[]
  batches: SyncBatch[]
  retests: RetestOrder[]
  approvals: Record<string, ReleaseApproval>
  offlineQueue: OfflineOp[]
  mergedOpIds: string[]
  online: boolean
}

function normalizeRecord(raw: Partial<InspectionRecord> & { shift?: string }): InspectionRecord {
  return {
    batchId: '',
    conflicts: [],
    closedBasis: '',
    reviewItems: [],
    ...raw,
    // 旧记录缺班次标识先待核，核对班次前不参与并单与流转
    syncState: !raw.shift ? '待核' : (raw.syncState ?? '已同步')
  } as InspectionRecord
}

function readPersisted(): PersistedState {
  const fallback: PersistedState = {
    records: seedRecords,
    audit: seedAudit,
    batches: [],
    retests: seedRetests,
    approvals: seedApprovals,
    offlineQueue: seedOfflineOps,
    mergedOpIds: [],
    online: true
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    if (!Array.isArray(parsed.records)) return fallback
    return {
      records: parsed.records.map(normalizeRecord),
      audit: parsed.audit ?? seedAudit,
      batches: parsed.batches ?? [],
      retests: parsed.retests ?? structuredClone(seedRetests),
      approvals: parsed.approvals ?? structuredClone(seedApprovals),
      offlineQueue: parsed.offlineQueue ?? structuredClone(seedOfflineOps),
      mergedOpIds: parsed.mergedOpIds ?? [],
      online: parsed.online ?? true
    }
  } catch {
    return fallback
  }
}

export const useInspectionStore = defineStore('inspection', () => {
  const initial = readPersisted()
  const records = ref<InspectionRecord[]>(initial.records)
  const audit = ref<AuditEntry[]>(initial.audit)
  const batches = ref<SyncBatch[]>(initial.batches)
  const retests = ref<RetestOrder[]>(initial.retests)
  const approvals = ref<Record<string, ReleaseApproval>>(initial.approvals)
  const offlineQueue = ref<OfflineOp[]>(initial.offlineQueue)
  const mergedOpIds = ref<string[]>(initial.mergedOpIds)
  const online = ref(initial.online)
  const keyword = ref('')
  const status = ref<InspectionStatus | '全部'>('全部')
  const area = ref('全部')
  const liveMessage = ref(online.value ? '本地实时通道已就绪' : '断网中：记录留在平板本机')

  const filtered = computed(() => records.value.filter((record) => {
    const haystack = `${record.id} ${record.deviceCode} ${record.deviceName} ${record.inspector} ${record.assignedTo}`.toLowerCase()
    return (!keyword.value || haystack.includes(keyword.value.toLowerCase()))
      && (status.value === '全部' || record.status === status.value)
      && (area.value === '全部' || record.area === area.value)
  }))

  const stats = computed(() => ({
    total: records.value.length,
    blocked: records.value.filter((item) => item.stopped).length,
    overdue: records.value.filter((item) => item.dueDate < '2026-09-29' && !['已关闭'].includes(item.status)).length,
    closed: records.value.filter((item) => item.status === '已关闭').length,
    pendingVerify: records.value.filter((item) => item.syncState === '待核').length
  }))

  const pendingOps = computed(() => offlineQueue.value.filter((op) => !op.failed))
  const failedOps = computed(() => offlineQueue.value.filter((op) => op.failed))
  const activeBatch = computed(() => batches.value[0] ?? null)

  function addAudit(recordId: string, action: string, operator: string, detail: string, batchId?: string) {
    audit.value.unshift({
      id: `${recordId}-${Date.now()}-${audit.value.length}`,
      recordId,
      action,
      operator,
      detail,
      batchId,
      createdAt: new Date().toISOString()
    })
  }

  function rejudgeApproval(record: InspectionRecord, batchId?: string) {
    const next = judgeRelease(record, new Date().toISOString())
    const prev = approvals.value[record.id]
    approvals.value[record.id] = next
    if (!prev || prev.decision !== next.decision || prev.basis !== next.basis) {
      addAudit(record.id, '放行审批重判', '系统', `${next.decision} · ${next.basis}`, batchId)
    }
  }

  function enqueueOffline(record: InspectionRecord) {
    offlineQueue.value.push({
      opId: `OP-${record.id}-${Date.now().toString().slice(-6)}`,
      source: '平板',
      record: structuredClone(record),
      failed: false,
      failOnce: false,
      attempted: 0
    })
  }

  function addRecord(draft: InspectionDraft) {
    const record = createOfflineInspection(draft)
    if (!online.value) {
      record.syncState = '待同步'
      enqueueOffline(record)
    }
    records.value.unshift(record)
    addAudit(record.id, '创建检验记录', draft.inspector, online.value ? '新建设备班次检验任务' : '断网离线建档，记录留在平板待补传')
    rejudgeApproval(record)
    return record
  }

  function updateRecord(id: string, patch: Partial<InspectionRecord>, action = '保存检验记录') {
    const record = records.value.find((item) => item.id === id)
    if (!record) return
    const verified = record.syncState === '待核' && Boolean(patch.shift)
    Object.assign(record, patch, { version: record.version + 1, updatedAt: new Date().toISOString() })
    if (verified) {
      record.syncState = '已同步'
      addAudit(id, '班次核对', '当前用户', `补齐班次标识「${patch.shift}」，记录解除待核`)
    }
    if (!online.value) {
      record.syncState = '待同步'
      enqueueOffline(record)
    }
    addAudit(id, action, '当前用户', `记录更新至版本 V${record.version}`)
    if (patch.items) rejudgeApproval(record)
  }

  function transition(id: string, next: InspectionStatus, detail: string) {
    const record = records.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '记录不存在' }
    if (record.syncState === '待核') return { ok: false, message: '记录缺班次标识，待核期间禁止流转' }
    if (next === '已关闭' && record.items.some((item) => item.result === '异常')) {
      return { ok: false, message: '仍有异常项，不能关闭任务' }
    }
    if (next === '待复测' && !record.stopped && record.risk === '紧急') {
      return { ok: false, message: '紧急风险缺陷必须先执行停用' }
    }
    if (next === '待复测' && record.stopped) {
      return { ok: false, message: '设备停用隔离中，须先解除停用再安排复测' }
    }
    record.status = next
    record.version += 1
    record.updatedAt = new Date().toISOString()
    if (next === '待复测' && !retests.value.some((item) => item.recordId === id && item.status === '待执行')) {
      retests.value.unshift({ id: `RET-${Date.now().toString().slice(-8)}`, recordId: id, status: '待执行', reason: '整改完成后安排复测', createdAt: record.updatedAt, voidedAt: '' })
    }
    if (next === '已关闭') {
      retests.value.forEach((item) => {
        if (item.recordId === id && item.status === '待执行') item.status = '已执行'
      })
    }
    addAudit(id, `状态流转：${next}`, '当前用户', detail)
    rejudgeApproval(record)
    return { ok: true, message: `已流转至${next}` }
  }

  /** 恢复回连：把留在平板/值班室的补传记录按设备班次并单合并，重复回连不追加审计。 */
  function syncNow(): SyncBatch | null {
    if (!online.value) return null
    const due = offlineQueue.value.filter((op) => !op.failed && !mergedOpIds.value.includes(op.opId))
    if (!due.length) {
      liveMessage.value = '通道在线，无待合并记录'
      return null
    }
    const now = new Date().toISOString()
    const ready: OfflineOp[] = []
    for (const op of due) {
      if (op.failOnce && op.attempted === 0) {
        op.attempted += 1
        op.failed = true
        const local = records.value.find((item) => item.id === op.record.id)
        if (local) local.syncState = '同步失败'
      } else {
        ready.push(op)
      }
    }
    const failedCount = due.length - ready.length
    const batchId = `BATCH-${now.slice(0, 10).replaceAll('-', '')}-${String(batches.value.length + 1).padStart(2, '0')}`

    const groups = new Map<string, OfflineOp[]>()
    for (const op of ready) {
      const key = op.record.shift ? `${op.record.deviceCode}::${op.record.shift}` : `待核::${op.opId}`
      groups.set(key, [...(groups.get(key) ?? []), op])
    }

    const touched: string[] = []
    let conflictTotal = 0
    for (const ops of groups.values()) {
      const first = ops[0].record
      let record = records.value.find((item) => ops.some((op) => op.record.id === item.id))
        ?? (first.shift ? records.value.find((item) => item.deviceCode === first.deviceCode && item.shift === first.shift) : undefined)
      let created = false
      if (!record) {
        const earliest = [...ops].sort((a, b) => a.record.inspectedAt.localeCompare(b.record.inspectedAt))[0].record
        record = structuredClone(earliest)
        records.value.unshift(record)
        created = true
      }
      const preClosed = record.status === '已关闭'
      const basisSnapshot = `办结依据V${record.version}：${record.items.map((item) => `${item.name}${item.result}`).join('、')}`
      const preSignatures = new Map(record.items.map((item) => [item.id, `${item.result}|${item.reading}|${item.note}`]))

      const result = mergeOpsInto(record, ops)
      record.conflicts.push(...result.conflicts)
      conflictTotal += result.conflicts.length
      record.version += 1
      record.updatedAt = now
      record.batchId = batchId
      record.syncState = record.shift ? '已同步' : '待核'

      const changedNames = record.items.filter((item) => preSignatures.get(item.id) !== `${item.result}|${item.reading}|${item.note}`).map((item) => item.name)
      if (changedNames.length) {
        for (const retest of retests.value.filter((item) => item.recordId === record.id && item.status === '待执行')) {
          retest.status = '已作废'
          retest.voidedAt = now
          retest.reason = '检验结果变更，未执行复测作废'
          addAudit(record.id, '复测作废', '系统', `结果改动（${changedNames.join('、')}），${retest.id} 未执行即作废`, batchId)
        }
        if (record.status === '待复测') {
          retests.value.unshift({ id: `RET-${Date.now().toString().slice(-8)}`, recordId: record.id, status: '待执行', reason: '结果变更后重新安排复测', createdAt: now, voidedAt: '' })
        }
        if (preClosed) {
          record.closedBasis = basisSnapshot
          record.reviewItems = [...new Set([...record.reviewItems, ...changedNames])]
          addAudit(record.id, '办结复审', '系统', `办结内容保留原依据（${basisSnapshot}），并列复审项：${changedNames.join('、')}`, batchId)
        }
      }

      addAudit(record.id, created ? '离线补传建档' : '离线补传并单', result.sources.join('、'),
        `批次${batchId}：同设备同班次按记录时刻并单${ops.length}条，冲突${result.conflicts.length}项；整改人与停用判断仅采用无争议值`, batchId)
      rejudgeApproval(record, batchId)

      for (const op of ops) {
        mergedOpIds.value.push(op.opId)
        offlineQueue.value = offlineQueue.value.filter((item) => item.opId !== op.opId)
      }
      touched.push(record.id)
    }

    const batch: SyncBatch = {
      id: batchId,
      createdAt: now,
      recordIds: touched,
      mergedOps: ready.length,
      conflictCount: conflictTotal,
      failedOps: failedCount,
      status: failedCount ? '部分失败' : '已完成'
    }
    batches.value.unshift(batch)
    addAudit(batchId, '回连合并批次', '值班室', `合并补传${ready.length}条，冲突${conflictTotal}项，失败${failedCount}条；看板、详情、审计以本批次为准`, batchId)
    liveMessage.value = failedCount ? `批次${batchId}部分失败，${failedCount}条待重试` : `批次${batchId}合并完成`
    return batch
  }

  /** 补传失败后仅重试未完成项。 */
  function retryFailed(): SyncBatch | null {
    const failed = offlineQueue.value.filter((op) => op.failed)
    if (!failed.length) return null
    failed.forEach((op) => { op.failed = false; op.failOnce = false })
    return syncNow()
  }

  function setOnline(value: boolean) {
    online.value = value
    if (!value) {
      liveMessage.value = '断网中：记录留在平板本机，恢复后合并'
      return null
    }
    return syncNow()
  }

  function resolveConflict(recordId: string, conflictId: string, sideIndex: 0 | 1) {
    const record = records.value.find((item) => item.id === recordId)
    const conflict = record?.conflicts.find((item) => item.id === conflictId)
    if (!record || !conflict || conflict.resolved) return
    adoptConflictSide(record, conflict, sideIndex)
    record.version += 1
    record.updatedAt = new Date().toISOString()
    const side = conflict.sides[sideIndex]
    addAudit(recordId, '冲突裁定', '值班室', `${conflict.label}采用${side.source}版本「${side.display}」`, record.batchId || undefined)
    rejudgeApproval(record, record.batchId || undefined)
  }

  function resetDemo() {
    records.value = structuredClone(seedRecords)
    audit.value = structuredClone(seedAudit)
    batches.value = []
    retests.value = structuredClone(seedRetests)
    approvals.value = structuredClone(seedApprovals)
    offlineQueue.value = structuredClone(seedOfflineOps)
    mergedOpIds.value = []
    online.value = true
    liveMessage.value = '本地实时通道已就绪'
  }

  watch([records, audit, batches, retests, approvals, offlineQueue, mergedOpIds, online], () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      records: records.value,
      audit: audit.value,
      batches: batches.value,
      retests: retests.value,
      approvals: approvals.value,
      offlineQueue: offlineQueue.value,
      mergedOpIds: mergedOpIds.value,
      online: online.value
    }))
  }, { deep: true })

  return {
    records, audit, batches, retests, approvals, offlineQueue, online, keyword, status, area, liveMessage,
    filtered, stats, pendingOps, failedOps, activeBatch,
    addRecord, updateRecord, transition, syncNow, retryFailed, setOnline, resolveConflict, resetDemo
  }
})
