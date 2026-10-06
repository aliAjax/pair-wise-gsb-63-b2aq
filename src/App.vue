<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { useInspectionStore } from './stores/inspection'
import { connectLiveUpdates } from './services/api'

const route = useRoute()
const store = useInspectionStore()
let disconnect: () => void = () => undefined

const pageTitle = computed(() => {
  if (route.name === 'defects') return '缺陷处置看板'
  if (route.name === 'audit') return '检验审计'
  if (route.name === 'record') return '检验任务详情'
  return '日常检验总览'
})

const statusText = computed(() => {
  if (!store.online) return '园区断网：记录留在平板'
  if (store.networkFault) return '回连异常：补传将重试'
  return '本地实时通道已就绪'
})

onMounted(() => {
  disconnect = connectLiveUpdates((message) => { store.liveMessage = message })
})
onUnmounted(() => disconnect())
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">安</span>
        <div>
          <strong>游乐设施检验台</strong>
          <small>设备安全与缺陷闭环</small>
        </div>
      </div>
      <nav>
        <RouterLink to="/"><span>01</span>检验总览</RouterLink>
        <RouterLink to="/defects"><span>02</span>缺陷处置</RouterLink>
        <RouterLink to="/audit"><span>03</span>操作审计</RouterLink>
      </nav>
      <div class="sidebar-status" :class="{ offline: !store.online, fault: store.networkFault }">
        <i />
        <div>
          <strong>{{ statusText }}</strong>
          <small>待补传 {{ store.stats.queued }} 条 · 待核 {{ store.stats.pending }} 批</small>
        </div>
      </div>
    </aside>
    <main>
      <header class="topbar">
        <div>
          <p>设备安全运营中心 / 现场检验</p>
          <h1>{{ pageTitle }}</h1>
        </div>
        <div class="session">
          <span>值班检验员</span>
          <strong>周宁</strong>
        </div>
      </header>
      <RouterView />
    </main>
  </div>
</template>
