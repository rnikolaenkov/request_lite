<script setup>
import { inject } from 'vue'
import Icon from './Icon.vue'
import { useMocksStore } from '../stores/mocks.js'

// Список мок-проектов в сайдбаре (вид «Мок-сервер»): выбор, переименование, удаление.
// Без drag/pin/lock — осознанное ограничение v1 (см. design.md D4).
defineEmits(['new-mock-project'])
const mocks = useMocksStore()
const dialog = inject('dialog')

async function rename(project) {
  const name = await dialog.value.prompt({
    title: 'Переименовать мок-проект',
    label: 'Имя мок-проекта',
    value: project.name,
    confirmText: 'Переименовать'
  })
  if (name === null || name === project.name) return
  await mocks.rename(project.id, name)
}

async function remove(project) {
  const confirmed = await dialog.value.confirm({
    title: 'Удалить мок-проект',
    message: `Удалить мок-проект «${project.name}»? Его маршруты и журнал настроек будут потеряны.`,
    confirmText: 'Удалить'
  })
  if (confirmed) await mocks.remove(project.id)
}
</script>

<template>
  <ul class="project-list">
    <li
      v-for="project in mocks.projects"
      :key="project.id"
      class="project-item"
      role="button"
      :class="{ active: project.id === mocks.activeProjectId }"
      tabindex="0"
      @click="mocks.select(project.id)"
      @keydown.enter.prevent="mocks.select(project.id)"
      @keydown.space.prevent="mocks.select(project.id)"
    >
      <span class="project-name" :title="project.name">{{ project.name }}</span>
      <span class="project-actions">
        <button
          class="btn-icon"
          title="Переименовать"
          aria-label="Переименовать мок-проект"
          @click.stop="rename(project)"
        >
          <Icon name="edit" :size="13" />
        </button>
        <button
          class="btn-icon btn-icon-danger"
          title="Удалить"
          aria-label="Удалить мок-проект"
          @click.stop="remove(project)"
        >
          <Icon name="close" :size="13" />
        </button>
      </span>
    </li>
  </ul>
</template>
