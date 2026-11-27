<script setup>
// Журнал локального HTTP-прокси: опрос статуса/лога раз в 1.5 с, пока модалка открыта.
// «Во вкладку» переносит перехваченный запрос в новую вкладку редактора.
import { onBeforeUnmount, ref, watch } from 'vue'
import { useTabsStore } from '../stores/tabs.js'
import { useUiStore } from '../stores/ui.js'

const props = defineProps({
  visible: Boolean
})
const emit = defineEmits(['close'])

const tabs = useTabsStore()
const ui = useUiStore()

const port = ref(8888)
const running = ref(false)
const logs = ref([])
const errorMsg = ref('')
let timer = null

async function refresh() {
  const st = await window.api.proxy.status()
  running.value = st.running
  if (st.port) port.value = st.port
  logs.value = await window.api.proxy.getLog()
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      refresh()
      timer = setInterval(refresh, 1500)
    } else if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
)

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

async function toggle() {
  errorMsg.value = ''
  if (running.value) {
    await window.api.proxy.stop()
  } else {
    const res = await window.api.proxy.start(port.value)
    if (!res.ok) errorMsg.value = res.error || 'Не удалось запустить прокси'
  }
  await refresh()
}

async function clear() {
  await window.api.proxy.clearLog()
  logs.value = []
}

function openInTab(entry) {
  tabs.openStartTab()
  tabs.updateActive({
    name: `${entry.method} ${entry.url}`,
    method: entry.method,
    url: entry.url,
    headers: entry.headers || [],
    body: entry.body ? { type: 'json', json: entry.body } : { type: 'none' }
  })
  ui.setView('requests')
  emit('close')
}
</script>

<template>
  <div v-if="visible" class="dialog-overlay" @mousedown.self="emit('close')">
    <div class="dialog" style="width: 680px; max-width: calc(100vw - 48px);" role="dialog" aria-label="Локальный HTTP-прокси">
      <h3 class="dialog-title">Локальный HTTP-прокси (перехватчик трафика)</h3>
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <label style="display: flex; align-items: center; gap: 6px;">
            <span style="color: var(--text-secondary);">Порт:</span>
            <input v-model.number="port" class="dialog-input" style="width: 90px;" type="number" min="1024" max="65535" :disabled="running" />
          </label>
          <button :class="running ? 'btn-danger' : 'btn-primary'" @click="toggle">
            {{ running ? 'Остановить' : 'Запустить прокси' }}
          </button>
          <button class="btn" @click="clear">Очистить</button>
          <span style="margin-left: auto; font-size: 12px; color: var(--text-secondary);">
            {{ running ? `Слушает 127.0.0.1:${port}` : 'Остановлен' }}
          </span>
        </div>

        <div v-if="errorMsg" style="color: var(--danger); font-size: 13px;">{{ errorMsg }}</div>

        <div style="max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;">
          <div
            v-if="!logs.length"
            style="padding: 16px; text-align: center; color: var(--text-secondary);"
          >
            Перехваченных запросов пока нет. Направьте HTTP-трафик на 127.0.0.1:{{ port }}.
          </div>
          <div
            v-for="entry in logs"
            :key="entry.id"
            style="display: grid; grid-template-columns: 64px 58px 1fr 54px 62px auto; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; font-size: 12px;"
          >
            <span style="color: var(--text-secondary); font-variant-numeric: tabular-nums;">{{ entry.time }}</span>
            <span class="item-method" :class="`method-${entry.method}`">{{ entry.method }}</span>
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="entry.url">{{ entry.url }}</span>
            <span style="font-variant-numeric: tabular-nums;">{{ entry.status }}</span>
            <span style="color: var(--text-secondary); font-variant-numeric: tabular-nums;">{{ entry.durationMs }} ms</span>
            <button class="btn" style="padding: 2px 8px; font-size: 11px;" @click="openInTab(entry)">Во вкладку</button>
          </div>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn" @click="emit('close')">Закрыть</button>
      </div>
    </div>
  </div>
</template>
