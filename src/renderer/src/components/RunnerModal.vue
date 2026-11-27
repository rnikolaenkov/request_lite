<script setup>
// Collection Runner: последовательный прогон всех сохранённых запросов активного
// проекта с подстановкой активного окружения. История ответов не пишется
// (history: null) — прогон не приравнивается к ручной отправке.
import { computed, ref } from 'vue'
import { useProjectsStore } from '../stores/projects.js'
import { useRequestsStore } from '../stores/requests.js'
import { useEnvironmentsStore } from '../stores/environments.js'
import { applyEnvironment, buildVars } from '../lib/variables.js'

const projects = useProjectsStore()
const requests = useRequestsStore()
const environments = useEnvironmentsStore()

const running = ref(false)
const aborted = ref(false)
const results = ref([])

const items = computed(() => requests.items ?? [])
const passedCount = computed(() => results.value.filter((r) => r.ok).length)
const failedCount = computed(() => results.value.filter((r) => !r.ok && r.done).length)

async function runAll() {
  if (!items.value.length || running.value) return
  running.value = true
  aborted.value = false
  results.value = items.value.map((req) => ({
    id: req.id,
    name: req.name || req.url,
    method: req.method || 'GET',
    url: req.url,
    done: false,
    ok: false,
    status: null,
    time: null,
    error: ''
  }))

  const vars = buildVars(
    environments.items.find((e) => e.id === environments.activeId)?.variables
  )

  for (let i = 0; i < items.value.length; i++) {
    if (aborted.value) break
    const req = items.value[i]
    const row = results.value[i]
    try {
      // Снимок сохранённого запроса — та же модель, что отправляет вкладка.
      const snapshot = {
        name: req.name,
        method: req.method || 'GET',
        url: req.url || '',
        params: req.params ?? [],
        headers: req.headers ?? [],
        body: req.body ?? { type: 'none' },
        auth: req.auth ?? { type: 'none' },
        sslVerify: req.sslVerify !== false
      }
      const res = await window.api.http.send(`runner-${req.id}-${Date.now()}`, applyEnvironment(snapshot, vars), null)
      row.status = res?.ok ? res.response?.status ?? null : null
      row.time = res?.ok ? res.response?.timeMs ?? null : null
      row.ok = typeof row.status === 'number' && row.status >= 200 && row.status < 400
      if (!row.ok && res?.error) row.error = res.error.message ?? String(res.error)
    } catch (err) {
      row.ok = false
      row.error = err?.message ?? 'Ошибка запроса'
    } finally {
      row.done = true
    }
  }

  running.value = false
}

function stop() {
  aborted.value = true
}

function close() {
  if (running.value) stop()
  emit('close')
}
</script>

<template>
  <div v-if="visible" class="dialog-overlay" @mousedown.self="close">
    <div class="dialog" style="width: 680px; max-width: calc(100vw - 48px);" role="dialog" aria-label="Collection Runner">
      <h3 class="dialog-title">Collection Runner</h3>
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: var(--text-secondary); font-size: 13px;">
            Запросов в проекте: {{ items.length }}
            <template v-if="results.length">
              · Успешно: {{ passedCount }} · Ошибок: {{ failedCount }}
            </template>
          </span>
          <div style="display: flex; gap: 8px;">
            <button
              v-if="!running"
              class="btn-primary"
              :disabled="!items.length || !projects.activeProjectId"
              @click="runAll"
            >
              Запустить все
            </button>
            <button v-else class="btn-danger" @click="stop">Остановить</button>
          </div>
        </div>

        <div
          v-if="!items.length"
          style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 13px;"
        >
          В текущем проекте нет сохранённых запросов.
        </div>

        <div
          v-else
          style="max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;"
        >
          <div
            v-for="(row, idx) in results.length ? results : items"
            :key="row.id || idx"
            style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 6px; background: var(--bg-secondary); border: 1px solid var(--border); font-size: 13px; gap: 10px;"
          >
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <strong style="min-width: 52px;">{{ row.method || 'GET' }}</strong>
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                {{ row.name || row.url }}
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
              <template v-if="results.length">
                <span v-if="!row.done" style="color: var(--text-secondary);">ожидание…</span>
                <span
                  v-else
                  :style="{ color: row.ok ? 'var(--status-ok)' : 'var(--danger)', fontWeight: 600 }"
                >
                  {{ row.status ?? 'ERR' }}
                </span>
                <span v-if="row.time != null" style="color: var(--text-secondary);">{{ row.time }} ms</span>
                <span
                  v-if="row.error"
                  style="color: var(--danger); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                  :title="row.error"
                >
                  {{ row.error }}
                </span>
              </template>
            </div>
          </div>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn" @click="close">Закрыть</button>
      </div>
    </div>
  </div>
</template>
