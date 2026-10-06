import type {
  AuditEntry,
  InspectionItem,
  InspectionRecord,
  ItemVersion,
  MergedItem,
  OfflineOperation,
  RecheckOrder
} from '../types'

/**
 * 断网恢复后的批次合并引擎。
 * 规则：
 * - 同设备 + 同班次 + 批次键一致 → 按记录时刻并单
 * - 旧记录缺班次标识 → 待核（不参与自动合并）
 * - 检验项冲突值保留两版；整改人 / 停用判断只采用没有争议的值
 * - 结果改动后未执行的复测作废，放行按新值重判，已办结保留原依据并列复审项
 */

export interface MergeResult {
  records: InspectionRecord[]
  merged: Array<{ id: string; label: string; conflict: boolean }>
  voidedRechecks: number
  releaseReset: number
  reviewsAdded: number
}

function toMerged(item: InspectionItem, source?: ItemVersion['source'], operator = '', recordedAt = ''): MergedItem {
  const versions: ItemVersion[] = source
    ? [{ source, operator, recordedAt: recordedAt || undefined as unknown as string, result: item.result, reading: item.reading, note: item.note }]
    : []
  return { ...item, versions, resultConflict: false, readingConflict: false }
}

/** 把旧版/种子 InspectionItem 升级为 MergedItem */
export function migrateRecord(record: InspectionRecord): InspectionRecord {
  const r = structuredClone(record)
  r.items = (r.items ?? []).map((item: any) => {
    if (item && Array.isArray(item.versions)) return item as MergedItem
    return toMerged(item as InspectionItem)
  })
  r.verifyState = r.verifyState ?? (r.shift ? '有效' : '待核')
  r.pendingReason = r.pendingReason ?? []
  r.sources = r.sources ?? []
  r.stoppedDisputed = r.stoppedDisputed ?? false
  r.assigneeDisputed = r.assigneeDisputed ?? false
  r.rechecks = r.rechecks ?? []
  r.release = r.release ?? { state: '未申请' }
  r.reviews = r.reviews ?? []
  if (!r.shift && !r.pendingReason.includes('旧记录缺班次标识，先待核')) {
    r.pendingReason.push('旧记录缺班次标识，先待核')
  }
  return r
}

/** 批次键：同设备同班次 */
export function batchKey(deviceCode: string, shift: string) {
  return `${deviceCode}@${shift}`
}

function mergeItem(a: MergedItem, b: MergedItem): MergedItem {
  const versions = [...a.versions, ...b.versions]
    .filter(Boolean)
    .sort((x, y) => (x.recordedAt || '').localeCompare(y.recordedAt || ''))
  // 去重（同源同时刻同值）
  const seen = new Set<string>()
  const uniq = versions.filter((v) => {
    const key = `${v.source}|${v.recordedAt}|${v.result}|${v.reading}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const results = new Set(uniq.map((v) => v.result))
  const readings = new Set(uniq.map((v) => v.reading))
  const resultConflict = results.size > 1
  const readingConflict = readings.size > 1

  // 有效取值：无冲突直接采用；有冲突取记录时刻最新的一版（另一版保留在 versions）
  const latest = uniq[uniq.length - 1] ?? { result: a.result, reading: a.reading, note: a.note }
  return {
    id: a.id,
    name: a.name,
    limit: a.limit,
    result: latest.result,
    reading: latest.reading,
    note: [a.note, b.note].filter(Boolean).join('；'),
    versions: uniq.length ? uniq : a.versions,
    resultConflict,
    readingConflict
  }
}

/** 整改人 / 停用判断：只采用没有争议的值；有争议 → 置空/否并标记 */
function reconcileUncontested(
  base: InspectionRecord,
  incoming: InspectionRecord
): { assignedTo: string; assigneeDisputed: boolean; stopped: boolean; stoppedDisputed: boolean } {
  const assigneeDisputed = !!base.assignedTo && !!incoming.assignedTo && base.assignedTo !== incoming.assignedTo
  const stoppedDisputed = base.stopped !== incoming.stopped
  return {
    assignedTo: assigneeDisputed ? '' : base.assignedTo || incoming.assignedTo,
    assigneeDisputed,
    // 有争议时不得按停用处理（防止停用设备误入复测），但保留争议标记
    stopped: stoppedDisputed ? false : base.stopped && incoming.stopped,
    stoppedDisputed
  }
}

/** 结果变化联动：作废未执行复测、放行重判、办结留原依据并列复审项 */
function applyResultCascades(
  record: InspectionRecord,
  changedItemIds: string[],
  beforeSnapshot: Map<string, InspectionItem>,
  operator: string,
  at: string,
  counters: { voidedRechecks: number; releaseReset: number; reviewsAdded: number },
  pushAudit: (id: string, action: string, operator: string, detail: string, key: string) => void,
  dedupNs: string
) {
  const changed = changedItemIds.filter((id) => {
    const before = beforeSnapshot.get(id)
    const now = record.items.find((item) => item.id === id)
    return before && now && (before.result !== now.result || before.reading !== now.reading)
  })
  if (!changed.length) return

  // 1) 未执行的复测作废（已完成的复测保留）
  record.rechecks.forEach((rc: RecheckOrder) => {
    if (changed.includes(rc.itemId) && rc.status === '待复测') {
      rc.status = '已作废'
      rc.voidedAt = at
      rc.voidReason = '检验结果改动，关联复测作废，待按新值重新判定'
      counters.voidedRechecks += 1
      pushAudit(record.id, '复测作废', operator, `「${rc.itemName}」结果改动，原复测单 ${rc.id} 作废`, `${dedupNs}:void:${rc.id}`)
    }
  })

  // 2) 放行审批按新值重判：已有放行结论一律回退为待判定
  if (record.release.state === '已放行' || record.release.state === '驳回') {
    record.release = {
      state: '待判定',
      basis: undefined,
      reason: undefined
    }
    counters.releaseReset += 1
    pushAudit(record.id, '放行重判', operator, '回连合并导致检验结果改动，原放行结论失效，按新值重新判定', `${dedupNs}:release`)
  }

  // 3) 已办结：保留原依据，并列复审项；状态回到需复核
  if (record.status === '已关闭' && record.closure) {
    changed.forEach((id) => {
      const before = beforeSnapshot.get(id)!
      const now = record.items.find((item) => item.id === id)!
      if (!record.reviews.some((rv) => rv.field === now.name && rv.createdAt === at)) {
        record.reviews.push({
          id: `RV-${id}-${record.reviews.length + 1}`,
          field: now.name,
          original: `${before.result} / ${before.reading}`,
          changedTo: `${now.result} / ${now.reading}`,
          reason: `办结后由${operator}经回连合并改动，需按原依据复审`,
          createdAt: at
        })
        counters.reviewsAdded += 1
      }
    })
    record.status = '需复核'
    pushAudit(record.id, '办结回退', operator, '办结批次经合并改动：原办结依据保留，并列复审项后转需复核', `${dedupNs}:closure`)
  }
}

function buildIncomingRecord(op: OfflineOperation): InspectionRecord | null {
  if (op.type !== '新建批次') return null
  const now = op.recordedAt
  return {
    id: `OFF-${op.uid}`,
    deviceCode: op.deviceCode!,
    deviceName: op.deviceName ?? '',
    area: op.area ?? '',
    shift: op.shift ?? '',
    inspector: op.operator,
    inspectedAt: now,
    status: '待检验',
    risk: '中',
    stopped: false,
    assignedTo: '',
    dueDate: '',
    items: standardMergedItems('平板', op.operator, now),
    evidenceCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    verifyState: op.shift ? '有效' : '待核',
    pendingReason: op.shift ? [] : ['旧记录缺班次标识，先待核'],
    sources: ['平板'],
    stoppedDisputed: false,
    assigneeDisputed: false,
    rechecks: [],
    release: { state: '未申请' },
    reviews: []
  }
}

function standardMergedItems(source: ItemVersion['source'], operator: string, at: string): MergedItem[] {
  const defs = [
    { id: 'wear', name: '结构磨损', limit: '≤ 5.0 mm' },
    { id: 'noise', name: '运行异响', limit: '≤ 75 dB' },
    { id: 'brake', name: '制动装置', limit: '制动可靠' },
    { id: 'lock', name: '锁止机构', limit: '无可见间隙' },
    { id: 'safety', name: '安全装置', limit: '动作可靠' }
  ]
  return defs.map((d) => ({
    ...d,
    result: '正常' as const,
    reading: '待录入',
    note: '',
    resultConflict: false,
    readingConflict: false,
    versions: [{ source, operator, recordedAt: at, result: '正常', reading: '待录入', note: '' }]
  }))
}

export function mergeOperations(
  existing: InspectionRecord[],
  operations: OfflineOperation[],
  audit: AuditEntry[]
): MergeResult {
  const records = existing.map(migrateRecord)
  const counters = { voidedRechecks: 0, releaseReset: 0, reviewsAdded: 0 }
  const merged: MergeResult['merged'] = []
  const at = new Date().toISOString()
  const auditDedup = new Set(audit.map((a) => a.dedupKey).filter(Boolean))

  function pushAudit(recordId: string, action: string, operator: string, detail: string, dedupKey: string) {
    if (dedupKey && auditDedup.has(dedupKey)) return // 重复回连不追加审计
    auditDedup.add(dedupKey)
    audit.unshift({
      id: `${recordId}-${audit.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
      recordId,
      action,
      operator,
      detail,
      createdAt: at,
      dedupKey
    })
  }

  for (const op of operations) {
    // 缺班次标识：不自动并单，整体待核
    if (!op.shift) {
      if (op.type === '新建批次') {
        const offlineId = `OFF-${op.uid}`
        // 补传重试幂等：同一条离线记录不重复生成待核批次
        if (!records.some((r) => r.id === offlineId)) {
          const rec = buildIncomingRecord(op)
          if (rec) {
            rec.id = offlineId
            rec.verifyState = '待核'
            records.unshift(rec)
            pushAudit(rec.id, '离线补传：批次待核', op.operator, '断网记录缺班次标识，暂不并单，先待核', `merge:${op.uid}`)
            merged.push({ id: rec.id, label: `${rec.deviceName} 批次待核`, conflict: false })
          }
        }
      }
      op.status = '失败'
      op.failReason = '缺班次标识，需值班主管核实后补录'
      continue
    }

    if (op.type === '新建批次') {
      const incoming = buildIncomingRecord(op)!
      const match = records.find(
        (r) => r.deviceCode === incoming.deviceCode && r.shift === incoming.shift && r.verifyState === '有效'
      )
      if (match) {
        mergeInto(match, incoming, op, counters, pushAudit, at, merged)
      } else {
        records.unshift(incoming)
        pushAudit(incoming.id, '离线补传：新建批次', op.operator, `平板断网记录（${op.note}）回连后入库`, `merge:${op.uid}`)
        merged.push({ id: incoming.id, label: `${incoming.deviceName} 新批次入库`, conflict: false })
      }
      op.status = '已合并'
      continue
    }

    // 现场录入 / 值班室编辑 → 定位同设备同班次有效批次
    const target = records.find(
      (r) => r.id === op.targetId || (op.deviceCode && r.deviceCode === op.deviceCode && r.shift === op.shift && r.verifyState === '有效')
    )
    if (!target) {
      op.status = '失败'
      op.failReason = '未匹配到同设备同班次的有效批次'
      continue
    }
    applyEdit(target, op, counters, pushAudit, at, merged)
    op.status = '已合并'
  }

  return {
    records,
    merged,
    voidedRechecks: counters.voidedRechecks,
    releaseReset: counters.releaseReset,
    reviewsAdded: counters.reviewsAdded
  }
}

function mergeInto(
  target: InspectionRecord,
  incoming: InspectionRecord,
  op: OfflineOperation,
  counters: { voidedRechecks: number; releaseReset: number; reviewsAdded: number },
  pushAudit: (id: string, action: string, operator: string, detail: string, key: string) => void,
  at: string,
  merged: MergeResult['merged']
) {
  const before = new Map(target.items.map((i) => [i.id, { ...i }]))
  const recon = reconcileUncontested(target, incoming)

  // 并单：按记录时刻合并各检验项版本
  target.items = target.items.map((item) => {
    const other = incoming.items.find((i) => i.id === item.id)
    return other ? mergeItem(item, other) : item
  })

  target.sources = Array.from(new Set([...target.sources, ...incoming.sources]))
  target.assignedTo = recon.assignedTo
  target.assigneeDisputed = recon.assigneeDisputed
  target.stopped = recon.stopped
  target.stoppedDisputed = recon.stoppedDisputed
  if (recon.assigneeDisputed && !target.pendingReason.includes('整改责任人两版不一致，待值班主管裁定')) {
    target.pendingReason.push('整改责任人两版不一致，待值班主管裁定')
  }
  if (recon.stoppedDisputed && !target.pendingReason.includes('停用判断两版不一致，按未停用处理并禁止复测')) {
    target.pendingReason.push('停用判断两版不一致，按未停用处理并禁止复测')
  }
  target.inspectedAt = [target.inspectedAt, incoming.inspectedAt].sort()[0]
  target.version += 1
  target.updatedAt = at
  target.lastMergedAt = at

  const conflict = target.items.some((i) => i.resultConflict || i.readingConflict)
  applyResultCascades(target, Array.from(before.keys()), before, op.operator, at, counters, pushAudit, `merge:${op.uid}`)

  pushAudit(
    target.id,
    '断网并单',
    op.operator,
    `平板离线批次与值班室记录按同设备同班次并单（时刻 ${op.recordedAt.replace('T', ' ').slice(0, 16)}）` +
      `${conflict ? '；存在冲突值，已保留两版' : ''}` +
      `${recon.assigneeDisputed ? '；整改人有争议暂不采用' : ''}` +
      `${recon.stoppedDisputed ? '；停用有争议按未停用处理' : ''}`,
    `merge:${op.uid}`
  )
  merged.push({ id: target.id, label: `${target.deviceName} 并单${conflict ? '（含冲突两版）' : ''}`, conflict })
}

function applyEdit(
  target: InspectionRecord,
  op: OfflineOperation,
  counters: { voidedRechecks: number; releaseReset: number; reviewsAdded: number },
  pushAudit: (id: string, action: string, operator: string, detail: string, key: string) => void,
  at: string,
  merged: MergeResult['merged']
) {
  const patch = op.patch
  const before = new Map(target.items.map((i) => [i.id, { ...i }]))
  const source: ItemVersion['source'] = op.type === '值班室编辑' ? '值班室' : '平板'

  if (!target.sources.includes(source)) target.sources.push(source)

  if (patch?.itemId) {
    const item = target.items.find((i) => i.id === patch.itemId)
    if (item) {
      const next: ItemVersion = {
        source,
        operator: op.operator,
        recordedAt: op.recordedAt,
        result: patch.result ?? item.result,
        reading: patch.reading ?? item.reading,
        note: patch.note ?? ''
      }
      item.versions.push(next)
      item.versions.sort((a, b) => (a.recordedAt || '').localeCompare(b.recordedAt || ''))
      const results = new Set(item.versions.map((v) => v.result))
      const readings = new Set(item.versions.map((v) => v.reading))
      item.resultConflict = results.size > 1
      item.readingConflict = readings.size > 1
      // 有效取值：无争议直接采用；有争议以记录时刻最新一版为准，旧版保留
      item.result = next.result
      item.reading = next.reading
      if (next.note) item.note = next.note
    }
  }

  let assigneeNote = ''
  let stoppedNote = ''
  if (patch?.assignedTo !== undefined) {
    if (target.assignedTo && patch.assignedTo && target.assignedTo !== patch.assignedTo) {
      target.assigneeDisputed = true
      target.assignedTo = ''
      if (!target.pendingReason.includes('整改责任人两版不一致，待值班主管裁定')) {
        target.pendingReason.push('整改责任人两版不一致，待值班主管裁定')
      }
      assigneeNote = '；整改人与既有值有争议，暂不采用'
    } else if (!target.assignedTo) {
      target.assignedTo = patch.assignedTo
      target.assigneeDisputed = false
    }
  }
  if (patch?.stopped !== undefined) {
    // 停用判断只采用没有争议的值：与既有判断不同即争议，按未停用处理
    if (patch.stopped !== target.stopped && (target.sources.length > 1 || target.stoppedDisputed)) {
      target.stoppedDisputed = true
      target.stopped = false
      if (!target.pendingReason.includes('停用判断两版不一致，按未停用处理并禁止复测')) {
        target.pendingReason.push('停用判断两版不一致，按未停用处理并禁止复测')
      }
      stoppedNote = '；停用判断有争议，按未停用处理且禁止进入复测'
    } else {
      target.stopped = patch.stopped
    }
  }

  target.version += 1
  target.updatedAt = at
  target.lastMergedAt = at

  const changedIds = patch?.itemId ? [patch.itemId] : []
  applyResultCascades(target, changedIds, before, op.operator, at, counters, pushAudit, `merge:${op.uid}`)

  const item = patch?.itemId ? target.items.find((i) => i.id === patch.itemId) : undefined
  const conflict = item?.resultConflict || item?.readingConflict
  pushAudit(
    target.id,
    op.type === '值班室编辑' ? '值班室离线改动补传' : '平板离线录入补传',
    op.operator,
    `${op.note}（记录时刻 ${op.recordedAt.replace('T', ' ').slice(0, 16)}）` +
      `${conflict ? '；与另一版取值冲突，两版均保留' : ''}${assigneeNote}${stoppedNote}`,
    `merge:${op.uid}`
  )
  merged.push({
    id: target.id,
    label: `${target.deviceName} ${op.note}${conflict ? '（冲突留两版）' : ''}`,
    conflict: !!conflict
  })
}
