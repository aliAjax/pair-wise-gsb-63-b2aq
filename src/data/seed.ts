import { judgeRelease } from '../services/sync'
import type { AuditEntry, InspectionItem, InspectionRecord, OfflineOp, ReleaseApproval, RetestOrder } from '../types'

const standardItems = (abnormal = false): InspectionItem[] => [
  { id: 'wear', name: '结构磨损', result: abnormal ? '异常' : '正常', reading: abnormal ? '6.8 mm' : '2.1 mm', limit: '≤ 5.0 mm', note: abnormal ? '主支撑连接处磨损超限' : '' },
  { id: 'noise', name: '运行异响', result: '正常', reading: '68 dB', limit: '≤ 75 dB', note: '' },
  { id: 'brake', name: '制动装置', result: '正常', reading: '制动距离 2.3 m', limit: '制动可靠', note: '' },
  { id: 'lock', name: '锁止机构', result: abnormal ? '异常' : '正常', reading: abnormal ? '存在间隙' : '闭合可靠', limit: '无可见间隙', note: abnormal ? '安全压杠锁止存在回弹' : '' },
  { id: 'safety', name: '安全装置', result: '正常', reading: '联锁有效', limit: '动作可靠', note: '' }
]

const baseRecord = () => ({
  evidenceCount: 0,
  version: 1,
  syncState: '已同步' as const,
  batchId: '',
  conflicts: [],
  closedBasis: '',
  reviewItems: []
})

export const seedRecords: InspectionRecord[] = [
  {
    ...baseRecord(),
    id: 'INS-240821-01', deviceCode: 'AM-014', deviceName: '高空飞翔', area: 'A区北侧', shift: '早班', inspector: '周宁',
    inspectedAt: '2026-09-28T08:20:00', status: '需整改', risk: '高', stopped: true, assignedTo: '维修一组', dueDate: '2026-09-29',
    items: standardItems(true), evidenceCount: 4, version: 3, createdAt: '2026-09-28T08:20:00', updatedAt: '2026-09-28T09:35:00'
  },
  {
    ...baseRecord(),
    id: 'INS-240821-02', deviceCode: 'RC-007', deviceName: '家庭过山车', area: 'B区', shift: '早班', inspector: '李琪',
    inspectedAt: '2026-09-28T09:05:00', status: '整改中', risk: '中', stopped: false, assignedTo: '电气班组', dueDate: '2026-09-30',
    items: standardItems(true), evidenceCount: 2, version: 2, createdAt: '2026-09-28T09:05:00', updatedAt: '2026-09-28T11:10:00'
  },
  {
    ...baseRecord(),
    id: 'INS-240821-03', deviceCode: 'CR-021', deviceName: '旋转木马', area: '亲子区', shift: '中班', inspector: '王璟',
    inspectedAt: '2026-09-27T15:40:00', status: '待复测', risk: '低', stopped: false, assignedTo: '检验二组', dueDate: '2026-09-29',
    items: standardItems(), evidenceCount: 3, version: 4, createdAt: '2026-09-27T15:40:00', updatedAt: '2026-09-28T10:25:00'
  },
  {
    ...baseRecord(),
    id: 'INS-240821-04', deviceCode: 'WF-003', deviceName: '摩天轮', area: '湖景区', shift: '早班', inspector: '赵帆',
    inspectedAt: '2026-09-27T07:55:00', status: '已关闭', risk: '低', stopped: false, assignedTo: '维修二组', dueDate: '2026-09-28',
    items: standardItems(), evidenceCount: 5, version: 5, createdAt: '2026-09-27T07:55:00', updatedAt: '2026-09-28T16:20:00'
  },
  {
    ...baseRecord(),
    id: 'INS-240821-05', deviceCode: 'PF-011', deviceName: '跳伞塔', area: 'C区', shift: '', inspector: '赵帆',
    inspectedAt: '2026-09-26T17:10:00', status: '待检验', risk: '中', stopped: false, assignedTo: '维修一组', dueDate: '2026-09-30',
    items: standardItems(), evidenceCount: 1, version: 1, syncState: '待核', createdAt: '2026-09-26T17:10:00', updatedAt: '2026-09-26T17:10:00'
  }
]

const offlineRecord = (partial: Partial<InspectionRecord> & Pick<InspectionRecord, 'id' | 'deviceCode' | 'deviceName' | 'area' | 'shift' | 'inspector' | 'inspectedAt' | 'items'>): InspectionRecord => ({
  status: '待检验',
  risk: '中',
  stopped: false,
  assignedTo: '维修一组',
  dueDate: '2026-09-30',
  evidenceCount: 0,
  version: 1,
  syncState: '待同步',
  batchId: '',
  conflicts: [],
  closedBasis: '',
  reviewItems: [],
  createdAt: partial.inspectedAt,
  updatedAt: partial.inspectedAt,
  ...partial
})

const amItems = (lockResult: '正常' | '异常', lockReading: string, lockNote: string, brakeResult: '正常' | '异常', brakeReading: string, brakeNote: string): InspectionItem[] => [
  { id: 'wear', name: '结构磨损', result: '正常', reading: '2.1 mm', limit: '≤ 5.0 mm', note: '' },
  { id: 'noise', name: '运行异响', result: '正常', reading: '68 dB', limit: '≤ 75 dB', note: '' },
  { id: 'brake', name: '制动装置', result: brakeResult, reading: brakeReading, limit: '油温 ≤ 70 ℃', note: brakeNote },
  { id: 'lock', name: '锁止机构', result: lockResult, reading: lockReading, limit: '无可见间隙', note: lockNote },
  { id: 'safety', name: '安全装置', result: '正常', reading: '联锁有效', limit: '动作可靠', note: '' }
]

/** 断网期间留在平板与值班室的待补传记录，恢复回连后并入有效批次。 */
export const seedOfflineOps: OfflineOp[] = [
  {
    opId: 'OP-AM014-PAD', source: '平板', failed: false, failOnce: false, attempted: 0,
    record: offlineRecord({
      id: 'INS-OFF-0101', deviceCode: 'AM-014', deviceName: '高空飞翔', area: 'A区北侧', shift: '早班', inspector: '周宁',
      inspectedAt: '2026-09-28T08:47:00', risk: '高', stopped: true, assignedTo: '维修一组', dueDate: '2026-09-30', evidenceCount: 3,
      items: amItems('异常', '座舱锁扣间隙 1.2 mm', '座舱锁扣回弹，间隙超限', '异常', '制动油温 78 ℃', '制动油温超 70 ℃ 上限')
    })
  },
  {
    opId: 'OP-AM014-DUTY', source: '值班室', failed: false, failOnce: false, attempted: 0,
    record: offlineRecord({
      id: 'INS-OFF-0102', deviceCode: 'AM-014', deviceName: '高空飞翔', area: 'A区北侧', shift: '早班', inspector: '周宁',
      inspectedAt: '2026-09-28T21:15:00', risk: '高', stopped: false, assignedTo: '维修二组', dueDate: '2026-09-30', evidenceCount: 1,
      items: amItems('正常', '闭合可靠', '', '正常', '制动油温 61 ℃', '')
    })
  },
  {
    opId: 'OP-CR021-PAD', source: '平板', failed: false, failOnce: false, attempted: 0,
    record: offlineRecord({
      id: 'INS-OFF-0201', deviceCode: 'CR-021', deviceName: '旋转木马', area: '亲子区', shift: '中班', inspector: '王璟',
      inspectedAt: '2026-09-28T16:05:00', risk: '低', assignedTo: '检验二组', dueDate: '2026-09-29', evidenceCount: 4,
      items: [
        { id: 'wear', name: '结构磨损', result: '正常', reading: '2.9 mm', limit: '≤ 5.0 mm', note: '' },
        { id: 'noise', name: '运行异响', result: '正常', reading: '71 dB', limit: '≤ 75 dB', note: '' },
        { id: 'brake', name: '制动装置', result: '正常', reading: '制动距离 2.3 m', limit: '制动可靠', note: '' },
        { id: 'lock', name: '锁止机构', result: '正常', reading: '闭合可靠', limit: '无可见间隙', note: '' },
        { id: 'safety', name: '安全装置', result: '正常', reading: '联锁有效', limit: '动作可靠', note: '' }
      ]
    })
  },
  {
    opId: 'OP-WF003-DUTY', source: '值班室', failed: false, failOnce: true, attempted: 0,
    record: offlineRecord({
      id: 'INS-OFF-0301', deviceCode: 'WF-003', deviceName: '摩天轮', area: '湖景区', shift: '早班', inspector: '赵帆',
      inspectedAt: '2026-09-28T20:40:00', risk: '中', assignedTo: '维修二组', dueDate: '2026-09-28', evidenceCount: 6,
      items: [
        { id: 'wear', name: '结构磨损', result: '异常', reading: '5.6 mm', limit: '≤ 5.0 mm', note: '复核发现磨损超限' },
        { id: 'noise', name: '运行异响', result: '正常', reading: '68 dB', limit: '≤ 75 dB', note: '' },
        { id: 'brake', name: '制动装置', result: '正常', reading: '制动距离 2.3 m', limit: '制动可靠', note: '' },
        { id: 'lock', name: '锁止机构', result: '正常', reading: '闭合可靠', limit: '无可见间隙', note: '' },
        { id: 'safety', name: '安全装置', result: '正常', reading: '联锁有效', limit: '动作可靠', note: '' }
      ]
    })
  }
]

export const seedRetests: RetestOrder[] = [
  { id: 'RET-240928-01', recordId: 'INS-240821-03', status: '待执行', reason: '整改完成后安排复测', createdAt: '2026-09-28T10:30:00', voidedAt: '' }
]

export const seedApprovals: Record<string, ReleaseApproval> = Object.fromEntries(
  seedRecords.map((record) => [record.id, judgeRelease(record, '2026-09-28T17:00:00')])
)

export const seedAudit: AuditEntry[] = seedRecords.flatMap((record) => [
  { id: `${record.id}-A1`, recordId: record.id, action: '创建检验记录', operator: record.inspector, detail: `${record.deviceName}完成班前检验`, createdAt: record.createdAt },
  ...(record.version > 1 ? [{ id: `${record.id}-A${record.version}`, recordId: record.id, action: record.status, operator: '系统流转', detail: `记录更新至版本 V${record.version}`, createdAt: record.updatedAt }] : [])
])
