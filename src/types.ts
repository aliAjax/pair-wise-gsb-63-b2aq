export type InspectionStatus = '待检验' | '需整改' | '整改中' | '待复测' | '已关闭' | '停用'
export type RiskLevel = '低' | '中' | '高' | '紧急'
export type CheckResult = '正常' | '异常' | '不适用'
export type SyncState = '已同步' | '待同步' | '同步失败' | '待核'
export type OpSource = '平板' | '值班室'

export interface InspectionItem {
  id: string
  name: string
  result: CheckResult
  reading: string
  limit: string
  note: string
}

export interface ConflictSide {
  source: OpSource
  at: string
  display: string
  payload: unknown
}

export interface FieldConflict {
  id: string
  field: string
  label: string
  sides: [ConflictSide, ConflictSide]
  resolved: boolean
  adoptedSource?: string
}

export interface InspectionRecord {
  id: string
  deviceCode: string
  deviceName: string
  area: string
  shift: string
  inspector: string
  inspectedAt: string
  status: InspectionStatus
  risk: RiskLevel
  stopped: boolean
  assignedTo: string
  dueDate: string
  items: InspectionItem[]
  evidenceCount: number
  version: number
  syncState: SyncState
  batchId: string
  conflicts: FieldConflict[]
  closedBasis: string
  reviewItems: string[]
  createdAt: string
  updatedAt: string
}

export interface OfflineOp {
  opId: string
  source: OpSource
  record: InspectionRecord
  failed: boolean
  failOnce: boolean
  attempted: number
}

export interface SyncBatch {
  id: string
  createdAt: string
  recordIds: string[]
  mergedOps: number
  conflictCount: number
  failedOps: number
  status: '已完成' | '部分失败'
}

export interface RetestOrder {
  id: string
  recordId: string
  status: '待执行' | '已执行' | '已作废'
  reason: string
  createdAt: string
  voidedAt: string
}

export interface ReleaseApproval {
  recordId: string
  decision: '放行' | '不放行' | '待复核'
  basis: string
  judgedAt: string
}

export interface AuditEntry {
  id: string
  recordId: string
  action: string
  operator: string
  detail: string
  batchId?: string
  createdAt: string
}

export interface InspectionDraft {
  deviceCode: string
  deviceName: string
  area: string
  shift: string
  inspector: string
  risk: RiskLevel
  assignedTo: string
  dueDate: string
}
