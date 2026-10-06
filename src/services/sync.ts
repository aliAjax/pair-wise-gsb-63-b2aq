import type { FieldConflict, InspectionItem, InspectionRecord, OfflineOp, ReleaseApproval } from '../types'

const SCALAR_FIELDS: Array<{ field: 'assignedTo' | 'stopped' | 'risk' | 'dueDate' | 'inspector'; label: string }> = [
  { field: 'assignedTo', label: '整改责任人' },
  { field: 'stopped', label: '停用判断' },
  { field: 'risk', label: '风险等级' },
  { field: 'dueDate', label: '整改截止' },
  { field: 'inspector', label: '检验员' }
]

function timeLabel(iso: string): string {
  return iso.includes('T') ? iso.slice(11, 16) : iso
}

function scalarDisplay(field: string, value: unknown): string {
  if (field === 'stopped') return value ? '停用隔离' : '正常开放'
  return String(value)
}

function itemSignature(item: InspectionItem): string {
  return `${item.result}|${item.reading}|${item.note}`
}

function applyItem(target: InspectionItem, source: InspectionItem): boolean {
  if (itemSignature(target) === itemSignature(source) && target.limit === source.limit) return false
  target.result = source.result
  target.reading = source.reading
  target.note = source.note
  target.limit = source.limit
  return true
}

function makeConflict(recordId: string, field: string, label: string, early: OfflineOp, late: OfflineOp, display: (op: OfflineOp) => string, payload: (op: OfflineOp) => unknown): FieldConflict {
  return {
    id: `${recordId}-${field}`,
    field,
    label,
    sides: [
      { source: early.source, at: timeLabel(early.record.inspectedAt), display: display(early), payload: payload(early) },
      { source: late.source, at: timeLabel(late.record.inspectedAt), display: display(late), payload: payload(late) }
    ],
    resolved: false
  }
}

export interface MergeResult {
  itemChanged: boolean
  conflicts: FieldConflict[]
  sources: string[]
}

/**
 * 同设备同班次并单：按记录时刻排序后逐字段合并。
 * 无争议值直接采用；冲突值保留两版，整改责任人与停用判断不落库，待值班室裁定。
 */
export function mergeOpsInto(target: InspectionRecord, ops: OfflineOp[]): MergeResult {
  const sorted = [...ops].sort((a, b) => a.record.inspectedAt.localeCompare(b.record.inspectedAt))
  const sources = sorted.map((op) => op.source)
  const conflicts: FieldConflict[] = []
  let itemChanged = false

  if (sorted.length === 1) {
    const only = sorted[0].record
    for (const { field } of SCALAR_FIELDS) {
      if (String(target[field]) !== String(only[field])) (target as unknown as Record<string, unknown>)[field] = only[field]
    }
    for (const sourceItem of only.items) {
      const targetItem = target.items.find((item) => item.id === sourceItem.id)
      if (targetItem) itemChanged = applyItem(targetItem, sourceItem) || itemChanged
    }
    target.evidenceCount = Math.max(target.evidenceCount, only.evidenceCount)
    return { itemChanged, conflicts, sources }
  }

  for (const { field, label } of SCALAR_FIELDS) {
    const distinct = sorted.filter((op, index) => sorted.findIndex((other) => String(other.record[field]) === String(op.record[field])) === index)
    if (distinct.length === 1) {
      const value = distinct[0].record[field]
      if (String(target[field]) !== String(value)) (target as unknown as Record<string, unknown>)[field] = value
    } else if (!target.conflicts.some((item) => item.field === field && !item.resolved)) {
      conflicts.push(makeConflict(target.id, field, label, distinct[0], distinct[1],
        (op) => scalarDisplay(field, op.record[field]),
        (op) => op.record[field]))
    }
  }

  const itemIds = [...new Set(sorted.flatMap((op) => op.record.items.map((item) => item.id)))]
  for (const itemId of itemIds) {
    const variants = sorted
      .map((op) => ({ op, item: op.record.items.find((item) => item.id === itemId) }))
      .filter((entry): entry is { op: OfflineOp; item: InspectionItem } => Boolean(entry.item))
    const distinct = variants.filter((entry, index) => variants.findIndex((other) => itemSignature(other.item) === itemSignature(entry.item)) === index)
    const targetItem = target.items.find((item) => item.id === itemId)
    if (!targetItem || !distinct.length) continue
    if (distinct.length === 1) {
      itemChanged = applyItem(targetItem, distinct[0].item) || itemChanged
    } else if (!target.conflicts.some((item) => item.field === `item:${itemId}` && !item.resolved)) {
      const name = targetItem.name
      conflicts.push(makeConflict(target.id, `item:${itemId}`, `${name}实测`, distinct[0].op, distinct[1].op,
        (op) => {
          const item = op.record.items.find((entry) => entry.id === itemId)!
          return `${item.reading}（${item.result}）`
        },
        (op) => {
          const item = op.record.items.find((entry) => entry.id === itemId)!
          return { result: item.result, reading: item.reading, note: item.note, limit: item.limit }
        }))
    }
  }

  target.evidenceCount = Math.max(target.evidenceCount, ...sorted.map((op) => op.record.evidenceCount))
  return { itemChanged, conflicts, sources }
}

/** 放行审批：按合并后的新值重判，存在未裁定争议或待核记录时不得直接放行。 */
export function judgeRelease(record: InspectionRecord, now: string): ReleaseApproval {
  const abnormal = record.items.filter((item) => item.result === '异常').length
  const disputed = record.conflicts.filter((item) => !item.resolved).length
  let decision: ReleaseApproval['decision'] = '放行'
  if (record.syncState === '待核' || disputed > 0) decision = '待复核'
  else if (record.stopped || abnormal > 0 || record.risk === '紧急') decision = '不放行'
  return {
    recordId: record.id,
    decision,
    basis: `依据V${record.version} · 异常${abnormal}项 · ${record.stopped ? '停用隔离' : '开放运行'} · 争议${disputed}项`,
    judgedAt: now
  }
}

/** 冲突裁定：把选定一侧的值写回记录。 */
export function adoptConflictSide(record: InspectionRecord, conflict: FieldConflict, sideIndex: 0 | 1): void {
  const side = conflict.sides[sideIndex]
  if (conflict.field.startsWith('item:')) {
    const item = record.items.find((entry) => entry.id === conflict.field.slice(5))
    if (item) Object.assign(item, side.payload as Partial<InspectionItem>)
  } else {
    (record as unknown as Record<string, unknown>)[conflict.field] = side.payload
  }
  conflict.resolved = true
  conflict.adoptedSource = side.source
}
