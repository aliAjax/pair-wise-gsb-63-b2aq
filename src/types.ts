export type InspectionStatus = '待检验' | '需整改' | '整改中' | '待复测' | '已关闭' | '停用' | '需复核'
export type RiskLevel = '低' | '中' | '高' | '紧急'
export type CheckResult = '正常' | '异常' | '不适用'
export type VerifyState = '有效' | '待核'
export type SyncSource = '平板' | '值班室'
export type ReleaseState = '未申请' | '待判定' | '已放行' | '驳回'
export type OfflineOpType = '新建批次' | '现场录入' | '值班室编辑'

export interface InspectionItem {
  id: string
  name: string
  result: CheckResult
  reading: string
  limit: string
  note: string
}

/** 一次具体来源的条目记录（早班平板 / 晚班值班室），用于并单留痕与冲突比对 */
export interface ItemVersion {
  source: SyncSource
  operator: string
  recordedAt: string
  result: CheckResult
  reading: string
  note: string
}

export interface MergedItem extends InspectionItem {
  /** 有效（采纳）版本；多源一致时唯一，争议字段保留两版 */
  versions: ItemVersion[]
  /** 结果存在多版本且取值不同（冲突值保留两版） */
  resultConflict: boolean
  /** 实测值存在多版本且取值不同（冲突值保留两版） */
  readingConflict: boolean
}

export interface RecheckOrder {
  id: string
  itemId: string
  itemName: string
  status: '待复测' | '已作废' | '已完成'
  reason: string
  createdAt: string
  /** 被哪次结果改动作废 */
  voidedAt?: string
  voidReason?: string
}

export interface ReviewItem {
  id: string
  field: string
  original: string
  changedTo: string
  reason: string
  createdAt: string
}

/** 已办结批次的原始依据快照，合并改动后保留 */
export interface ClosureBasis {
  closedAt: string
  status: InspectionStatus
  items: InspectionItem[]
  stopped: boolean
  risk: RiskLevel
  assignedTo: string
  operator: string
}

export interface Release {
  state: ReleaseState
  decidedAt?: string
  basis?: string
  reason?: string
}

export interface InspectionRecord {
  id: string
  deviceCode: string
  deviceName: string
  area: string
  /** 旧记录可能没有班次标识：空串表示待核 */
  shift: string
  inspector: string
  inspectedAt: string
  status: InspectionStatus
  risk: RiskLevel
  stopped: boolean
  assignedTo: string
  dueDate: string
  items: MergedItem[]
  evidenceCount: number
  version: number
  createdAt: string
  updatedAt: string

  // —— 批次合并 / 待核 ——
  verifyState: VerifyState
  pendingReason: string[]
  /** 参与并单的原始记录（平板 / 值班室） */
  sources: SyncSource[]
  /** 停用判断是否存在争议（有争议时只按未停用处理，禁止进入复测） */
  stoppedDisputed: boolean
  /** 整改人是否存在争议（有争议时责任人待核） */
  assigneeDisputed: boolean
  lastMergedAt?: string

  // —— 闭环联动 ——
  rechecks: RecheckOrder[]
  release: Release
  reviews: ReviewItem[]
  closure?: ClosureBasis
}

export interface AuditEntry {
  id: string
  recordId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 幂等键：同一次回连/同一操作重复出现不重复追加审计 */
  dedupKey?: string
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

/** 断网期间留在平板 / 值班室的待补传操作 */
export interface OfflineOperation {
  uid: string
  type: OfflineOpType
  targetId?: string
  deviceCode?: string
  shift?: string
  deviceName?: string
  area?: string
  operator: string
  recordedAt: string
  note: string
  patch?: ItemPatch
  status: '待补传' | '已合并' | '失败'
  failReason?: string
}

export interface ItemPatch {
  itemId?: string
  result?: CheckResult
  reading?: string
  note?: string
  assignedTo?: string
  stopped?: boolean
}
