<script setup>
import { useProjectsStore } from '../stores/projects.js'
import { useMocksStore } from '../stores/mocks.js'
import { useUiStore } from '../stores/ui.js'
import ProjectList from './ProjectList.vue'
import RequestList from './RequestList.vue'
import MockProjectList from './MockProjectList.vue'

defineEmits(['new-project', 'new-mock-project'])
const projects = useProjectsStore()
const mocks = useMocksStore()
const ui = useUiStore()
</script>

<template>
  <aside class="sidebar">
    <template v-if="ui.view === 'requests'">
      <div class="sidebar-header">
        <span class="sidebar-title">Проекты</span>
        <button class="btn-icon" title="Новый проект" aria-label="Новый проект" @click="$emit('new-project')">
          +
        </button>
      </div>
      <p v-if="projects.error" class="sidebar-error">{{ projects.error }}</p>
      <p v-else-if="projects.loaded && !projects.projects.length" class="sidebar-empty">
        Пока нет проектов.<br />
        Создайте первый:
        <button class="link-btn" @click="$emit('new-project')">+ Новый проект</button>
      </p>
      <ProjectList v-else @new-project="$emit('new-project')" />
      <RequestList v-if="projects.activeProjectId" />
    </template>
    <template v-else>
      <div class="sidebar-header">
        <span class="sidebar-title">Мок-проекты</span>
        <button
          class="btn-icon"
          title="Новый мок-проект"
          aria-label="Новый мок-проект"
          @click="$emit('new-mock-project')"
        >
          +
        </button>
      </div>
      <p v-if="mocks.error" class="sidebar-error">{{ mocks.error }}</p>
      <p v-else-if="mocks.loaded && !mocks.projects.length" class="sidebar-empty">
        Пока нет мок-проектов.<br />
        Создайте первый:
        <button class="link-btn" @click="$emit('new-mock-project')">+ Мок-проект</button>
      </p>
      <MockProjectList v-else @new-mock-project="$emit('new-mock-project')" />
    </template>
  </aside>
</template>
