<script setup>
// Панель-шторка экспорта: код выбранного языка (cURL или сниппет) в код-блоке,
// селектор языка в шапке, «Копировать» в системный буфер.
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  text: { type: String, default: '' },
  // Текущий язык (значение из langs). Смена эмитится update:lang — текст строит родитель.
  lang: { type: String, default: 'curl' },
  langs: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'update:lang'])

const copied = ref(false)

function copy() {
  window.api.clipboard.write(props.text).then(() => {
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  })
}

function onKeydown(event) {
  if (event.key === 'Escape' && props.visible) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <aside v-if="visible" class="curl-panel">
    <div class="curl-panel-header">
      <select
        class="pane-select curl-panel-lang"
        :value="lang"
        aria-label="Язык кода"
        @change="emit('update:lang', $event.target.value)"
      >
        <option v-for="item in langs" :key="item.value" :value="item.value">{{ item.label }}</option>
      </select>
      <span class="toolbar-right">
        <button class="btn" @click="copy">{{ copied ? 'Скопировано' : 'Копировать' }}</button>
        <button class="btn-icon" title="Закрыть" aria-label="Закрыть панель" @click="emit('close')">
          ×
        </button>
      </span>
    </div>
    <pre class="curl-code">{{ text }}</pre>
  </aside>
</template>
