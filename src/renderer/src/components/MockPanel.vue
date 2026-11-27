<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useMocksStore } from '../stores/mocks.js'
import { highlightJson, prettyJson } from '../lib/format.js'
import Icon from './Icon.vue'
import KeyValueTable from './KeyValueTable.vue'

// Панель мок-сервера (вид «Мок-сервер»): управление слушателем, редактор
// маршрутов и журнал принятых запросов. Редактор работает с локальной копией
// конфигурации; сохранение — целиком (mocks.saveConfig), ошибки валидации — inline.
const mocks = useMocksStore()
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const panelTabs = ['Маршруты', 'Журнал']
const activePanelTab = ref('Маршруты')

// --- Управление сервером ---
const portInput = ref(4547)
const starting = ref(false)

onMounted(async () => {
  if (!mocks.status.port) await mocks.refreshStatus()
  portInput.value = mocks.status.port ?? mocks.status.defaultPort ?? 4547
  await mocks.loadLog()
})

const isRunning = computed(() => mocks.status.state === 'running')
const statusClass = computed(() => {
  if (mocks.status.state === 'running') return 'status-ok'
  if (mocks.status.state === 'error') return 'status-err'
  return 'status-warn'
})
const statusText = computed(() => {
  if (mocks.status.state === 'running') return 'Запущен'
  if (mocks.status.state === 'error') return 'Ошибка'
  return 'Остановлен'
})

async function start() {
  starting.value = true
  try {
    await mocks.start(portInput.value)
  } finally {
    starting.value = false
  }
}

async function stop() {
  await mocks.stop()
}

// --- Редактор маршрутов: локальная копия конфигурации ---
// method '' = «любой» (в конфиге null); числа через v-model.number,
// на сохранении нормализуем NaN в дефолты — строгую валидацию делает storage.
const local = reactive({ routes: [], defaultResponse: null })
const saving = ref(false)
const saveError = ref(null)

function cloneConfig(config) {
  return {
    routes: (config?.routes ?? []).map((route) => ({
      id: route.id,
      method: route.method ?? '',
      path: route.path ?? '',
      status: route.status ?? 200,
      headers: (route.headers ?? []).map((header) => ({ ...header })),
      body: route.body ?? '',
      delayMs: route.delayMs ?? 0
    })),
    defaultResponse: {
      status: config?.defaultResponse?.status ?? 404,
      body: config?.defaultResponse?.body ?? ''
    }
  }
}

watch(
  [() => mocks.activeProjectId, () => mocks.config],
  () => {
    Object.assign(local, cloneConfig(mocks.config))
    saveError.value = null
  },
  { immediate: true }
)

function addRoute() {
  local.routes.push({ id: null, method: 'GET', path: '', status: 200, headers: [], body: '', delayMs: 0 })
}

function removeRoute(index) {
  local.routes.splice(index, 1)
}

function normalizeForSave() {
  return {
    routes: local.routes.map((route) => ({
      id: route.id ?? undefined,
      method: route.method === '' ? null : route.method,
      path: route.path,
      status: Number.isInteger(route.status) ? route.status : 200,
      headers: route.headers.map((header) => ({ ...header })),
      body: route.body,
      delayMs: Number.isInteger(route.delayMs) ? route.delayMs : 0
    })),
    defaultResponse: {
      status: Number.isInteger(local.defaultResponse.status) ? local.defaultResponse.status : 404,
      body: local.defaultResponse.body
    }
  }
}

async function save() {
  saving.value = true
  saveError.value = null
  try {
    await mocks.saveConfig(normalizeForSave())
    Object.assign(local, cloneConfig(mocks.config))
  } catch (error) {
    saveError.value = error?.message ?? 'Не удалось сохранить конфигурацию'
  } finally {
    saving.value = false
  }
}

// --- Журнал принятых запросов ---
const expandedIndex = ref(-1)

function toggleEntry(index) {
  expandedIndex.value = expandedIndex.value === index ? -1 : index
}

function entryTime(ts) {
  const date = new Date(ts)
  const pad = (n, len = 2) => String(n).padStart(len, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

// Тело: pretty + подсветка JSON, если он распарсился; иначе — как есть.
function highlightedBody(entry) {
  if (entry.body == null) return ''
  const text = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body, null, 2)
  const pretty = prettyJson(text) ?? text
  return highlightJson(pretty)
}
</script>

<template>
  <section class="mock-panel">
    <div class="mock-control-row">
      <label class="pane-label" for="mock-port">Порт</label>
      <input
        id="mock-port"
        v-model.number="portInput"
        class="mock-port-input"
        type="number"
        min="1024"
        max="65535"
        :disabled="isRunning"
        spellcheck="false"
        aria-label="Порт мок-сервера"
      />
      <button v-if="!isRunning" class="btn btn-primary" :disabled="starting || !mocks.activeProjectId" @click="start">
        Запустить
      </button>
      <button v-else class="btn btn-danger" @click="stop">Остановить</button>
      <span class="status-pill" :class="statusClass">{{ statusText }}</span>
      <span v-if="isRunning" class="meta-pill">{{ mocks.status.address }}</span>
      <span v-else-if="mocks.status.state === 'error'" class="mock-error">{{ mocks.status.message }}</span>
      <span v-if="mocks.activeProject" class="meta-pill" title="Мок-проект сервера">
        {{ mocks.activeProject.name }}
      </span>
    </div>

    <div class="request-tabs-row">
      <button
        v-for="name in panelTabs"
        :key="name"
        class="request-tab"
        :class="{ active: activePanelTab === name }"
        @click="activePanelTab = name"
      >
        {{ name }}
        <span v-if="name === 'Журнал' && mocks.log.length" class="tab-counter">{{ mocks.log.length }}</span>
      </button>
    </div>

    <div class="request-tab-content">
      <!-- Маршруты -->
      <div v-if="activePanelTab === 'Маршруты'" class="tab-pane">
        <p v-if="!mocks.activeProjectId" class="pane-hint">Создайте мок-проект в сайдбаре, чтобы настроить маршруты</p>
        <template v-else>
          <div v-for="(route, index) in local.routes" :key="route.id ?? index" class="mock-route-card">
            <div class="mock-route-line">
              <select v-model="route.method" class="method-select" aria-label="Метод маршрута">
                <option value="">любой</option>
                <option v-for="method in methods" :key="method" :value="method">{{ method }}</option>
              </select>
              <input
                v-model="route.path"
                class="mock-path-input"
                type="text"
                placeholder="/api/users"
                spellcheck="false"
                aria-label="Путь маршрута"
              />
              <input
                v-model.number="route.status"
                class="mock-status-input"
                type="number"
                placeholder="200"
                aria-label="HTTP-статус"
              />
              <input
                v-model.number="route.delayMs"
                class="mock-delay-input"
                type="number"
                min="0"
                placeholder="0"
                aria-label="Задержка ответа, мс"
                title="Задержка ответа, мс"
              />
              <button
                class="btn-icon btn-icon-danger"
                title="Удалить маршрут"
                aria-label="Удалить маршрут"
                @click="removeRoute(index)"
              >
                <Icon name="close" :size="13" />
              </button>
            </div>
            <KeyValueTable
              :rows="route.headers"
              key-placeholder="Заголовок"
              value-placeholder="Значение"
              @update:rows="route.headers = $event"
            />
            <textarea
              v-model="route.body"
              class="body-textarea mock-body-textarea"
              rows="4"
              placeholder='Тело ответа, например {"ok": true}'
              spellcheck="false"
              aria-label="Тело ответа маршрута"
            ></textarea>
          </div>
          <div class="mock-actions-row">
            <button class="btn" @click="addRoute">+ Маршрут</button>
          </div>

          <div class="mock-route-card mock-default-card">
            <div class="mock-route-line">
              <span class="pane-label">Ответ по умолчанию (неотматченные запросы)</span>
              <input
                v-model.number="local.defaultResponse.status"
                class="mock-status-input"
                type="number"
                placeholder="404"
                aria-label="HTTP-статус ответа по умолчанию"
              />
            </div>
            <textarea
              v-model="local.defaultResponse.body"
              class="body-textarea mock-body-textarea"
              rows="3"
              placeholder='Тело ответа по умолчанию, например {"error": "not found"}'
              spellcheck="false"
              aria-label="Тело ответа по умолчанию"
            ></textarea>
          </div>

          <div class="mock-actions-row">
            <button class="btn btn-primary" :disabled="saving" @click="save">Сохранить</button>
            <span v-if="saveError" class="mock-error">{{ saveError }}</span>
          </div>
        </template>
      </div>

      <!-- Журнал -->
      <div v-else class="tab-pane">
        <div class="mock-log-toolbar">
          <button class="btn" :disabled="!mocks.log.length" @click="mocks.clearLog()">Очистить</button>
        </div>
        <p v-if="!mocks.log.length" class="pane-hint">
          Запросов пока не было — запустите сервер и отправьте запрос на его адрес
        </p>
        <ul v-else class="mock-log-list">
          <li v-for="(entry, index) in mocks.log" :key="`${entry.ts}-${index}`" class="mock-log-entry">
            <button class="mock-log-row" :aria-expanded="expandedIndex === index" @click="toggleEntry(index)">
              <span class="meta-pill">{{ entryTime(entry.ts) }}</span>
              <span class="mock-log-method">{{ entry.method }}</span>
              <span class="mock-log-url" :title="entry.url">{{ entry.url }}</span>
            </button>
            <div v-if="expandedIndex === index" class="mock-log-details">
              <div class="mock-log-section">Заголовки</div>
              <div class="mock-log-headers">
                <template v-for="(value, key) in entry.headers" :key="key">
                  <span class="mock-log-header-key">{{ key }}</span>
                  <span class="mock-log-header-value">{{ value }}</span>
                </template>
              </div>
              <div class="mock-log-section">Тело</div>
              <pre v-if="entry.body != null" class="mock-log-body" v-html="highlightedBody(entry)"></pre>
              <p v-else class="mock-log-empty-body">— пусто —</p>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
