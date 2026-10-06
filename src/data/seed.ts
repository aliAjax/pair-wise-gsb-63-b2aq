import type { AuditEntry, InspectionItem, InspectionRecord, MergedItem } from '../types'

function asMerged(item: InspectionItem, source: '平板' | '值班室' = '平板', recordedAt = ''): MergedItem {
  return {
    ...item,
    versions: [{ source, operator: '', recordedAt, result: item.result, reading: item.reading, note: item.note }],
    resultConflict: false,
    readingConflict: false
  }
}

const standardItems = (abnormal = false, recordedAt = ''): MergedItem[] => [
  asMerged({ id: 'wear', name: '结构磨损', result: abnormal ? '异常' : '正常', reading: abnormal ? '6.8 mm' : '2.1 mm', limit: '≤ 5.0 mm', note: abnormal ? '主支撑连接处磨损超限' : '' }, '平板', recordedAt),
  asMerged({ id: 'noise', name: '运行异响', result: '正常', reading: '68 dB', limit: '≤ 75 dB', note: '' }, '平板', recordedAt),
  asMerged({ id: 'brake', name: '制动装置', result: '正常', reading: '制动距离 2.3 m', limit: '≤ 3.0 m', note: '' }, '平板', recordedAt),
  asMerged({ id: 'lock', name: '锁止机构', result: abnormal ? '异常' : '正常', reading: abnormal ? '存在间隙' : '闭合可靠', limit: '无可见间隙', note: abnormal ? '安全压杠锁止存在回弹' : '' }, '平板', recordedAt),
  asMerged({ id: 'safety', name: '安全装置', result: '正常', reading: '联锁有效', limit: '动作可靠', note: '' }, '平板', recordedAt)
]

const baseExtras = {
  verifyState: '有效' as const,
  pendingReason: [] as string[],
  sources: ['平板'] as Array<'平板' | '值班室'>,
  stoppedDisputed: false,
  assigneeDisputed: false,
  rechecks: [],
  release: { state: '未申请' as const },
  reviews: [] as Array<{ id: string; field: string; original: string; changedTo: string; reason: string; createdAt: string }>
}

export const seedRecords: InspectionRecord[] = [
  {
    ...baseExtras,
    id: 'INS-240821-01', deviceCode: 'AM-014', deviceName: '高空飞翔', area: 'A区北侧', shift: '早班', inspector: '周宁',
    inspectedAt: '2026-09-28T08:20:00', status: '需整改', risk: '高', stopped: true, assignedTo: '维修一组', dueDate: '2026-09-29',
    items: standardItems(true, '2026-09-28T08:20:00'), evidenceCount: 4, version: 3, createdAt: '2026-09-28T08:20:00', updatedAt: '2026-09-28T09:35:00'
  },
  {
    ...baseExtras,
    id: 'INS-240821-02', deviceCode: 'RC-007', deviceName: '家庭过山车', area: 'B区', shift: '早班', inspector: '李琪',
    inspectedAt: '2026-09-28T09:05:00', status: '整改中', risk: '中', stopped: false, assignedTo: '电气班组', dueDate: '2026-09-30',
    items: standardItems(true, '2026-09-28T09:05:00'), evidenceCount: 2, version: 2, createdAt: '2026-09-28T09:05:00', updatedAt: '2026-09-28T11:10:00'
  },
  {
    ...baseExtras,
    id: 'INS-240821-03', deviceCode: 'CR-021', deviceName: '旋转木马', area: '亲子区', shift: '中班', inspector: '王璟',
    inspectedAt: '2026-09-27T15:40:00', status: '待复测', risk: '低', stopped: false, assignedTo: '检验二组', dueDate: '2026-09-29',
    items: standardItems(false, '2026-09-27T15:40:00'), evidenceCount: 3, version: 4, createdAt: '2026-09-27T15:40:00', updatedAt: '2026-09-28T10:25:00',
    rechecks: [
      { id: 'RC-CR021-1', itemId: 'lock', itemName: '锁止机构', status: '待复测', reason: '锁止润滑调整后复测', createdAt: '2026-09-28T10:25:00' }
    ]
  },
  {
    ...baseExtras,
    id: 'INS-240821-04', deviceCode: 'WF-003', deviceName: '摩天轮', area: '湖景区', shift: '早班', inspector: '赵帆',
    inspectedAt: '2026-09-27T07:55:00', status: '已关闭', risk: '低', stopped: false, assignedTo: '维修二组', dueDate: '2026-09-28',
    items: standardItems(false, '2026-09-27T07:55:00'), evidenceCount: 5, version: 5, createdAt: '2026-09-27T07:55:00', updatedAt: '2026-09-28T16:20:00',
    release: { state: '已放行', decidedAt: '2026-09-28T16:00:00', basis: '五项检验结果全部正常', reason: '' },
    closure: {
      closedAt: '2026-09-28T16:20:00',
      status: '已关闭',
      stopped: false,
      risk: '低',
      assignedTo: '维修二组',
      operator: '值班主管',
      items: standardItems(false, '2026-09-27T07:55:00').map(({ versions: _v, resultConflict: _r, readingConflict: _g, ...rest }) => rest)
    }
  },
  {
    ...baseExtras,
    verifyState: '待核',
    pendingReason: ['旧记录缺班次标识，先待核'],
    sources: [],
    id: 'INS-240819-09', deviceCode: 'FR-012', deviceName: '碰碰车（旧批次）', area: 'B区', shift: '', inspector: '（字迹不清）',
    inspectedAt: '2026-09-25T10:00:00', status: '待检验', risk: '中', stopped: false, assignedTo: '', dueDate: '',
    items: standardItems(false, '2026-09-25T10:00:00'), evidenceCount: 1, version: 1, createdAt: '2026-09-25T10:00:00', updatedAt: '2026-09-25T10:00:00'
  }
]

export const seedAudit: AuditEntry[] = seedRecords.flatMap((record) => [
  { id: `${record.id}-A1`, recordId: record.id, action: '创建检验记录', operator: record.inspector || '历史导入', detail: `${record.deviceName}完成班前检验`, createdAt: record.createdAt },
  ...(record.version > 1 ? [{ id: `${record.id}-A${record.version}`, recordId: record.id, action: record.status, operator: '系统流转', detail: `记录更新至版本 V${record.version}`, createdAt: record.updatedAt }] : [])
])
