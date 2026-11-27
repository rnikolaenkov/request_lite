<script setup>
// Нагрузочный прогон активной вкладки: снимок запроса + переменные активного
// окружения (как при обычной отправке), выполнение в main-процессе.
import { ref } from 'vue'
import { useTabsStore, toSnapshot } from '../stores/tabs.js'
import { useEnvironmentsStore } from '../stores/environments.js'
import { applyEnvironment, buildVars } from '../lib/variables.js'

const props = defineProps({
  visible: Boolean
})
const emit = defineEmits(['close'])

const tabs = useTabsStore()
const environments = useEnvironmentsStore()

const totalRequests = ref(30)
const concurrency = ref(5)
const running = ref(false)
const result = ref(null)
const errorMsg = ref('')

async function start() {
  const tab = tabs.activeTab
  if (!tab || !tab.url.trim()) return
  running.value = true
  result.value = null
  errorMsg.value = ''

  try {
    const vars = buildVars(
      environments.items.find((e) => e.id === environments.activeId)?.variables
    )
    const prepared = applyEnvironment(toSnapshot(tab), vars)
    result.value = await window.api.loadtest.run({
      request: prepared,
      totalRequests: totalRequests.value,
      concurrency: concurrency.value
    })
  } catch (err) {
    errorMsg.value = err?.message ?? 'Ошибка нагрузочного теста'
  } finally {
    running.value = false
  }
}

function cancel() {
  window.api.loadtest.cancel()
}
</script>

<template>
  <div v-if="visible" class="dialog-overlay" @mousedown.self="!running && emit('close')">
    <div class="dialog" style="width: 520px; max-width: calc(100vw - 48px);" role="dialog" aria-label="Нагрузочный тест">
      <h3 class="dialog-title">Нагрузочный тест (Load Tester)</h3>
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <label style="display: flex; flex-direction: column; gap: 4px;">
            <span style="color: var(--text-secondary);">Всего запросов (1–500)</span>
            <input v-model.number="totalRequests" class="dialog-input" type="number" min="1" max="500" :disabled="running" />
          </label>
          <label style="display: flex; flex-direction: column; gap: 4px;">
            <span style="color: var(--text-secondary);">Потоков (1–50)</span>
            <input v-model.number="concurrency" class="dialog-input" type="number" min="1" max="50" :disabled="running" />
          </label>
        </div>

        <div v-if="errorMsg" style="color: var(--danger); font-size: 13px;">{{ errorMsg }}</div>

        <div
          v-if="result"
          style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; font-variant-numeric: tabular-nums;"
        >
          <div>
            <div style="color: var(--text-secondary);">RPS</div>
            <strong style="font-size: 16px; color: var(--accent);">{{ result.rps }}</strong>
          </div>
          <div>
            <div style="color: var(--text-secondary);">Выполнено</div>
            <strong>{{ result.completed }} / {{ result.total }}</strong>
          </div>
          <div>
            <div style="color: var(--text-secondary);">Ошибок</div>
            <strong :style="{ color: result.errors ? 'var(--danger)' : 'var(--status-ok)' }">{{ result.errors }}</strong>
          </div>
          <div>
            <div style="color: var(--text-secondary);">Min / Avg</div>
            <strong>{{ result.minMs }} / {{ result.avgMs }} ms</strong>
          </div>
          <div>
            <div style="color: var(--text-secondary);">p95</div>
            <strong>{{ result.p95Ms }} ms</strong>
          </div>
          <div>
            <div style="color: var(--text-secondary);">Max / Всего</div>
            <strong>{{ result.maxMs }} ms / {{ result.totalMs }} ms</strong>
          </div>
        </div>

        <div v-if="result && Object.keys(result.statusCounts).length" style="display: flex; gap: 8px; flex-wrap: wrap;">
          <span
            v-for="(count, code) in result.statusCounts"
            :key="code"
            style="padding: 2px 8px; border-radius: 4px; background: var(--bg-elevated); border: 1px solid var(--border); font-size: 12px;"
          >
            HTTP {{ code }}: <strong>{{ count }}</strong>
          </span>
        </div>
      </div>
      <div class="dialog-actions">
        <button v-if="running" class="btn-danger" @click="cancel">Остановить</button>
        <button v-else class="btn-primary" @click="start">Запустить</button>
        <button class="btn" :disabled="running" @click="emit('close')">Закрыть</button>
      </div>
    </div>
  </div>
</template>
