import axios from 'axios'
import type { InspectionDraft, InspectionRecord, MergedItem } from '../types'

const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 5000
})

export async function loadInspectionSnapshot(fallback: InspectionRecord[]): Promise<InspectionRecord[]> {
  if (!import.meta.env.VITE_API_BASE_URL) return fallback
  try {
    const response = await client.get<InspectionRecord[]>('/inspections')
    return response.data
  } catch {
    return fallback
  }
}

function freshItems(operator: string, at: string): MergedItem[] {
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
    versions: [{ source: '平板' as const, operator, recordedAt: at, result: '正常' as const, reading: '待录入', note: '' }]
  }))
}

export function createOfflineInspection(draft: InspectionDraft): InspectionRecord {
  const now = new Date().toISOString()
  return {
    id: `INS-${Date.now().toString().slice(-10)}`,
    ...draft,
    inspectedAt: now,
    status: '待检验',
    stopped: false,
    items: freshItems(draft.inspector, now),
    evidenceCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    verifyState: draft.shift ? '有效' : '待核',
    pendingReason: draft.shift ? [] : ['旧记录缺班次标识，先待核'],
    sources: ['平板'],
    stoppedDisputed: false,
    assigneeDisputed: false,
    rechecks: [],
    release: { state: '未申请' },
    reviews: []
  }
}

export function connectLiveUpdates(onMessage: (message: string) => void): () => void {
  const endpoint = import.meta.env.VITE_WS_URL
  if (!endpoint) return () => undefined
  const socket = new WebSocket(endpoint)
  socket.addEventListener('message', (event) => onMessage(String(event.data)))
  return () => socket.close()
}
