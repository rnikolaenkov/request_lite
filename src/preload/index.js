// Мост renderer ↔ main: единственная точка доступа к IPC — window.api.*.
// Renderer не имеет доступа к Node (nodeIntegration: false, contextIsolation: true).
import { contextBridge, ipcRenderer } from 'electron'

// Один блокирующий запрос на старте: сохранённая тема применяется до первого кадра
// (без вспышки тёмной темы при выбранной светлой).
const initialSettings = ipcRenderer.sendSync('settings:getInitial')

const api = {
  initialSettings,
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (name) => ipcRenderer.invoke('projects:create', name),
    rename: (id, name) => ipcRenderer.invoke('projects:rename', { id, name }),
    delete: (id) => ipcRenderer.invoke('projects:delete', id),
    setLocked: (id, locked) => ipcRenderer.invoke('projects:setLocked', { id, locked }),
    setPinned: (id, pinned) => ipcRenderer.invoke('projects:setPinned', { id, pinned }),
    reorder: (id, toIndex) => ipcRenderer.invoke('projects:reorder', { id, toIndex }),
    importCollection: (payload) => ipcRenderer.invoke('projects:importCollection', payload)
  },
  postman: {
    pickAndRead: () => ipcRenderer.invoke('postman:pickAndRead')
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  requests: {
    list: (projectId) => ipcRenderer.invoke('requests:list', projectId),
    save: (projectId, request) => ipcRenderer.invoke('requests:save', { projectId, request }),
    delete: (projectId, requestId) => ipcRenderer.invoke('requests:delete', { projectId, requestId }),
    setLocked: (projectId, requestId, locked) =>
      ipcRenderer.invoke('requests:setLocked', { projectId, requestId, locked }),
    setPinned: (projectId, requestId, pinned) =>
      ipcRenderer.invoke('requests:setPinned', { projectId, requestId, pinned }),
    reorder: (projectId, requestId, toIndex) =>
      ipcRenderer.invoke('requests:reorder', { projectId, requestId, toIndex })
  },
  environments: {
    list: (projectId) => ipcRenderer.invoke('environments:list', projectId),
    save: (projectId, environment) => ipcRenderer.invoke('environments:save', { projectId, environment }),
    delete: (projectId, environmentId) =>
      ipcRenderer.invoke('environments:delete', { projectId, environmentId }),
    setActive: (projectId, environmentId) =>
      ipcRenderer.invoke('environments:setActive', { projectId, environmentId })
  },
  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
    // {enabled?, port?, regenerateToken?} → свежий статус после применения
    setConfig: (patch) => ipcRenderer.invoke('mcp:setConfig', patch)
  },
  mocks: {
    listProjects: () => ipcRenderer.invoke('mocks:listProjects'),
    createProject: (name) => ipcRenderer.invoke('mocks:createProject', name),
    renameProject: (id, name) => ipcRenderer.invoke('mocks:renameProject', { id, name }),
    deleteProject: (id) => ipcRenderer.invoke('mocks:deleteProject', id),
    getProject: (id) => ipcRenderer.invoke('mocks:getProject', id),
    // {id, config} → сохранённая конфигурация; запущенный сервер применяет её на лету,
    // если слушатель работает на этом же мок-проекте.
    saveProject: (id, config) => ipcRenderer.invoke('mocks:saveProject', { id, config }),
    getStatus: () => ipcRenderer.invoke('mocks:getStatus'),
    // Старт не бросает: занятый порт/невалидный порт — статус {state:'error', message}
    start: (projectId, port) => ipcRenderer.invoke('mocks:start', { projectId, port }),
    stop: () => ipcRenderer.invoke('mocks:stop'),
    getLog: () => ipcRenderer.invoke('mocks:getLog'),
    clearLog: () => ipcRenderer.invoke('mocks:clearLog')
  },
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  history: {
    // История ответов сохранённого запроса: записи от новых к старым ({createdAt, response}).
    list: (projectId, requestId) => ipcRenderer.invoke('history:list', { projectId, requestId })
  },
  http: {
    // requestId генерирует renderer и знает его ДО отправки — иначе Cancel во время
    // выполнения не сможет указать, какой запрос прервать. history — цель записи
    // истории {projectId, requestId} или null (несохранённая вкладка).
    send: (requestId, request, history) =>
      ipcRenderer
        .invoke('http:request', { requestId, request, history })
        .then((result) => ({ requestId, ...result })),
    cancel: (requestId) => ipcRenderer.invoke('http:cancel', requestId)
  },
  proxy: {
    start: (port) => ipcRenderer.invoke('proxy:start', port),
    stop: () => ipcRenderer.invoke('proxy:stop'),
    status: () => ipcRenderer.invoke('proxy:status'),
    getLog: () => ipcRenderer.invoke('proxy:getLog'),
    clearLog: () => ipcRenderer.invoke('proxy:clearLog')
  },
  loadtest: {
    run: (payload) => ipcRenderer.invoke('loadtest:run', payload),
    cancel: () => ipcRenderer.invoke('loadtest:cancel')
  },
  onMenu: (callback) => {
    ipcRenderer.on('menu:new-project', () => callback('new-project'))
    ipcRenderer.on('menu:save-request', () => callback('save-request'))
    ipcRenderer.on('menu:import-curl', () => callback('import-curl'))
    ipcRenderer.on('menu:import-postman', () => callback('import-postman'))
    ipcRenderer.on('menu:settings', () => callback('settings'))
    ipcRenderer.on('menu:about', () => callback('about'))
  },
  // Push-журнал мок-сервера: каждая принятая запросом запись приходит сама
  onMockLog: (callback) => {
    ipcRenderer.on('mocks:log', (_event, entry) => callback(entry))
  }
}

contextBridge.exposeInMainWorld('api', api)
