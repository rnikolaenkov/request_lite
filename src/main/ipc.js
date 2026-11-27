// Регистрация IPC-каналов. Renderer общается с main только через эти ручки
// (см. src/preload/index.js). Префиксы: projects:*, requests:*, environments:*,
// settings:*, http:*, postman:*, data:*, clipboard:*, mcp:*, mocks:*, proxy:*.
// Push-каналы: menu:* (из меню), mocks:log (запись журнала мок-сервера).
import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import * as storage from './storage.js'
import { sendRequest, cancelRequest } from './http.js'
import { getMcpStatus, applyMcpConfig } from './mcp.js'
import { startProxy, stopProxy, getProxyStatus, getProxyLog, clearProxyLog } from './proxy.js'
import { runLoadTest, cancelLoadTest } from './loadtest.js'
import {
  getMockStatus,
  startMockServer,
  stopMockServer,
  applyMockConfig,
  getMockLog,
  clearMockLog,
  setLogListener
} from './mock.js'

// Открывает папку хранилища в системном файловом менеджере (используется и меню).
export function openStorageFolder() {
  return shell.openPath(storage.getStorageRoot())
}

export function registerIpc(getMainWindow = () => null) {
  ipcMain.handle('projects:list', () => storage.listProjects())
  ipcMain.handle('projects:create', (_event, name) => storage.createProject(name))
  ipcMain.handle('projects:rename', (_event, { id, name }) => storage.renameProject(id, name))
  ipcMain.handle('projects:delete', (_event, id) => storage.deleteProject(id))
  ipcMain.handle('projects:setLocked', (_event, { id, locked }) => storage.setProjectLocked(id, locked))
  ipcMain.handle('projects:setPinned', (_event, { id, pinned }) => storage.setProjectPinned(id, pinned))
  ipcMain.handle('projects:reorder', (_event, { id, toIndex }) => storage.reorderProjects(id, toIndex))
  ipcMain.handle('projects:importCollection', (_event, payload) => storage.importCollection(payload))

  // Выбор JSON-файла коллекции Postman + чтение содержимого (нативный диалог в main).
  ipcMain.handle('postman:pickAndRead', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Postman Collection', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true }
    try {
      const content = await readFile(result.filePaths[0], 'utf8')
      return { ok: true, content }
    } catch (err) {
      return { ok: false, error: `Не удалось прочитать файл: ${err.message}` }
    }
  })

  ipcMain.handle('requests:list', (_event, projectId) => storage.listRequests(projectId))
  ipcMain.handle('requests:save', (_event, { projectId, request }) => storage.saveRequest(projectId, request))
  ipcMain.handle('requests:delete', (_event, { projectId, requestId }) =>
    storage.deleteRequest(projectId, requestId)
  )
  ipcMain.handle('requests:setLocked', (_event, { projectId, requestId, locked }) =>
    storage.setRequestLocked(projectId, requestId, locked)
  )
  ipcMain.handle('requests:setPinned', (_event, { projectId, requestId, pinned }) =>
    storage.setRequestPinned(projectId, requestId, pinned)
  )
  ipcMain.handle('requests:reorder', (_event, { projectId, requestId, toIndex }) =>
    storage.reorderRequests(projectId, requestId, toIndex)
  )

  // История ответов сохранённого запроса (read-only для renderer: пишет main после отправки).
  ipcMain.handle('history:list', (_event, { projectId, requestId }) =>
    storage.listResponseHistory(projectId, requestId)
  )

  ipcMain.handle('environments:list', (_event, projectId) => storage.listEnvironments(projectId))
  ipcMain.handle('environments:save', (_event, { projectId, environment }) =>
    storage.saveEnvironment(projectId, environment)
  )
  ipcMain.handle('environments:delete', (_event, { projectId, environmentId }) =>
    storage.deleteEnvironment(projectId, environmentId)
  )
  ipcMain.handle('environments:setActive', (_event, { projectId, environmentId }) =>
    storage.setActiveEnvironment(projectId, environmentId)
  )

  // Копирование в системный буфер (renderer-clipboard требует permission handler — идём через main).
  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  // Версия приложения (единый источник — package.json через app.getVersion).
  ipcMain.handle('app:version', () => app.getVersion())

  // Открытие внешних ссылок: только https — защита от произвольных схем.
  ipcMain.handle('shell:openExternal', (_event, url) => {
    const value = String(url ?? '')
    if (!/^https:\/\//i.test(value)) throw new Error('Разрешены только https-ссылки')
    return shell.openExternal(value)
  })

  ipcMain.handle('settings:get', () => storage.getSettings())
  ipcMain.handle('settings:set', (_event, patch) => storage.setSettings(patch))
  // Блокирующий канал для preload: начальные настройки до первого кадра (тема без вспышки).
  ipcMain.on('settings:getInitial', (event) => {
    event.returnValue = storage.getSettingsSync()
  })

  // MCP-сервер: статус для страницы настроек и применение конфигурации с рестартом слушателя.
  ipcMain.handle('mcp:getStatus', () => getMcpStatus())
  ipcMain.handle('mcp:setConfig', async (_event, patch) => {
    const current = await storage.getSettings()
    const mcp = { ...current.mcp }
    if (typeof patch?.enabled === 'boolean') mcp.enabled = patch.enabled
    if (patch?.port !== undefined) mcp.port = Number(patch.port) // невалидный — упадёт в applyMcpConfig в ошибку статуса
    if (patch?.regenerateToken === true) mcp.token = null // applyMcpConfig сгенерирует новый
    const settings = await storage.setSettings({ mcp })
    return applyMcpConfig(settings)
  })

  ipcMain.handle('data:openFolder', async () => {
    const error = await openStorageFolder()
    // shell.openPath возвращает '' при успехе, иначе текст ошибки
    return error === '' ? { ok: true } : { ok: false, error }
  })

  // HTTP: выполнение строго в main; renderer присылает снимок вкладки + requestId.
  // history — цель истории ответов {projectId, requestId} сохранённого запроса
  // (или null у несохранённой вкладки): после успешной отправки main сам пишет историю.
  ipcMain.handle('http:request', async (_event, { requestId, request, history }) => {
    try {
      const response = await sendRequest(request, requestId)
      if (history) {
        // Сбой записи истории ответ не теряет: он уже получен и уходит в renderer.
        try {
          await storage.appendResponseHistory(history.projectId, history.requestId, response)
        } catch {
          // история не критична для показа ответа
        }
      }
      return { ok: true, response }
    } catch (err) {
      return { ok: false, error: { code: err.code ?? 'NETWORK', message: err.message } }
    }
  })
  ipcMain.handle('http:cancel', (_event, requestId) => {
    cancelRequest(requestId)
    return true
  })

  // Мок-сервер: CRUD мок-проектов (без locked/pinned — осознанное ограничение v1).
  ipcMain.handle('mocks:listProjects', () => storage.listMockProjects())
  ipcMain.handle('mocks:createProject', (_event, name) => storage.createMockProject(name))
  ipcMain.handle('mocks:renameProject', (_event, { id, name }) => storage.renameMockProject(id, name))
  ipcMain.handle('mocks:deleteProject', (_event, id) => storage.deleteMockProject(id))
  ipcMain.handle('mocks:getProject', (_event, id) => storage.getMockProject(id))
  // Сохранение конфигурации: если сервер запущен на этом же мок-проекте —
  // конфиг применяется к слушателю на лету, без рестарта.
  ipcMain.handle('mocks:saveProject', async (_event, { id, config }) => {
    const stored = await storage.saveMockProjectConfig(id, config)
    const status = getMockStatus()
    if (status.state === 'running' && status.projectId === id) await applyMockConfig(stored)
    return stored
  })

  // Мок-сервер: жизненный цикл и журнал.
  ipcMain.handle('mocks:getStatus', () => getMockStatus())
  // Старт не бросает исключение наверх: неизвестный проект/невалидный порт/занятый порт
  // приходят как статус 'error' — их решает UI (паттерн mcp:setConfig).
  ipcMain.handle('mocks:start', async (_event, { projectId, port }) => {
    try {
      return await startMockServer({ projectId, port })
    } catch (err) {
      return { state: 'error', message: String(err.message ?? err) }
    }
  })
  ipcMain.handle('mocks:stop', () => stopMockServer())
  ipcMain.handle('mocks:getLog', () => getMockLog())
  ipcMain.handle('mocks:clearLog', () => clearMockLog())

  // Локальный HTTP-прокси (перехватчик): старт/стоп слушателя и pull-журнал перехваченных запросов.
  ipcMain.handle('proxy:start', (_event, port) => startProxy(port))
  ipcMain.handle('proxy:stop', () => stopProxy())
  ipcMain.handle('proxy:status', () => getProxyStatus())
  ipcMain.handle('proxy:getLog', () => getProxyLog())
  ipcMain.handle('proxy:clearLog', () => clearProxyLog())

  // Нагрузочный прогон запроса: статистика латентности/RPS из main-процесса.
  ipcMain.handle('loadtest:run', (_event, payload) => runLoadTest(payload))
  ipcMain.handle('loadtest:cancel', () => cancelLoadTest())

  // Живой журнал: каждая принятая запросом запись летит в открытое окно (push mocks:log).
  setLogListener((entry) => {
    getMainWindow()?.webContents?.send('mocks:log', entry)
  })
}
