import { mergeOperations, migrateRecord } from '../src/services/sync'
import { seedRecords, seedAudit } from '../src/data/seed'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name} ${extra}`) }
}
const at = (h: number, m: number) => `2026-10-06T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`

// 场景 1：早班平板锁扣 + 晚班值班室油温 + 整改人争议
{
  console.log('场景1 同设备同班次并单 / 冲突保留两版 / 争议值不采用')
  let records = seedRecords.map(migrateRecord)
  let audit = structuredClone(seedAudit)
  const targetId = 'INS-240821-02' // 家庭过山车 早班，责任人 电气班组
  const ops = [
    { uid: 'u1', type: '现场录入' as const, targetId, deviceCode: 'RC-007', shift: '早班', operator: '李琪', recordedAt: at(8, 15), status: '待补传' as const, note: '平板锁扣', patch: { itemId: 'lock', result: '异常' as const, reading: '锁扣间隙偏大' } },
    { uid: 'u2', type: '值班室编辑' as const, targetId, deviceCode: 'RC-007', shift: '早班', operator: '晚班值班员', recordedAt: at(20, 40), status: '待补传' as const, note: '值班室油温', patch: { itemId: 'brake', result: '异常' as const, reading: '制动油温 92℃' } },
    { uid: 'u3', type: '值班室编辑' as const, targetId, deviceCode: 'RC-007', shift: '早班', operator: '晚班值班员', recordedAt: at(20, 42), status: '待补传' as const, note: '改整改人', patch: { assignedTo: '维修一组' } }
  ]
  const res = mergeOperations(records, ops, audit)
  records = res.records
  const r = records.find((x) => x.id === targetId)!
  const lock = r.items.find((i) => i.id === 'lock')!
  const brake = r.items.find((i) => i.id === 'brake')!
  check('平板与值班室来源都在', r.sources.includes('平板') && r.sources.includes('值班室'))
  check('锁扣保留两版（种子版+平板版）', lock.versions.length >= 2)
  check('锁扣读数冲突标记（结果同为异常）', lock.readingConflict && !lock.resultConflict)
  check('油温标记读数冲突', brake.readingConflict)
  check('整改人有争议→置空待裁', r.assigneeDisputed && r.assignedTo === '', `got "${r.assignedTo}"`)
  check('记录数没有新增（并单而非覆盖新建）', records.length === seedRecords.length)
  check('全部操作标记已合并', ops.every((o) => o.status === '已合并'))
}

// 场景 2：缺班次 → 失败待核；重复回连不追加审计
{
  console.log('场景2 缺班次失败 + 重复回连幂等')
  let records = seedRecords.map(migrateRecord)
  let audit = structuredClone(seedAudit)
  const ops = [
    { uid: 'u4', type: '值班室编辑' as const, targetId: 'INS-240821-02', deviceCode: 'RC-007', shift: '', operator: '值班员', recordedAt: at(9, 0), status: '待补传' as const, note: '无班次编辑', patch: { itemId: 'brake', result: '正常' as const } }
  ]
  const before = audit.length
  mergeOperations(records, ops, audit)
  check('缺班次操作失败并给出原因', ops[0].status === '失败' && !!ops[0].failReason)
  check('失败不写入审计', audit.length === before)

  // 修复班次后重试同一操作（uid 不变，模拟补传重试）
  ops[0].shift = '早班'
  mergeOperations(records, ops, audit)
  const auditCount1 = audit.filter((a) => a.dedupKey === 'merge:u4').length
  check('重试后成功合并', ops[0].status === '已合并')
  check('同 uid 审计只写一次', auditCount1 === 1, `got ${auditCount1}`)

  // 再次"回连"——无未完成项
  const res3 = mergeOperations(records, [], audit)
  check('空队列不产生变更', res3.merged.length === 0)
}

// 场景 3：结果改动作废未执行复测；已完成复测保留
{
  console.log('场景3 复测作废联动')
  let records = seedRecords.map(migrateRecord)
  let audit = structuredClone(seedAudit)
  // 旋转木马已有一张 lock 待复测单
  const ops = [
    { uid: 'u5', type: '现场录入' as const, targetId: 'INS-240821-03', deviceCode: 'CR-021', shift: '中班', operator: '王璟', recordedAt: at(10, 0), status: '待补传' as const, note: '锁扣新读数', patch: { itemId: 'lock', result: '异常' as const, reading: '间隙 3mm' } }
  ]
  const res = mergeOperations(records, ops, audit)
  const r = res.records.find((x) => x.id === 'INS-240821-03')!
  const rc = r.rechecks[0]
  check('未执行复测被作废', rc.status === '已作废' && !!rc.voidedAt)
  check('审计记录复测作废', audit.some((a) => a.action === '复测作废'))

  // 已完成复测不应被作废：先手工完成，再来一次结果改动
  rc.status = '已完成'
  const ops2 = [
    { uid: 'u6', type: '现场录入' as const, targetId: 'INS-240821-03', deviceCode: 'CR-021', shift: '中班', operator: '王璟', recordedAt: at(11, 0), status: '待补传' as const, note: '锁扣再改', patch: { itemId: 'lock', result: '正常' as const, reading: '间隙 1mm' } }
  ]
  const res2 = mergeOperations(res.records, ops2, audit)
  const r2 = res2.records.find((x) => x.id === 'INS-240821-03')!
  check('已完成复测不追溯作废', r2.rechecks[0].status === '已完成')
}

// 场景 4：放行按新值重判 + 办结留原依据并列复审项
{
  console.log('场景4 放行重判 / 办结留原依据并列复审项')
  let records = seedRecords.map(migrateRecord)
  let audit = structuredClone(seedAudit)
  // 摩天轮已关闭已放行
  const before = records.find((x) => x.id === 'INS-240821-04')!
  check('种子：摩天轮已放行', before.release.state === '已放行')
  check('种子：办结快照存在', !!before.closure)
  const ops = [
    { uid: 'u7', type: '值班室编辑' as const, targetId: 'INS-240821-04', deviceCode: 'WF-003', shift: '早班', operator: '晚班值班员', recordedAt: at(21, 0), status: '待补传' as const, note: '制动油温异常', patch: { itemId: 'brake', result: '异常' as const, reading: '油温 95℃' } }
  ]
  const res = mergeOperations(records, ops, audit)
  const r = res.records.find((x) => x.id === 'INS-240821-04')!
  check('放行结论回退为待判定', r.release.state === '待判定')
  check('办结状态转需复核', r.status === '需复核')
  check('原办结依据保留', !!r.closure && r.closure.items.find((i) => i.id === 'brake')!.reading.includes('2.3'))
  check('并列复审项 1 条且记录原值→新值', r.reviews.length === 1 && r.reviews[0].original.includes('正常') && r.reviews[0].changedTo.includes('95℃'))
  check('审计含放行重判与办结回退', audit.some((a) => a.action === '放行重判') && audit.some((a) => a.action === '办结回退'))
  void res.releaseReset
}

// 场景 5：停用判断争议 → 按未停用处理
{
  console.log('场景5 停用判断只采用无争议值')
  let records = seedRecords.map(migrateRecord)
  let audit = structuredClone(seedAudit)
  // 高空飞翔已 stopped=true；值班室晚班改成未停用（争议）
  const ops = [
    { uid: 'u8', type: '值班室编辑' as const, targetId: 'INS-240821-01', deviceCode: 'AM-014', shift: '早班', operator: '晚班值班员', recordedAt: at(21, 0), status: '待补传' as const, note: '解除停用', patch: { stopped: false } }
  ]
  const res = mergeOperations(records, ops, audit)
  const r = res.records.find((x) => x.id === 'INS-240821-01')!
  check('停用争议置为未停用且标记', r.stopped === false && r.stoppedDisputed === true)
  check('待办原因含禁止复测提示', r.pendingReason.some((p) => p.includes('禁止复测')))
}

// 场景 6：新平板批次与值班室同设备同班次并单
{
  console.log('场景6 平板新批次回连并单')
  let records = seedRecords.filter((r) => r.id !== 'INS-240821-02').map(migrateRecord)
  let audit = structuredClone(seedAudit).filter((a) => !a.recordId.startsWith('OFF'))
  // 值班室先有 RC-007 早班
  const base = migrateRecord(seedRecords.find((r) => r.id === 'INS-240821-02')!)
  base.sources = ['值班室']
  records = [base, ...records]
  const ops = [
    { uid: 'u9', type: '新建批次' as const, deviceCode: 'RC-007', deviceName: '家庭过山车', area: 'B区', shift: '早班', operator: '李琪', recordedAt: at(8, 30), status: '待补传' as const, note: '平板断网批次' }
  ]
  const res = mergeOperations(records, ops, audit)
  const sameDevice = res.records.filter((r) => r.deviceCode === 'RC-007')
  check('没有新建重复批次', sameDevice.length === 1)
  check('来源含平板+值班室', sameDevice[0].sources.length === 2)
}

// 场景 7：缺班次新批次补传重试不重复生成待核记录
{
  console.log('场景7 缺班次新批次重试幂等')
  let records = seedRecords.map(migrateRecord)
  let audit = structuredClone(seedAudit)
  const seedLen = records.length
  const ops = [
    { uid: 'u10', type: '新建批次' as const, deviceCode: 'BV-031', deviceName: '弹跳机', area: 'C区', shift: '', operator: '检验员', recordedAt: at(8, 0), status: '待补传' as const, note: '平板批次无班次' }
  ]
  records = mergeOperations(records, ops, audit).records
  records = mergeOperations(records, ops, audit).records // 再次回连重试
  records = mergeOperations(records, ops, audit).records
  const offs = records.filter((r) => r.id === 'OFF-u10')
  const pendingAudit = audit.filter((a) => a.dedupKey === 'merge:u10')
  check('待核批次只生成一条', offs.length === 1 && records.length === seedLen + 1, `off=${offs.length} total=${records.length}`)
  check('待核审计只写一条', pendingAudit.length === 1, `got ${pendingAudit.length}`)
  check('操作保持失败待补录班次', ops[0].status === '失败')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
