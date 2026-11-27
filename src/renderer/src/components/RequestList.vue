<script setup>
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectsStore } from '../stores/projects.js'
import { useRequestsStore } from '../stores/requests.js'
import { useTabsStore } from '../stores/tabs.js'
import Icon from './Icon.vue'

const projects = useProjectsStore()
const requests = useRequestsStore()
const tabs = useTabsStore()
const dialog = inject('dialog')

const listEl = ref(null)

// Список живёт по активному проекту: первичная загрузка и реакция на переключение.
onMounted(() => requests.load(projects.activeProjectId))
watch(
  () => projects.activeProjectId,
  (id) => requests.load(id)
)

// --- Перетаскивание запросов (по образцу вкладок) ---
// Порог отличает клик (открыть запрос) от drag; замок не является drag-источником,
// но сдвигается при drag других. На диске — один reorder по завершении жеста.
const DRAG_THRESHOLD = 4
const EDGE_ZONE = 24
const EDGE_STEP = 12

const draggingId = ref(null)
// Внутреннее состояние drag вне реактивности: в шаблон попадает только draggingId.
let drag = null
let edgeRaf = 0
let edgeDir = 0
// Браузер синтезирует click после pointerup — после drag гасим открытие запроса.
let suppressClick = false

// Клик открывает запрос, но не сразу после drag (см. suppressClick).
// Открывшей вкладке запоминается проект запроса; история ответов подгружается с диска,
// последний ответ показывается с пометкой «из истории» — без отправки запроса.
function open(request) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  const tab = tabs.openSaved(request, projects.activeProjectId)
  tabs.loadHistory(tab.id)
}

function onRowPointerDown(request, event) {
  // Drag — только левой кнопкой и только незаблокированной строки; кнопки строки
  // (замок/удаление) останавливают pointerdown на себе.
  if (event.button !== 0 || request.locked === true || drag) return
  drag = {
    id: request.id,
    startX: event.clientX,
    startY: event.clientY,
    clientY: event.clientY,
    active: false
  }
  // Слушатели на window, без setPointerCapture: строка при живой перестановке
  // перемещается по DOM, а capture при удалении из дерева снимается неявно.
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerUp)
  window.addEventListener('pointercancel', cancelDrag)
}

function onWindowPointerMove(event) {
  if (!drag) return
  drag.clientY = event.clientY
  if (!drag.active) {
    const offset = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY)
    if (offset < DRAG_THRESHOLD) return
    drag.active = true
    draggingId.value = drag.id
    window.addEventListener('keydown', onDragKeydown)
  }
  applyDragPosition()
  updateEdgeScroll()
}

function onWindowPointerUp() {
  if (!drag) return
  const wasActive = drag.active
  const { id } = drag
  endDrag()
  if (!wasActive) return
  suppressClick = true
  // Один IPC на завершение drag: индекс уже применяется локально каждым swap.
  const to = requests.items.findIndex((r) => r.id === id)
  if (to !== -1) requests.reorder(id, to)
}

// Завершение drag без сохранения (Escape/pointercancel): порядок во время жеста
// менялся только локально — откат перечитыванием состояния диска.
async function cancelDrag() {
  if (!drag) return
  const wasActive = drag.active
  endDrag()
  if (wasActive) await requests.load(requests.loadedProjectId)
}

function endDrag() {
  if (!drag) return
  stopEdgeScroll()
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', onWindowPointerUp)
  window.removeEventListener('pointercancel', cancelDrag)
  window.removeEventListener('keydown', onDragKeydown)
  draggingId.value = null
  drag = null
}

function onDragKeydown(event) {
  if (event.key === 'Escape') cancelDrag()
}

// Живая перестановка: курсор прошёл середину соседней строки — строки меняются местами.
function applyDragPosition() {
  const els = listEl.value ? [...listEl.value.querySelectorAll('.request-item')] : []
  const from = els.findIndex((el) => el.dataset.id === drag.id)
  if (from === -1) return
  const rect = els[from].getBoundingClientRect()
  const middle = rect.top + rect.height / 2
  let to = from
  if (drag.clientY > middle && from < els.length - 1) {
    const next = els[from + 1].getBoundingClientRect()
    if (drag.clientY > next.top + next.height / 2) to = from + 1
  } else if (drag.clientY < middle && from > 0) {
    const prev = els[from - 1].getBoundingClientRect()
    if (drag.clientY < prev.top + prev.height / 2) to = from - 1
  }
  if (to !== from) requests.moveLocal(drag.id, to)
}

// Автоскролл списка у краёв: шаг за кадр, позиция пересчитывается каждый кадр —
// прокрутка двигает строки под неподвижным курсором.
function updateEdgeScroll() {
  const list = listEl.value
  if (!list) return
  const rect = list.getBoundingClientRect()
  if (drag.clientY - rect.top < EDGE_ZONE) edgeDir = -1
  else if (rect.bottom - drag.clientY < EDGE_ZONE) edgeDir = 1
  else edgeDir = 0
  if (edgeDir !== 0 && !edgeRaf) edgeRaf = requestAnimationFrame(edgeScrollFrame)
}

function edgeScrollFrame() {
  edgeRaf = 0
  const list = listEl.value
  if (!drag?.active || !edgeDir || !list) return
  list.scrollTop += edgeDir * EDGE_STEP
  applyDragPosition()
  updateEdgeScroll()
}

function stopEdgeScroll() {
  if (edgeRaf) {
    cancelAnimationFrame(edgeRaf)
    edgeRaf = 0
  }
  edgeDir = 0
}

onBeforeUnmount(endDrag)

async function toggleLock(request) {
  const locking = request.locked !== true
  const confirmed = await dialog.value.confirm({
    title: locking ? 'Заблокировать запрос' : 'Разблокировать запрос',
    message: locking
      ? `Заблокировать запрос «${request.name}»? Его нельзя будет изменить и удалить до разблокировки.`
      : `Разблокировать запрос «${request.name}»?`,
    confirmText: locking ? 'Заблокировать' : 'Разблокировать'
  })
  if (!confirmed) return
  await requests.setLocked(request.id, locking)
}

async function remove(request) {
  if (request.locked === true) return
  const confirmed = await dialog.value.confirm({
    title: 'Удалить запрос',
    message: `Удалить запрос «${request.name}» из проекта?`,
    confirmText: 'Удалить'
  })
  if (!confirmed) return
  await requests.remove(request.id)
  // Открытые вкладки этого запроса отвязываются, оставаясь открытыми.
  tabs.detachSaved(request.id)
}
</script>

<template>
  <div class="request-section">
    <div class="sidebar-header">
      <span class="sidebar-title">Запросы</span>
    </div>
    <p v-if="!requests.items.length" class="sidebar-empty">
      Нет сохранённых запросов.<br />Заполните вкладку и нажмите Save.
    </p>
    <ul
      v-else
      ref="listEl"
      class="request-list"
      :class="{ 'is-dragging': draggingId !== null }"
    >
      <li
        v-for="request in requests.items"
        :key="request.id"
        :data-id="request.id"
        tabindex="0"
        class="project-item request-item"
      role="button"
        :class="{ locked: request.locked === true, dragging: request.id === draggingId }"
        :title="request.name"
        @click="open(request)"
        @keydown.enter.prevent="open(request)"
        @keydown.space.prevent="open(request)"
        @pointerdown="onRowPointerDown(request, $event)"
      >
        <span class="item-method" :class="`method-${request.method}`">{{ request.method }}</span>
        <span class="project-name" :title="request.name">
          <span v-if="request.locked === true" class="project-lock-badge" title="Запрос заблокирован">
            <Icon name="lock" :size="12" />
          </span>
          <span v-if="request.pinned === true" class="project-lock-badge" title="Запрос закреплён">
            <Icon name="pin" :size="12" />
          </span>
          {{ request.name }}
        </span>
        <span class="project-actions">
          <button
            class="btn-icon"
            :title="request.locked === true ? 'Разблокировать запрос' : 'Заблокировать запрос'"
            :aria-label="request.locked === true ? 'Разблокировать запрос' : 'Заблокировать запрос'"
            @pointerdown.stop
            @click.stop="toggleLock(request)"
          >
            <Icon :name="request.locked === true ? 'lock' : 'unlock'" :size="13" />
          </button>
          <button
            class="btn-icon"
            :title="request.pinned === true ? 'Открепить запрос' : 'Закрепить запрос'"
            :aria-label="request.pinned === true ? 'Открепить запрос' : 'Закрепить запрос'"
            @pointerdown.stop
            @click.stop="requests.setPinned(request.id, request.pinned !== true)"
          >
            <Icon name="pin" :size="13" />
          </button>
          <button
            class="btn-icon btn-icon-danger"
            :disabled="request.locked === true"
            :title="request.locked === true ? 'Запрос заблокирован' : 'Удалить запрос'"
            aria-label="Удалить запрос"
            @pointerdown.stop
            @click.stop="remove(request)"
          >
            <Icon name="close" :size="13" />
          </button>
        </span>
      </li>
    </ul>
  </div>
</template>
