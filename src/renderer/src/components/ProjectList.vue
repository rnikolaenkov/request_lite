<script setup>
import { inject, onBeforeUnmount, ref } from 'vue'
import { useProjectsStore } from '../stores/projects.js'
import Icon from './Icon.vue'

const projects = useProjectsStore()
const dialog = inject('dialog')

const listEl = ref(null)

// --- Перетаскивание проектов (по образцу списка запросов) ---
// Порог отличает клик (выбор активного проекта) от drag; замок не является
// drag-источником, но сдвигается при drag других. На диске — один reorder
// по завершении жеста (атомарная запись индекса).
const DRAG_THRESHOLD = 4
const EDGE_ZONE = 24
const EDGE_STEP = 12

const draggingId = ref(null)
// Внутреннее состояние drag вне реактивности: в шаблон попадает только draggingId.
let drag = null
let edgeRaf = 0
let edgeDir = 0
// Браузер синтезирует click после pointerup — после drag гасим выбор проекта.
let suppressClick = false

// Клик выбирает активный проект, но не сразу после drag (см. suppressClick).
function onSelect(project) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  projects.select(project.id)
}

function onRowPointerDown(project, event) {
  // Drag — только левой кнопкой и только незаблокированной строки; кнопки строки
  // (замок/переименование/удаление) останавливают pointerdown на себе.
  if (event.button !== 0 || project.locked === true || drag) return
  drag = {
    id: project.id,
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
  const to = projects.projects.findIndex((p) => p.id === id)
  if (to !== -1) projects.reorder(id, to)
}

// Завершение drag без сохранения (Escape/pointercancel): порядок во время жеста
// менялся только локально — откат перечитыванием индекса.
async function cancelDrag() {
  if (!drag) return
  const wasActive = drag.active
  endDrag()
  if (wasActive) await projects.load()
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
  const els = listEl.value ? [...listEl.value.querySelectorAll('.project-item')] : []
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
  if (to !== from) projects.moveLocal(drag.id, to)
}

// Автоскролл списка у краёв: шаг за кадр, позиция пересчитывается каждый кадр.
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

async function rename(project) {
  const name = await dialog.value.prompt({
    title: 'Переименовать проект',
    label: 'Имя проекта',
    value: project.name,
    confirmText: 'Переименовать'
  })
  if (name === null || name === project.name) return
  await projects.rename(project.id, name)
}

async function toggleLock(project) {
  const locking = project.locked !== true
  const confirmed = await dialog.value.confirm({
    title: locking ? 'Заблокировать проект' : 'Разблокировать проект',
    message: locking
      ? `Заблокировать проект «${project.name}»? Его нельзя будет удалить до разблокировки.`
      : `Разблокировать проект «${project.name}»?`,
    confirmText: locking ? 'Заблокировать' : 'Разблокировать'
  })
  if (!confirmed) return
  await projects.setLocked(project.id, locking)
}

async function remove(project) {
  if (project.locked === true) return
  const confirmed = await dialog.value.confirm({
    title: 'Удалить проект',
    message: `Удалить проект «${project.name}»? Его запросы и окружения будут потеряны.`,
    confirmText: 'Удалить'
  })
  if (confirmed) await projects.remove(project.id)
}
</script>

<template>
  <ul
    ref="listEl"
    class="project-list"
    :class="{ 'is-dragging': draggingId !== null }"
  >
    <li
      v-for="project in projects.projects"
      :key="project.id"
      :data-id="project.id"
      tabindex="0"
      class="project-item"
      role="button"
      :class="{ active: project.id === projects.activeProjectId, locked: project.locked === true, dragging: project.id === draggingId }"
      @click="onSelect(project)"
      @keydown.enter.prevent="onSelect(project)"
      @keydown.space.prevent="onSelect(project)"
      @pointerdown="onRowPointerDown(project, $event)"
    >
      <span class="project-name" :title="project.name">
        <span v-if="project.locked === true" class="project-lock-badge" title="Проект заблокирован">
          <Icon name="lock" :size="12" />
        </span>
        <span v-if="project.pinned === true" class="project-lock-badge" title="Проект закреплён">
          <Icon name="pin" :size="12" />
        </span>
        {{ project.name }}
      </span>
      <span class="project-actions">
        <button
          class="btn-icon"
          :title="project.locked === true ? 'Разблокировать проект' : 'Заблокировать проект'"
          :aria-label="project.locked === true ? 'Разблокировать проект' : 'Заблокировать проект'"
          @pointerdown.stop
          @click.stop="toggleLock(project)"
        >
          <Icon :name="project.locked === true ? 'lock' : 'unlock'" :size="13" />
        </button>
        <button
          class="btn-icon"
          :title="project.pinned === true ? 'Открепить проект' : 'Закрепить проект'"
          :aria-label="project.pinned === true ? 'Открепить проект' : 'Закрепить проект'"
          @pointerdown.stop
          @click.stop="projects.setPinned(project.id, project.pinned !== true)"
        >
          <Icon name="pin" :size="13" />
        </button>
        <button
          class="btn-icon"
          title="Переименовать"
          aria-label="Переименовать проект"
          @pointerdown.stop
          @click.stop="rename(project)"
        >
          <Icon name="edit" :size="13" />
        </button>
        <button
          class="btn-icon btn-icon-danger"
          :disabled="project.locked === true"
          :title="project.locked === true ? 'Проект заблокирован' : 'Удалить'"
          aria-label="Удалить проект"
          @pointerdown.stop
          @click.stop="remove(project)"
        >
          <Icon name="close" :size="13" />
        </button>
      </span>
    </li>
  </ul>
</template>
