<script setup>
import { inject, onMounted, ref, watch } from 'vue'
import { useEnvironmentsStore } from '../stores/environments.js'
import { useProjectsStore } from '../stores/projects.js'
import { useUiStore } from '../stores/ui.js'
import { parseOpenApi } from '../lib/openapi.js'
import EnvironmentsDialog from './EnvironmentsDialog.vue'
import ProxyModal from './ProxyModal.vue'
import RunnerModal from './RunnerModal.vue'
import Icon from './Icon.vue'

const ui = useUiStore()
const projects = useProjectsStore()
const environments = useEnvironmentsStore()
const dialog = inject('dialog')
const manageVisible = ref(false)
const proxyVisible = ref(false)
const runnerVisible = ref(false)

// Список и активный выбор живут по активному проекту.
onMounted(() => environments.load(projects.activeProjectId))
watch(
  () => projects.activeProjectId,
  (id) => environments.load(id)
)

function select(event) {
  environments.setActive(event.target.value === '' ? null : event.target.value)
}

// Импорт OpenAPI/Swagger JSON: file picker → парсинг → bulk-импорт в новый проект.
async function importOpenApi() {
  const picked = await window.api.postman.pickAndRead()
  if (!picked.ok) {
    if (picked.error) {
      await dialog.value.alert({ title: 'Импорт OpenAPI', message: picked.error })
    }
    return // отмена выбора файла — ничего не делаем
  }
  let parsed
  try {
    parsed = parseOpenApi(picked.content)
  } catch (err) {
    await dialog.value.alert({ title: 'Импорт OpenAPI', message: err?.message ?? 'Не удалось разобрать файл' })
    return
  }
  await projects.importCollection({ name: parsed.name, requests: parsed.requests, variables: parsed.variables })
  await environments.load(projects.activeProjectId)
}
</script>

<template>
  <header class="toolbar">
    <div class="toolbar-brand"><span class="brand-accent">Request</span> Lite</div>
    <div class="toolbar-center">
      <div class="view-switch" role="tablist" aria-label="Вид приложения">
        <button
          class="view-switch-btn"
          :class="{ active: ui.view === 'requests' }"
          role="tab"
          :aria-selected="ui.view === 'requests'"
          @click="ui.setView('requests')"
        >
          Запросы
        </button>
        <button
          class="view-switch-btn"
          :class="{ active: ui.view === 'mocks' }"
          role="tab"
          :aria-selected="ui.view === 'mocks'"
          @click="ui.setView('mocks')"
        >
          Мок-сервер
        </button>
      </div>
      <select
        class="env-select"
        :value="environments.activeId ?? ''"
        aria-label="Активное окружение"
        @change="select"
      >
        <option value="">No Environment</option>
        <option v-for="environment in environments.items" :key="environment.id" :value="environment.id">
          {{ environment.name }}
        </option>
      </select>
      <button
        class="btn-icon"
        title="Управление окружениями"
        aria-label="Управление окружениями"
        @click="manageVisible = true"
      >
        <Icon name="settings" />
      </button>
    </div>
    <div class="toolbar-right">
      <button
        class="btn"
        style="padding: 4px 10px; font-size: 12px;"
        title="Локальный HTTP-прокси (перехватчик)"
        @click="proxyVisible = true"
      >
        Proxy
      </button>
      <button
        class="btn"
        style="padding: 4px 10px; font-size: 12px;"
        title="Импортировать OpenAPI / Swagger JSON"
        @click="importOpenApi"
      >
        + OpenAPI
      </button>
      <button
        class="btn"
        style="padding: 4px 10px; font-size: 12px;"
        title="Запустить все запросы проекта (Collection Runner)"
        @click="runnerVisible = true"
      >
        ▶ Run
      </button>
      <button
        class="btn-icon"
        :title="ui.theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'"
        aria-label="Переключить тему"
        @click="ui.toggleTheme()"
      >
        <Icon :name="ui.theme === 'dark' ? 'sun' : 'moon'" />
      </button>
    </div>
  </header>
  <EnvironmentsDialog :visible="manageVisible" @close="manageVisible = false" />
  <ProxyModal :visible="proxyVisible" @close="proxyVisible = false" />
  <RunnerModal :visible="runnerVisible" @close="runnerVisible = false" />
</template>
