<script setup>
import { computed, inject, ref } from 'vue'
import { useProjectsStore } from '../stores/projects.js'
import { useRequestsStore } from '../stores/requests.js'
import { useTabsStore } from '../stores/tabs.js'
import KeyValueTable from './KeyValueTable.vue'
import LoadTestModal from './LoadTestModal.vue'

const tabs = useTabsStore()
const projects = useProjectsStore()
const requests = useRequestsStore()
const dialog = inject('dialog')
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const requestTabs = ['Params', 'Headers', 'Body', 'Auth']
const activeRequestTab = ref('Params')
const loadTestVisible = ref(false)

const bodyTypes = [
  { value: 'none', label: 'none' },
  { value: 'json', label: 'json' },
  { value: 'form-data', label: 'form-data' },
  { value: 'urlencoded', label: 'urlencoded' },
  { value: 'text', label: 'text' }
]
const authTypes = [
  { value: 'none', label: 'No Auth' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'apikey', label: 'API Key' }
]

// Активные параметры: включённая галочка и непустой ключ (как их видит отправка).
const activeParamsCount = computed(
  () => tabs.activeTab?.params.filter((p) => p.enabled && p.key !== '').length ?? 0
)

// Активные заголовки — та же формула, бейдж у вкладки Headers.
const activeHeadersCount = computed(
  () => tabs.activeTab?.headers.filter((h) => h.enabled && h.key !== '').length ?? 0
)

const canSend = computed(() => {
  const tab = tabs.activeTab
  return !!tab && !tab.sending && tab.url.trim() !== ''
})

// Связанный с активной вкладкой запрос заблокирован? Save тогда неактивен.
const linkedLocked = computed(() => {
  const tab = tabs.activeTab
  if (!tab?.savedRequestId) return false
  return requests.items.find((r) => r.id === tab.savedRequestId)?.locked === true
})

const saveTooltip = computed(() =>
  linkedLocked.value
    ? 'Запрос заблокирован — разблокируйте, чтобы сохранить'
    : 'Сохранить запрос в активный проект'
)

// Save доступен, когда вкладка не отправляет запрос и есть активный проект.
const canSave = computed(() => {
  const tab = tabs.activeTab
  return !!tab && !tab.sending && !!projects.activeProjectId && !linkedLocked.value
})

function save() {
  tabs.saveActiveViaDialog(dialog.value)
}

function send() {
  tabs.sendActive()
}

function cancel() {
  const tab = tabs.activeTab
  if (tab) tabs.cancelTab(tab.id)
}
</script>

<template>
  <section v-if="tabs.activeTab" class="request-editor">
    <div class="request-line">
      <select
        class="method-select"
        :value="tabs.activeTab.method"
        aria-label="Метод запроса"
        @change="tabs.updateActive({ method: $event.target.value })"
      >
        <option v-for="method in methods" :key="method" :value="method">{{ method }}</option>
      </select>
      <input
        class="url-input"
        type="text"
        placeholder="https://example.com/api"
        spellcheck="false"
        :value="tabs.activeTab.url"
        aria-label="URL запроса"
        @input="tabs.updateActive({ url: $event.target.value })"
        @keydown.enter.prevent="send"
      />
      <button
        v-if="!tabs.activeTab.sending"
        class="btn"
        :disabled="!canSend"
        title="Нагрузочный тест (Load Tester)"
        @click="loadTestVisible = true"
      >
        Load
      </button>
      <button
        v-if="!tabs.activeTab.sending"
        class="btn save-request-btn"
        :disabled="!canSave"
        :title="saveTooltip"
        aria-label="Сохранить запрос"
        @click="save"
      >
        Save
      </button>
      <button
        v-if="!tabs.activeTab.sending"
        class="btn btn-primary send-btn"
        :disabled="!canSend"
        aria-label="Отправить запрос"
        @click="send"
      >
        Send
      </button>
      <button v-else class="btn btn-danger send-btn" aria-label="Отменить отправку" @click="cancel">Cancel</button>
    </div>

    <div class="request-tabs-row">
      <button
        v-for="name in requestTabs"
        :key="name"
        class="request-tab"
        :class="{ active: activeRequestTab === name }"
        @click="activeRequestTab = name"
      >
        {{ name }}
        <span v-if="name === 'Params' && activeParamsCount" class="tab-counter">{{ activeParamsCount }}</span>
        <span v-if="name === 'Headers' && activeHeadersCount" class="tab-counter">{{ activeHeadersCount }}</span>
      </button>
    </div>

    <div class="request-tab-content">
      <!-- Params -->
      <div v-if="activeRequestTab === 'Params'" class="tab-pane">
        <KeyValueTable
          :rows="tabs.activeTab.params"
          key-placeholder="Параметр"
          value-placeholder="Значение"
          @update:rows="tabs.updateActive({ params: $event })"
        />
      </div>

      <!-- Headers -->
      <div v-else-if="activeRequestTab === 'Headers'" class="tab-pane">
        <KeyValueTable
          :rows="tabs.activeTab.headers"
          key-placeholder="Заголовок"
          value-placeholder="Значение"
          @update:rows="tabs.updateActive({ headers: $event })"
        />
      </div>

      <!-- Body -->
      <div v-else-if="activeRequestTab === 'Body'" class="tab-pane">
        <div class="pane-toolbar">
          <label class="pane-label" for="body-type">Тип тела</label>
          <select
            id="body-type"
            class="pane-select"
            :value="tabs.activeTab.body.type"
            @change="tabs.updateActiveBody({ type: $event.target.value })"
          >
            <option v-for="type in bodyTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
          </select>
        </div>
        <textarea
          v-if="tabs.activeTab.body.type === 'json'"
          class="body-textarea"
          rows="8"
          placeholder='{"key": "value"}'
          spellcheck="false"
          :value="tabs.activeTab.body.json"
          aria-label="JSON-тело запроса"
          @input="tabs.updateActiveBody({ json: $event.target.value })"
        ></textarea>
        <textarea
          v-else-if="tabs.activeTab.body.type === 'text'"
          class="body-textarea"
          rows="8"
          placeholder="Произвольный текст"
          spellcheck="false"
          :value="tabs.activeTab.body.text"
          aria-label="Текстовое тело запроса"
          @input="tabs.updateActiveBody({ text: $event.target.value })"
        ></textarea>
        <KeyValueTable
          v-else-if="tabs.activeTab.body.type === 'form-data'"
          :rows="tabs.activeTab.body.form"
          key-placeholder="Поле"
          value-placeholder="Значение"
          @update:rows="tabs.updateActiveBody({ form: $event })"
        />
        <KeyValueTable
          v-else-if="tabs.activeTab.body.type === 'urlencoded'"
          :rows="tabs.activeTab.body.urlencoded"
          key-placeholder="Поле"
          value-placeholder="Значение"
          @update:rows="tabs.updateActiveBody({ urlencoded: $event })"
        />
        <p v-else class="pane-hint">Тело не отправляется</p>
      </div>

      <!-- Auth -->
      <div v-else-if="activeRequestTab === 'Auth'" class="tab-pane">
        <div class="pane-toolbar">
          <label class="pane-label" for="auth-type">Тип авторизации</label>
          <select
            id="auth-type"
            class="pane-select"
            :value="tabs.activeTab.auth.type"
            @change="tabs.updateActiveAuth({ type: $event.target.value })"
          >
            <option v-for="type in authTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
          </select>
        </div>
        <div v-if="tabs.activeTab.auth.type === 'bearer'" class="field-grid">
          <label class="field-label" for="bearer-token">Token</label>
          <input
            id="bearer-token"
            type="text"
            placeholder="Токен"
            spellcheck="false"
            :value="tabs.activeTab.auth.token"
            @input="tabs.updateActiveAuth({ token: $event.target.value })"
          />
        </div>
        <div v-else-if="tabs.activeTab.auth.type === 'basic'" class="field-grid">
          <label class="field-label" for="basic-username">Username</label>
          <input
            id="basic-username"
            type="text"
            spellcheck="false"
            :value="tabs.activeTab.auth.username"
            @input="tabs.updateActiveAuth({ username: $event.target.value })"
          />
          <label class="field-label" for="basic-password">Password</label>
          <input
            id="basic-password"
            type="password"
            :value="tabs.activeTab.auth.password"
            @input="tabs.updateActiveAuth({ password: $event.target.value })"
          />
        </div>
        <template v-else-if="tabs.activeTab.auth.type === 'apikey'">
          <div class="field-grid">
            <label class="field-label" for="apikey-key">Key</label>
            <input
              id="apikey-key"
              type="text"
              placeholder="X-Api-Key"
              spellcheck="false"
              :value="tabs.activeTab.auth.key"
              @input="tabs.updateActiveAuth({ key: $event.target.value })"
            />
            <label class="field-label" for="apikey-value">Value</label>
            <input
              id="apikey-value"
              type="text"
              spellcheck="false"
              :value="tabs.activeTab.auth.value"
              @input="tabs.updateActiveAuth({ value: $event.target.value })"
            />
            <label class="field-label" for="apikey-placement">Добавить в</label>
            <select
              id="apikey-placement"
              :value="tabs.activeTab.auth.placement"
              @change="tabs.updateActiveAuth({ placement: $event.target.value })"
            >
              <option value="header">Заголовок</option>
              <option value="query">Query-параметр</option>
            </select>
          </div>
        </template>
        <p v-else class="pane-hint">Авторизация не используется</p>

        <label class="ssl-toggle" title="Отключите для серверов с самоподписанными сертификатами">
          <input
            type="checkbox"
            :checked="tabs.activeTab.sslVerify"
            @change="tabs.updateActive({ sslVerify: $event.target.checked })"
          />
          Проверять SSL-сертификат
        </label>
      </div>
    </div>
    <LoadTestModal :visible="loadTestVisible" @close="loadTestVisible = false" />
  </section>
</template>
