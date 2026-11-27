// JSON-хранилище приложения.
// Не зависит от Electron: корневой путь передаётся через initStorage —
// так smoke-тесты (scripts/smoke.mjs) гоняют те же функции на временной папке.
import { join } from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

let rootPath = null
let settingsCache = null

const DEFAULT_SETTINGS = { theme: 'dark', mcp: { enabled: false, port: 45460, token: null } }

export function initStorage(root) {
  rootPath = root
}

export function getStorageRoot() {
  if (!rootPath) throw new Error('Хранилище не инициализировано: сначала вызовите initStorage()')
  return rootPath
}

// Инициализация каталогов и кэша настроек. Вызывается один раз при старте main-процесса.
export async function bootstrap() {
  await ensureDirs()
  settingsCache = await readSettingsFromDisk()
}

async function ensureDirs() {
  await mkdir(join(getStorageRoot(), 'projects'), { recursive: true })
  await mkdir(join(getStorageRoot(), 'mock-projects'), { recursive: true })
}

// Мутации одного пути сериализуются очередью (по образцу enqueueMutation из mcp.js):
// две записи, начатые одновременно, не смешиваются и не теряют обновлений друг друга.
// Ключ — абсолютный путь; очередь удаляется, когда drained, чтобы map не рос бесконечно.
const writeQueues = new Map()

function enqueueWrite(filePath, fn) {
  const tail = writeQueues.get(filePath) ?? Promise.resolve()
  const run = tail.then(fn)
  const next = run.then(
    () => {
      if (writeQueues.get(filePath) === next) writeQueues.delete(filePath)
    },
    () => {
      if (writeQueues.get(filePath) === next) writeQueues.delete(filePath)
    }
  )
  writeQueues.set(filePath, next)
  return run
}

// Сырая запись: уникальный tmp на вызов — параллельные вызовы не пишут в один
// временный файл. Ретрай на EPERM: на Windows rename может упасть, если файл
// на мгновение держит антивирус или индексатор — до 3 раз с паузой.
async function writeJsonFile(filePath, data) {
  const tmp = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(tmp, filePath)
        return
      } catch (err) {
        if (err.code !== 'EPERM' || attempt >= 3) throw err
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  } catch (err) {
    await rm(tmp, { force: true }) // осиротевший tmp не копим: rename мог не дойти
    throw err
  }
}

// Полная замена файла без чтения-изменения-записи (свежий файл, конфиг).
async function writeJsonAtomic(filePath, data) {
  return enqueueWrite(filePath, () => writeJsonFile(filePath, data))
}

// Чтение-изменение-запись одним очередённым шагом: параллельные мутации одного
// файла читают результат предыдущей, а не общее устаревшее состояние. Внутри
// mutator файл писать нельзя — запись выполняет сам mutateJsonFile (иначе deadlock).
async function mutateJsonFile(filePath, fallback, mutator) {
  return enqueueWrite(filePath, async () => {
    const current = await readJson(filePath, fallback)
    const { next, result } = await mutator(current)
    await writeJsonFile(filePath, next)
    return result
  })
}

// Чтение JSON с защитой данных: невалидный файл НЕ перезаписывается —
// наверх уходит ошибка CORRUPT_STORAGE, чтобы сбой записи не привёл к тихой потере данных.
async function readJson(filePath, fallback) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error(
      `Файл хранилища повреждён: ${filePath}. Он не был перезаписан — исправьте или переместите файл вручную.`
    )
    error.code = 'CORRUPT_STORAGE'
    throw error
  }
}

// Идентификаторы приходят и из MCP (внешний вход для ИИ-агентов) — без валидации
// путь мог выйти за пределы хранилища (path traversal). UI генерирует UUID,
// формат `^[A-Za-z0-9-]+$` его покрывает.
const ID_RE = /^[A-Za-z0-9-]+$/
const assertId = (id, what) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    const error = new Error(`Недопустимый идентификатор ${what}: ${JSON.stringify(id)}`)
    error.code = 'INVALID_ID'
    throw error
  }
  return id
}

const indexPath = () => join(getStorageRoot(), 'projects.json')
const projectPath = (id) => join(getStorageRoot(), 'projects', `${assertId(id, 'проекта')}.json`)
const historyDir = (projectId) => join(getStorageRoot(), 'history', assertId(projectId, 'проекта'))
const historyPath = (projectId, requestId) =>
  join(historyDir(projectId), `${assertId(requestId, 'запроса')}.json`)
const mockIndexPath = () => join(getStorageRoot(), 'mock-projects.json')
const mockProjectPath = (id) => join(getStorageRoot(), 'mock-projects', `${assertId(id, 'мок-проекта')}.json`)
const settingsPath = () => join(getStorageRoot(), 'settings.json')

// --- Проекты ---

export async function listProjects() {
  await ensureDirs()
  return readJson(indexPath(), [])
}

export async function createProject(name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('Имя проекта не может быть пустым')
  await ensureDirs()
  const now = new Date().toISOString()
  const project = { id: randomUUID(), name: trimmed, createdAt: now, updatedAt: now, locked: false, pinned: false }
  await mutateJsonFile(indexPath(), [], (projects) => ({ next: [...projects, project], result: project }))
  await writeJsonAtomic(projectPath(project.id), {
    requests: [],
    environments: [],
    activeEnvId: null
  })
  return project
}

export async function renameProject(id, name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('Имя проекта не может быть пустым')
  return mutateJsonFile(indexPath(), [], (projects) => {
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error(`Проект не найден: ${id}`)
    project.name = trimmed
    project.updatedAt = new Date().toISOString()
    return { next: projects, result: project }
  })
}

export async function deleteProject(id) {
  // Guard заблокированного проекта — внутри очередённой мутации, до записи индекса.
  await mutateJsonFile(indexPath(), [], (projects) => {
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error(`Проект не найден: ${id}`)
    if (project.locked === true) throw new Error('Проект заблокирован')
    return { next: projects.filter((p) => p.id !== id), result: true }
  })
  await rm(projectPath(id), { force: true })
  await rm(historyDir(id), { recursive: true, force: true })
  return true
}

// Блокировка проекта (защита от удаления). Флаг живёт в индексе.
export async function setProjectLocked(id, locked) {
  if (typeof locked !== 'boolean') throw new Error('locked должен быть boolean')
  return mutateJsonFile(indexPath(), [], (projects) => {
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error(`Проект не найден: ${id}`)
    project.locked = locked
    project.updatedAt = new Date().toISOString()
    return { next: projects, result: project }
  })
}

// Перемещение проекта на новую позицию в индексе. Перемещение меняет только
// порядок массива — записи (включая флаги locked) не трогаются, поэтому замок
// проекта (защита от удаления, см. спеку) не мешает; источник отсекается на уровне UI.
// Граница зоны закреплённых жёсткая: целевая позиция зажимается в зону источника
// (закреплённый — в [0..N-1], обычный — в [N..], N = число закреплённых).
export async function reorderProjects(id, toIndex) {
  if (!id || typeof id !== 'string') {
    throw new Error('У перемещаемого проекта должен быть id')
  }
  if (!Number.isInteger(toIndex) || toIndex < 0) {
    throw new Error('toIndex должен быть целым числом >= 0')
  }
  return mutateJsonFile(indexPath(), [], (projects) => {
    const from = projects.findIndex((p) => p.id === id)
    if (from === -1) throw new Error(`Проект не найден: ${id}`)
    const pinnedCount = projects.filter((p) => p.pinned === true).length
    const lower = projects[from].pinned === true ? 0 : pinnedCount
    const upper = projects[from].pinned === true ? pinnedCount - 1 : projects.length - 1
    const to = Math.max(lower, Math.min(toIndex, upper))
    if (to === from) return { next: projects, result: projects }
    const [moved] = projects.splice(from, 1)
    projects.splice(to, 0, moved)
    return { next: projects, result: projects }
  })
}

// Закрепление проекта (верхняя зона списка). Флаг — метаданные записи индекса.
// Стабильная нормализация: закреплённые — префикс массива, новый закреплённый
// встаёт после последнего закреплённого, откреплённый — перед первым обычным.
function normalizeProjectZone(projects) {
  const pinned = projects.filter((p) => p.pinned === true)
  const rest = projects.filter((p) => p.pinned !== true)
  return [...pinned, ...rest]
}

export async function setProjectPinned(id, pinned) {
  if (typeof pinned !== 'boolean') throw new Error('pinned должен быть boolean')
  return mutateJsonFile(indexPath(), [], (projects) => {
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error(`Проект не найден: ${id}`)
    project.pinned = pinned
    const next = normalizeProjectZone(projects)
    return { next, result: next }
  })
}

// Bulk-импорт коллекции Postman: проект в индексе + файл проекта
// (requests[] + окружение с именем коллекции + activeEnvId) атомарными записями.
export async function importCollection({ name, requests, variables }) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('Имя проекта не может быть пустым')
  await ensureDirs()
  const now = new Date().toISOString()
  const project = { id: randomUUID(), name: trimmed, createdAt: now, updatedAt: now, locked: false, pinned: false }
  const environment = {
    id: randomUUID(),
    name: trimmed,
    variables: (variables ?? []).map((v) => ({
      id: String(v.id ?? randomUUID()),
      key: String(v.key ?? ''),
      value: String(v.value ?? ''),
      enabled: v.enabled !== false
    }))
  }
  const records = (requests ?? []).map((r) => ({
    id: String(r.id ?? randomUUID()),
    name: String(r.name ?? '').trim() || 'Imported Request',
    method: r.method ?? 'GET',
    url: r.url ?? '',
    params: r.params ?? [],
    headers: r.headers ?? [],
    body: r.body ?? { type: 'none' },
    auth: r.auth ?? { type: 'none' },
    sslVerify: r.sslVerify !== false,
    locked: false,
    pinned: false
  }))
  await mutateJsonFile(indexPath(), [], (projects) => ({ next: [...projects, project], result: project }))
  await writeJsonAtomic(projectPath(project.id), {
    requests: records,
    environments: [environment],
    activeEnvId: environment.id
  })
  return project
}

export async function getProject(id) {
  return readJson(projectPath(id), null)
}

// --- Запросы проекта ---

async function requireProject(projectId) {
  const project = await getProject(projectId)
  if (!project) throw new Error(`Проект не найден: ${projectId}`)
  return project
}

export async function listRequests(projectId) {
  const project = await requireProject(projectId)
  return project.requests ?? []
}

// Upsert по id: замена существующей записи на её позиции или добавление в конец списка.
// Обновление СУЩЕСТВУЮЩЕГО заблокированного запроса отклоняется (см. setRequestLocked);
// создание нового запроса (id не из списка) не ограничивается.
export async function saveRequest(projectId, request) {
  const name = String(request?.name ?? '').trim()
  if (!name) throw new Error('Имя запроса не может быть пустым')
  if (!request.id) throw new Error('У сохраняемого запроса должен быть id')
  const stored = {
    id: String(request.id),
    name,
    method: request.method ?? 'GET',
    url: request.url ?? '',
    params: request.params ?? [],
    headers: request.headers ?? [],
    body: request.body ?? { type: 'none' },
    auth: request.auth ?? { type: 'none' },
    sslVerify: request.sslVerify !== false
  }
  return mutateJsonFile(projectPath(projectId), null, (project) => {
    if (!project) throw new Error(`Проект не найден: ${projectId}`)
    const requests = project.requests ?? []
    const index = requests.findIndex((r) => r.id === stored.id)
    if (index === -1) {
      requests.push({ ...stored, locked: false, pinned: false })
    } else {
      // Guard до мутаций: заблокированный запрос нельзя обновить даже минуя UI.
      if (requests[index].locked === true) throw new Error('Запрос заблокирован')
      // Флаги блокировки и закрепления — метаданные записи: не сбрасываются
      // при сохранении содержимого.
      requests[index] = {
        ...stored,
        locked: requests[index].locked === true,
        pinned: requests[index].pinned === true
      }
    }
    return { next: { ...project, requests }, result: requests }
  })
}

// Удаление заблокированного запроса отклоняется (см. setRequestLocked).
export async function deleteRequest(projectId, requestId) {
  const next = await mutateJsonFile(projectPath(projectId), null, (project) => {
    if (!project) throw new Error(`Проект не найден: ${projectId}`)
    const requests = project.requests ?? []
    const existing = requests.find((r) => r.id === requestId)
    if (!existing) throw new Error(`Запрос не найден: ${requestId}`)
    if (existing.locked === true) throw new Error('Запрос заблокирован')
    const remaining = requests.filter((r) => r.id !== requestId)
    return { next: { ...project, requests: remaining }, result: remaining }
  })
  await rm(historyPath(projectId, requestId), { force: true })
  return next
}

// Блокировка запроса (защита от обновления и удаления). Флаг — метаданные записи.
export async function setRequestLocked(projectId, requestId, locked) {
  if (typeof locked !== 'boolean') throw new Error('locked должен быть boolean')
  return mutateJsonFile(projectPath(projectId), null, (project) => {
    if (!project) throw new Error(`Проект не найден: ${projectId}`)
    const requests = project.requests ?? []
    const existing = requests.find((r) => r.id === requestId)
    if (!existing) throw new Error(`Запрос не найден: ${requestId}`)
    existing.locked = locked
    return { next: { ...project, requests }, result: requests }
  })
}

// Перемещение запроса на новую позицию в списке проекта. Перемещение меняет только
// порядок массива — содержимое и флаги locked записей не трогаются, поэтому замки
// запросов и блокировка проекта (защита содержимого и удаления, см. спеки) не мешают.
// Граница зоны закреплённых жёсткая: целевая позиция зажимается в зону источника
// (закреплённый — в [0..N-1], обычный — в [N..], N = число закреплённых).
export async function reorderRequests(projectId, requestId, toIndex) {
  if (!requestId || typeof requestId !== 'string') {
    throw new Error('У перемещаемого запроса должен быть id')
  }
  if (!Number.isInteger(toIndex) || toIndex < 0) {
    throw new Error('toIndex должен быть целым числом >= 0')
  }
  return mutateJsonFile(projectPath(projectId), null, (project) => {
    if (!project) throw new Error(`Проект не найден: ${projectId}`)
    const requests = project.requests ?? []
    const from = requests.findIndex((r) => r.id === requestId)
    if (from === -1) throw new Error(`Запрос не найден: ${requestId}`)
    const pinnedCount = requests.filter((r) => r.pinned === true).length
    const lower = requests[from].pinned === true ? 0 : pinnedCount
    const upper = requests[from].pinned === true ? pinnedCount - 1 : requests.length - 1
    const to = Math.max(lower, Math.min(toIndex, upper))
    if (to === from) return { next: project, result: requests }
    const [moved] = requests.splice(from, 1)
    requests.splice(to, 0, moved)
    return { next: { ...project, requests }, result: requests }
  })
}

// Закрепление запроса (верхняя зона списка). Флаг — метаданные записи.
// Стабильная нормализация: закреплённые — префикс массива, новый закреплённый
// встаёт после последнего закреплённого, откреплённый — перед первым обычным.
function normalizeRequestZone(requests) {
  const pinned = requests.filter((r) => r.pinned === true)
  const rest = requests.filter((r) => r.pinned !== true)
  return [...pinned, ...rest]
}

export async function setRequestPinned(projectId, requestId, pinned) {
  if (typeof pinned !== 'boolean') throw new Error('pinned должен быть boolean')
  return mutateJsonFile(projectPath(projectId), null, (project) => {
    if (!project) throw new Error(`Проект не найден: ${projectId}`)
    const requests = project.requests ?? []
    const existing = requests.find((r) => r.id === requestId)
    if (!existing) throw new Error(`Запрос не найден: ${requestId}`)
    existing.pinned = pinned
    const next = { ...project, requests: normalizeRequestZone(requests) }
    return { next, result: next.requests }
  })
}

// --- История ответов запроса ---

// Последние HTTP-ответы каждого запроса: отдельный файл на пару (projectId,
// requestId) — history/<projectId>/<requestId>.json. Не в файле проекта: каждая
// отправка не должна переписывать весь проект. Лимиты — константы кода.
const HISTORY_LIMIT = 10
const HISTORY_BODY_LIMIT = 100 * 1024

// Текстовые content-type: тело сохраняется; остальное — бинарное, храним только метаданные.
// Отсутствие content-type считаем текстом — ровно так ответ показывает ResponseView.
const TEXT_CONTENT_RE = /(^text\/)|json|xml|javascript|x-www-form-urlencoded/i

function isTextContent(headers) {
  const contentType = (headers ?? []).find((h) => String(h?.key ?? '').toLowerCase() === 'content-type')
  const value = String(contentType?.value ?? '')
  return value === '' || TEXT_CONTENT_RE.test(value)
}

// Дописывает ответ в историю запроса. Вызывается после успешной отправки (IPC и MCP);
// повреждённый файл истории не перезаписывается — запись тихо пропускается, ответ
// вызывающая сторона уже показала пользователю. Вставка в начало, лимит глубины — срез.
export async function appendResponseHistory(projectId, requestId, response) {
  await requireProject(projectId)
  await mkdir(historyDir(projectId), { recursive: true }) // каталог проекта появляется с первой записью
  const entry = { createdAt: new Date().toISOString(), response: { ...response } }
  if (typeof entry.response.body === 'string' && entry.response.body.length > HISTORY_BODY_LIMIT) {
    entry.response.body = entry.response.body.slice(0, HISTORY_BODY_LIMIT)
    entry.response.bodyCut = true
  }
  if (!isTextContent(entry.response.headers)) {
    entry.response.binary = true
    entry.response.body = null
  }
  return mutateJsonFile(historyPath(projectId, requestId), { entries: [] }, (current) => {
    const entries = [entry, ...(current.entries ?? [])].slice(0, HISTORY_LIMIT)
    return { next: { entries }, result: entry }
  }).catch((err) => {
    if (err.code === 'CORRUPT_STORAGE') return null
    throw err
  })
}

// История запроса: записи от новых к старым; пустая история — [].
// Повреждённый файл пробрасывает CORRUPT_STORAGE наверх (UI показывает «История недоступна»).
export async function listResponseHistory(projectId, requestId) {
  await requireProject(projectId)
  const data = await readJson(historyPath(projectId, requestId), { entries: [] })
  return data.entries ?? []
}

// --- Окружения проекта ---

export async function listEnvironments(projectId) {
  const project = await requireProject(projectId)
  return { environments: project.environments ?? [], activeEnvId: project.activeEnvId ?? null }
}

// Upsert по id: замена существующей записи на её позиции или добавление в конец списка.
export async function saveEnvironment(projectId, environment) {
  const name = String(environment?.name ?? '').trim()
  if (!name) throw new Error('Имя окружения не может быть пустым')
  if (!environment.id) throw new Error('У сохраняемого окружения должен быть id')
  const stored = {
    id: String(environment.id),
    name,
    variables: environment.variables ?? []
  }
  return mutateJsonFile(projectPath(projectId), null, (project) => {
    if (!project) throw new Error(`Проект не найден: ${projectId}`)
    const environments = project.environments ?? []
    const index = environments.findIndex((e) => e.id === stored.id)
    if (index === -1) environments.push(stored)
    else environments[index] = stored
    return { next: { ...project, environments }, result: environments }
  })
}

// Удаление окружения; если удалили активное — activeEnvId обнуляется.
export async function deleteEnvironment(projectId, environmentId) {
  return mutateJsonFile(projectPath(projectId), null, (project) => {
    if (!project) throw new Error(`Проект не найден: ${projectId}`)
    const environments = project.environments ?? []
    const next = environments.filter((e) => e.id !== environmentId)
    if (next.length === environments.length) throw new Error(`Окружение не найдено: ${environmentId}`)
    const activeEnvId = project.activeEnvId === environmentId ? null : project.activeEnvId ?? null
    return {
      next: { ...project, environments: next, activeEnvId },
      result: { environments: next, activeEnvId }
    }
  })
}

export async function setActiveEnvironment(projectId, environmentId) {
  return mutateJsonFile(projectPath(projectId), null, (project) => {
    if (!project) throw new Error(`Проект не найден: ${projectId}`)
    const environments = project.environments ?? []
    if (environmentId !== null && !environments.some((e) => e.id === environmentId)) {
      throw new Error(`Окружение не найдено: ${environmentId}`)
    }
    return {
      next: { ...project, activeEnvId: environmentId },
      result: { environments, activeEnvId: environmentId }
    }
  })
}

// --- Мок-проекты ---

// Мок-проект: индекс-запись {id, name, createdAt, updatedAt} в mock-projects.json
// (порядок массива = порядок в списке) и файл mock-projects/<id>.json
// {routes, defaultResponse}. В отличие от проектов запросов — без locked/pinned
// и без перетаскивания (осознанное ограничение v1, см. design.md D4).

// Нормализация маршрута: строгие типы и валидация до записи на диск.
// Матчинг сервера — первый совпавший маршрут в порядке массива, поэтому
// дубликаты method+path не валидируются на уникальность.
function normalizeMockRoute(route) {
  const path = String(route?.path ?? '').trim()
  if (!path) throw new Error('Путь маршрута не может быть пустым')
  const method = route?.method == null || route.method === '' ? null : String(route.method).trim().toUpperCase()
  const status = Number.isInteger(route?.status) ? route.status : 200
  if (status < 100 || status > 599) throw new Error('Статус маршрута должен быть целым числом 100–599')
  const delayMs = route?.delayMs == null || route.delayMs === '' ? 0 : route.delayMs
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error('Задержка маршрута должна быть целым неотрицательным числом миллисекунд')
  }
  return {
    id: String(route?.id ?? randomUUID()),
    method,
    path,
    status,
    headers: (route?.headers ?? []).map((h) => ({
      id: String(h?.id ?? randomUUID()),
      key: String(h?.key ?? ''),
      value: String(h?.value ?? ''),
      enabled: h?.enabled !== false
    })),
    body: route?.body == null || route.body === '' ? null : String(route.body),
    delayMs
  }
}

function normalizeMockConfig(config) {
  const routes = (config?.routes ?? []).map(normalizeMockRoute)
  let defaultResponse = null
  if (config?.defaultResponse) {
    const status = Number.isInteger(config.defaultResponse.status) ? config.defaultResponse.status : 404
    if (status < 100 || status > 599) throw new Error('Статус ответа по умолчанию должен быть целым числом 100–599')
    defaultResponse = {
      status,
      body: config.defaultResponse.body == null || config.defaultResponse.body === '' ? null : String(config.defaultResponse.body)
    }
  }
  return { routes, defaultResponse }
}

export async function listMockProjects() {
  await ensureDirs()
  return readJson(mockIndexPath(), [])
}

export async function createMockProject(name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('Имя мок-проекта не может быть пустым')
  await ensureDirs()
  const now = new Date().toISOString()
  const project = { id: randomUUID(), name: trimmed, createdAt: now, updatedAt: now }
  await mutateJsonFile(mockIndexPath(), [], (projects) => ({ next: [...projects, project], result: project }))
  await writeJsonAtomic(mockProjectPath(project.id), { routes: [], defaultResponse: null })
  return project
}

export async function renameMockProject(id, name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('Имя мок-проекта не может быть пустым')
  return mutateJsonFile(mockIndexPath(), [], (projects) => {
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error(`Мок-проект не найден: ${id}`)
    project.name = trimmed
    project.updatedAt = new Date().toISOString()
    return { next: projects, result: project }
  })
}

export async function deleteMockProject(id) {
  await mutateJsonFile(mockIndexPath(), [], (projects) => {
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error(`Мок-проект не найден: ${id}`)
    return { next: projects.filter((p) => p.id !== id), result: true }
  })
  await rm(mockProjectPath(id), { force: true })
  return true
}

export async function getMockProject(id) {
  return readJson(mockProjectPath(id), null)
}

// Сохранение конфигурации мок-проекта целиком (маршруты + ответ по умолчанию).
// Валидация и нормализация до записи: невалидный маршрут не попадает на диск.
export async function saveMockProjectConfig(id, config) {
  const project = await getMockProject(id)
  if (!project) throw new Error(`Мок-проект не найден: ${id}`)
  const stored = normalizeMockConfig(config)
  await writeJsonAtomic(mockProjectPath(id), stored)
  return stored
}

// --- Настройки ---

async function readSettingsFromDisk() {
  const stored = await readJson(settingsPath(), {})
  // mcp мерджится глубже: старый settings.json без секции (или с частичной) получает дефолты.
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    mcp: { ...DEFAULT_SETTINGS.mcp, ...(stored.mcp ?? {}) }
  }
}

// Синхронный доступ для preload (sendSync при старте окна, тема до первого кадра).
export function getSettingsSync() {
  if (!settingsCache) return { ...DEFAULT_SETTINGS }
  return { ...settingsCache }
}

export async function getSettings() {
  if (!settingsCache) await bootstrap()
  return getSettingsSync()
}

export async function setSettings(patch) {
  if (!settingsCache) await bootstrap()
  settingsCache = { ...settingsCache, ...patch }
  await writeJsonAtomic(settingsPath(), settingsCache)
  return { ...settingsCache }
}
