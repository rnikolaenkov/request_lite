// Смоук-тесты: чистый Node, без Electron — хранилище, сборка/выполнение запросов, формат JSON.
// Запуск: node scripts/smoke.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { runInNewContext } from 'node:vm'

const storage = await import('../src/main/storage.js')
const http = await import('../src/main/http.js')
const format = await import('../src/renderer/src/lib/format.js')
const defaults = await import('../src/renderer/src/lib/defaults.js')
const requestName = await import('../src/renderer/src/lib/request-name.js')
const variables = await import('../src/renderer/src/lib/variables.js')
const curl = await import('../src/renderer/src/lib/curl.js')
const snippets = await import('../src/renderer/src/lib/snippets.js')
const postman = await import('../src/renderer/src/lib/postman.js')
const mcp = await import('../src/main/mcp.js')
const mock = await import('../src/main/mock.js')

let passed = 0

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ok — ${name}`)
    })
}

const root = await mkdtemp(join(tmpdir(), 'postman-lite-smoke-'))

try {
  // --- Проекты: create → list ---
  await storage.initStorage(root)
  await storage.bootstrap()

  await check('createProject создаёт проект и возвращает структуру', async () => {
    const project = await storage.createProject('Alpha')
    assert.equal(project.name, 'Alpha')
    assert.ok(project.id)
    assert.ok(project.createdAt)
    assert.ok(project.updatedAt)
  })

  await check('второй проект с тем же именем существует как отдельная запись', async () => {
    await storage.createProject('Alpha') // то же имя — отдельный проект
    const projects = await storage.listProjects()
    assert.equal(projects.length, 2)
    assert.notEqual(projects[0].id, projects[1].id)
  })

  await check('createProject отклоняет пустое имя', async () => {
    await assert.rejects(() => storage.createProject('   '), /пустым/)
  })

  // --- Структура файлов ---
  await check('на диске: projects.json + projects/<id>.json с дефолтным содержимым', async () => {
    const index = JSON.parse(await readFile(join(root, 'projects.json'), 'utf8'))
    assert.equal(index.length, 2)
    const projectFile = JSON.parse(await readFile(join(root, 'projects', `${index[0].id}.json`), 'utf8'))
    assert.deepEqual(projectFile, { requests: [], environments: [], activeEnvId: null })
  })

  await check('после записи не остаётся .tmp файлов (атомарность)', async () => {
    const files = await readdir(root)
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0)
  })

  // --- rename ---
  await check('renameProject меняет имя в индексе, данные проекта сохраняются', async () => {
    const [first] = await storage.listProjects()
    const updated = await storage.renameProject(first.id, 'Alpha-2')
    assert.equal(updated.name, 'Alpha-2')
    const index = JSON.parse(await readFile(join(root, 'projects.json'), 'utf8'))
    assert.equal(index.find((p) => p.id === first.id).name, 'Alpha-2')
    const projectFile = JSON.parse(await readFile(join(root, 'projects', `${first.id}.json`), 'utf8'))
    assert.deepEqual(projectFile, { requests: [], environments: [], activeEnvId: null })
  })

  await check('renameProject неизвестного id отклоняется', async () => {
    await assert.rejects(() => storage.renameProject('no-such-id', 'X'), /не найден/)
  })

  // --- Персистентность: переинициализация на той же папке ---
  await check('после переинициализации проекты читаются с диска (persist)', async () => {
    const storage2 = await import('../src/main/storage.js')
    const fresh = join(root) // та же папка; имитируем новый запуск: новая инициализация кэша
    storage2.initStorage(fresh)
    await storage2.bootstrap()
    const projects = await storage2.listProjects()
    assert.equal(projects.length, 2)
    assert.ok(projects.some((p) => p.name === 'Alpha-2'))
  })

  // --- delete ---
  await check('deleteProject убирает запись из индекса и файл проекта', async () => {
    const projects = await storage.listProjects()
    const victim = projects[1]
    await storage.deleteProject(victim.id)
    const rest = await storage.listProjects()
    assert.equal(rest.length, 1)
    await assert.rejects(() => readFile(join(root, 'projects', `${victim.id}.json`), 'utf8'), /ENOENT/)
  })

  await check('deleteProject неизвестного id отклоняется', async () => {
    await assert.rejects(() => storage.deleteProject('no-such-id'), /не найден/)
  })

  // --- Блокировка проекта: setLocked + guard удаления ---
  const lockProject = await storage.createProject('Защищённый')

  await check('createProject создаёт запись с locked: false', async () => {
    const projects = await storage.listProjects()
    const created = projects.find((p) => p.id === lockProject.id)
    assert.equal(created.locked, false)
  })

  await check('setProjectLocked пишет флаг на диск и валидирует аргументы', async () => {
    const updated = await storage.setProjectLocked(lockProject.id, true)
    assert.equal(updated.locked, true)
    const onDisk = await storage.getProject(lockProject.id)
    // флаг в индексе; файл проекта не обязан его содержать — проверяем индекс
    const projects = await storage.listProjects()
    assert.equal(projects.find((p) => p.id === lockProject.id).locked, true)
    await assert.rejects(() => storage.setProjectLocked(lockProject.id, 'yes'), /boolean/)
    await assert.rejects(() => storage.setProjectLocked('no-such-id', true), /не найден/)
    void onDisk
  })

  await check('deleteProject отклоняет заблокированный проект, данные целы', async () => {
    await assert.rejects(() => storage.deleteProject(lockProject.id), /заблокирован/)
    const projects = await storage.listProjects()
    assert.ok(projects.some((p) => p.id === lockProject.id), 'запись в индексе на месте')
    const data = await storage.getProject(lockProject.id)
    assert.ok(data, 'файл проекта на месте')
  })

  await check('после разблокировки удаление работает, persist блокировки между bootstrap', async () => {
    // persist: перечитываем через новый bootstrap (кэш настроек не участвует, но проверим чтение с диска)
    const projects = await storage.listProjects()
    assert.equal(projects.find((p) => p.id === lockProject.id).locked, true)
    await storage.setProjectLocked(lockProject.id, false)
    await storage.deleteProject(lockProject.id)
    const after = await storage.listProjects()
    assert.ok(!after.some((p) => p.id === lockProject.id), 'проект удалён после разблокировки')
  })

  // --- Перемещение проектов: reorderProjects (порядок массива индекса) ---
  const rA = await storage.createProject('Reorder-A')
  const rB = await storage.createProject('Reorder-B')
  const rC = await storage.createProject('Reorder-C')
  // Подпоследовательность из трёх тестовых проектов: остальные тесты могут
  // добавлять в индекс свои записи — порядок внутри тройки не зависит от них.
  const rIds = [rA.id, rB.id, rC.id]
  const rNames = async () =>
    (await storage.listProjects())
      .filter((p) => rIds.includes(p.id))
      .map((p) => p.name)

  await check('reorderProjects меняет порядок индекса, замок записи не тронут', async () => {
    await storage.setProjectLocked(rB.id, true) // замок соседа не мешает
    await storage.reorderProjects(rC.id, 0)
    assert.deepEqual(await rNames(), ['Reorder-C', 'Reorder-A', 'Reorder-B'])
    // Персистентность: порядок и флаг замка перечитываются с диска.
    const reread = await storage.listProjects()
    assert.deepEqual(
      reread.filter((p) => rIds.includes(p.id)).map((p) => p.name),
      ['Reorder-C', 'Reorder-A', 'Reorder-B']
    )
    assert.equal(reread.find((p) => p.id === rB.id).locked, true)
  })

  await check('reorderProjects двигает и сам заблокированный проект (содержимое неизменно)', async () => {
    const list = await storage.reorderProjects(rB.id, 1)
    assert.equal(list.find((p) => p.id === rB.id).locked, true)
    assert.deepEqual(await rNames(), ['Reorder-C', 'Reorder-B', 'Reorder-A'])
    await storage.setProjectLocked(rB.id, false)
  })

  await check('reorderProjects отклоняет невалидные аргументы', async () => {
    await assert.rejects(() => storage.reorderProjects('', 0), /должен быть id/)
    await assert.rejects(() => storage.reorderProjects(rB.id, -1), /toIndex/)
    await assert.rejects(() => storage.reorderProjects(rB.id, 1.5), /toIndex/)
    await assert.rejects(() => storage.reorderProjects('no-such-id', 0), /не найден/)
    // toIndex больше длины зажимается, а не отклоняется.
    await storage.reorderProjects(rB.id, 99)
    assert.deepEqual(await rNames(), ['Reorder-C', 'Reorder-A', 'Reorder-B'])
    await storage.reorderProjects(rB.id, 1)
  })

  await check('после reorder-тестов тестовые проекты удаляются', async () => {
    await storage.deleteProject(rA.id)
    await storage.deleteProject(rB.id)
    await storage.deleteProject(rC.id)
    const after = await storage.listProjects()
    assert.ok(!after.some((p) => rIds.includes(p.id)), 'тройка удалена из индекса')
  })

  // --- Закрепление проектов: setProjectPinned (верхняя зона индекса) ---
  const pA = await storage.createProject('Pin-A')
  const pB = await storage.createProject('Pin-B')
  const pC = await storage.createProject('Pin-C')
  let pD // создаётся в тесте «новые проекты не закреплены»
  const pIds = [pA.id, pB.id, pC.id]
  const pNames = async () =>
    (await storage.listProjects())
      .filter((p) => pIds.includes(p.id))
      .map((p) => p.name)

  await check('setProjectPinned закрепляет в верхнюю зону и пишет на диск', async () => {
    await storage.setProjectPinned(pB.id, true)
    let list = await storage.listProjects()
    assert.deepEqual(await pNames(), ['Pin-B', 'Pin-A', 'Pin-C'])
    assert.equal(list.find((p) => p.id === pB.id).pinned, true)
    // Второй закреплённый встаёт после первого (последним среди закреплённых).
    await storage.setProjectPinned(pC.id, true)
    list = await storage.listProjects()
    assert.deepEqual(await pNames(), ['Pin-B', 'Pin-C', 'Pin-A'])
    assert.equal(list.find((p) => p.id === pC.id).pinned, true)
  })

  await check('renameProject не сбрасывает pin (метаданные записи)', async () => {
    await storage.renameProject(pB.id, 'Pin-B2')
    const list = await storage.listProjects()
    const renamed = list.find((p) => p.id === pB.id)
    assert.equal(renamed.name, 'Pin-B2')
    assert.equal(renamed.pinned, true)
  })

  await check('reorderProjects зажимает позицию в зону pin', async () => {
    // Закреплённый pC не выходит из зоны: попытка ниже границы — no-op для тройки.
    await storage.reorderProjects(pC.id, 99)
    assert.deepEqual(await pNames(), ['Pin-B2', 'Pin-C', 'Pin-A'])
    // Обычный pA не входит в зону: попытка наверх — no-op для тройки.
    await storage.reorderProjects(pA.id, 0)
    assert.deepEqual(await pNames(), ['Pin-B2', 'Pin-C', 'Pin-A'])
  })

  await check('pin и lock независимы, новые проекты не закреплены', async () => {
    await storage.setProjectLocked(pB.id, true)
    let list = await storage.listProjects()
    assert.equal(list.find((p) => p.id === pB.id).locked, true)
    assert.equal(list.find((p) => p.id === pB.id).pinned, true)
    pD = await storage.createProject('Pin-D')
    list = await storage.listProjects()
    assert.equal(list.find((p) => p.id === pD.id).pinned, false)
    await storage.setProjectPinned(pB.id, false)
    await storage.setProjectLocked(pB.id, false)
  })

  await check('setProjectPinned валидирует аргументы', async () => {
    await assert.rejects(() => storage.setProjectPinned(pB.id, 'yes'), /boolean/)
    await assert.rejects(() => storage.setProjectPinned('no-such-id', true), /не найден/)
  })

  await check('после pin-тестов тестовые проекты удаляются', async () => {
    for (const id of [...pIds, pD.id]) await storage.deleteProject(id)
    const after = await storage.listProjects()
    assert.ok(!after.some((p) => [...pIds, pD.id].includes(p.id)), 'четвёрка удалена из индекса')
  })

  // --- Запросы проекта: save/list/delete ---
  const requestsProject = await storage.createProject('Хранилище запросов')
  const fullRequest = {
    id: 'req-1',
    name: 'Users',
    method: 'POST',
    url: 'https://api.example.com/users',
    params: [{ id: 'p1', key: 'page', value: '2', enabled: true }],
    headers: [{ id: 'h1', key: 'Accept', value: 'application/json', enabled: true }],
    body: { type: 'json', json: '{"limit":5}' },
    auth: { type: 'bearer', token: 't-123' },
    sslVerify: false
  }

  await check('saveRequest добавляет запрос в requests[] и пишет на диск', async () => {
    const list = await storage.saveRequest(requestsProject.id, fullRequest)
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'Users')
    const onDisk = await storage.getProject(requestsProject.id)
    assert.equal(onDisk.requests.length, 1)
    assert.equal(onDisk.requests[0].body.json, '{"limit":5}')
    assert.equal(onDisk.requests[0].sslVerify, false)
  })

  await check('saveRequest с тем же id обновляет запись на её позиции (upsert)', async () => {
    await storage.saveRequest(requestsProject.id, { id: 'req-2', name: 'Token' })
    const list = await storage.saveRequest(requestsProject.id, {
      ...fullRequest,
      name: 'Users v2',
      url: 'https://api.example.com/v2'
    })
    assert.equal(list.length, 2)
    assert.equal(list[0].name, 'Users v2', 'позиция сохранена')
    assert.equal(list[0].url, 'https://api.example.com/v2')
    assert.equal(list[1].name, 'Token')
  })

  await check('saveRequest отклоняет пустое имя и запрос без id', async () => {
    await assert.rejects(() => storage.saveRequest(requestsProject.id, { id: 'req-3', name: '   ' }), /пустым/)
    await assert.rejects(() => storage.saveRequest(requestsProject.id, { name: 'NoId' }), /должен быть id/)
  })

  await check('deleteRequest убирает запрос, остальные остаются; неизвестный id отклоняется', async () => {
    const list = await storage.deleteRequest(requestsProject.id, 'req-1')
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'req-2')
    await assert.rejects(() => storage.deleteRequest(requestsProject.id, 'req-1'), /не найден/)
    const onDisk = await storage.getProject(requestsProject.id)
    assert.equal(onDisk.requests.length, 1)
  })

  // --- Блокировка запроса: setLocked + guard'ы ---
  const lockReqProject = await storage.createProject('Блокировка запросов')
  await storage.saveRequest(lockReqProject.id, { id: 'lr-1', name: 'Защищённый запрос' })
  await storage.saveRequest(lockReqProject.id, { id: 'lr-2', name: 'Обычный запрос' })

  await check('setRequestLocked пишет флаг на диск и валидирует аргументы', async () => {
    const list = await storage.setRequestLocked(lockReqProject.id, 'lr-1', true)
    assert.equal(list.find((r) => r.id === 'lr-1').locked, true)
    assert.equal(list.find((r) => r.id === 'lr-2').locked, false)
    await assert.rejects(() => storage.setRequestLocked(lockReqProject.id, 'lr-1', 'yes'), /boolean/)
    await assert.rejects(() => storage.setRequestLocked(lockReqProject.id, 'nope', true), /не найден/)
  })

  await check('saveRequest отклоняет обновление заблокированного, запись неизменна', async () => {
    await assert.rejects(
      () => storage.saveRequest(lockReqProject.id, { id: 'lr-1', name: 'Взломано', url: 'https://evil.test' }),
      /заблокирован/
    )
    const list = await storage.listRequests(lockReqProject.id)
    const locked = list.find((r) => r.id === 'lr-1')
    assert.equal(locked.name, 'Защищённый запрос', 'имя не перезаписано')
    assert.equal(locked.url ?? '', '', 'url не перезаписан')
    assert.equal(locked.locked, true)
  })

  await check('saveRequest создаёт новый запрос свободно, даже пока другой заблокирован', async () => {
    const list = await storage.saveRequest(lockReqProject.id, { id: 'lr-3', name: 'Новый свободный' })
    assert.equal(list.length, 3)
    assert.equal(list.find((r) => r.id === 'lr-3').locked, false)
  })

  await check('deleteRequest отклоняет заблокированный запрос', async () => {
    await assert.rejects(() => storage.deleteRequest(lockReqProject.id, 'lr-1'), /заблокирован/)
    const list = await storage.listRequests(lockReqProject.id)
    assert.equal(list.length, 3, 'запись осталась')
  })

  await check('после разблокировки save/delete работают', async () => {
    await storage.setRequestLocked(lockReqProject.id, 'lr-1', false)
    const list = await storage.saveRequest(lockReqProject.id, { id: 'lr-1', name: 'Изменено свободно' })
    assert.equal(list.find((r) => r.id === 'lr-1').name, 'Изменено свободно')
    const after = await storage.deleteRequest(lockReqProject.id, 'lr-1')
    assert.equal(after.length, 2)
  })

  // Текущее состояние lockReqProject: [lr-2, lr-3], оба разблокированы.

  await check('reorderRequests перемещает запрос и пишет порядок на диск', async () => {
    await storage.setRequestLocked(lockReqProject.id, 'lr-2', true) // замок соседа не мешает
    const list = await storage.reorderRequests(lockReqProject.id, 'lr-3', 0)
    assert.deepEqual(list.map((r) => r.id), ['lr-3', 'lr-2'])
    // Персистентность: повторное чтение с диска в том же порядке.
    const reread = await storage.listRequests(lockReqProject.id)
    assert.deepEqual(reread.map((r) => r.id), ['lr-3', 'lr-2'])
    assert.equal(reread.find((r) => r.id === 'lr-2').locked, true, 'содержимое и замок не тронуты')
  })

  await check('reorderRequests двигает и сам заблокированный запрос (содержимое неизменно)', async () => {
    const list = await storage.reorderRequests(lockReqProject.id, 'lr-2', 0)
    assert.deepEqual(list.map((r) => r.id), ['lr-2', 'lr-3'])
    assert.equal(list.find((r) => r.id === 'lr-2').locked, true)
    await storage.setRequestLocked(lockReqProject.id, 'lr-2', false)
  })

  await check('reorderRequests отклоняет невалидные аргументы', async () => {
    await assert.rejects(() => storage.reorderRequests(lockReqProject.id, '', 0), /должен быть id/)
    await assert.rejects(() => storage.reorderRequests(lockReqProject.id, 'lr-2', -1), /toIndex/)
    await assert.rejects(() => storage.reorderRequests(lockReqProject.id, 'lr-2', 1.5), /toIndex/)
    await assert.rejects(() => storage.reorderRequests(lockReqProject.id, 'nope', 0), /не найден/)
    // toIndex больше длины зажимается, а не отклоняется.
    const list = await storage.reorderRequests(lockReqProject.id, 'lr-2', 99)
    assert.deepEqual(list.map((r) => r.id), ['lr-3', 'lr-2'])
    await storage.reorderRequests(lockReqProject.id, 'lr-2', 0)
  })

  await check('reorderRequests работает при заблокированном проекте', async () => {
    await storage.setProjectLocked(lockReqProject.id, true)
    const list = await storage.reorderRequests(lockReqProject.id, 'lr-2', 1)
    assert.deepEqual(list.map((r) => r.id), ['lr-3', 'lr-2'])
    await storage.setProjectLocked(lockReqProject.id, false)
  })

  // Текущее состояние lockReqProject: [lr-3, lr-2], оба разблокированы и не закреплены.

  await check('setRequestPinned закрепляет в верхнюю зону и пишет на диск', async () => {
    await storage.setRequestPinned(lockReqProject.id, 'lr-2', true)
    const list = await storage.listRequests(lockReqProject.id)
    assert.deepEqual(list.map((r) => r.id), ['lr-2', 'lr-3'], 'закреплённый — префикс списка')
    assert.equal(list.find((r) => r.id === 'lr-2').pinned, true)
    // Второй закреплённый встаёт после первого (последним среди закреплённых).
    await storage.setRequestPinned(lockReqProject.id, 'lr-3', true)
    const both = await storage.listRequests(lockReqProject.id)
    assert.deepEqual(both.map((r) => r.id), ['lr-2', 'lr-3'])
    assert.equal(both.every((r) => r.pinned === true), true)
  })

  await check('saveRequest не сбрасывает pin при обновлении содержимого', async () => {
    const list = await storage.saveRequest(lockReqProject.id, { id: 'lr-2', name: 'Обновлено', url: 'https://upd.test' })
    const lr2 = list.find((r) => r.id === 'lr-2')
    assert.equal(lr2.pinned, true, 'pin сохранён при upsert')
    assert.equal(lr2.name, 'Обновлено')
    assert.deepEqual(list.map((r) => r.id), ['lr-2', 'lr-3'], 'позиция не изменилась')
  })

  await check('setRequestPinned открепляет перед первым обычным', async () => {
    await storage.setRequestPinned(lockReqProject.id, 'lr-2', false)
    const list = await storage.listRequests(lockReqProject.id)
    assert.deepEqual(list.map((r) => r.id), ['lr-3', 'lr-2'])
    assert.equal(list.find((r) => r.id === 'lr-3').pinned, true)
    assert.equal(list.find((r) => r.id === 'lr-2').pinned, false)
  })

  await check('reorderRequests зажимает позицию в зону pin', async () => {
    // Обычный lr-2 (индекс 1) не входит в зону закреплённых: попытка в 0 — no-op.
    const rest = await storage.reorderRequests(lockReqProject.id, 'lr-2', 0)
    assert.deepEqual(rest.map((r) => r.id), ['lr-3', 'lr-2'])
    // Закреплённый lr-3 (индекс 0) не выходит из зоны: попытка в 1 — no-op.
    const pinned = await storage.reorderRequests(lockReqProject.id, 'lr-3', 1)
    assert.deepEqual(pinned.map((r) => r.id), ['lr-3', 'lr-2'])
  })

  await check('saveRequest создаёт новый запрос незакреплённым, pin+lock независимы', async () => {
    await storage.saveRequest(lockReqProject.id, { id: 'lr-4', name: 'Новый' })
    let list = await storage.listRequests(lockReqProject.id)
    assert.equal(list.find((r) => r.id === 'lr-4').pinned, false)
    assert.deepEqual(list.map((r) => r.id), ['lr-3', 'lr-2', 'lr-4'])
    // Заблокированный запрос закрепляется как обычно — флаги независимы.
    await storage.setRequestLocked(lockReqProject.id, 'lr-3', true)
    await storage.setRequestPinned(lockReqProject.id, 'lr-3', true)
    list = await storage.listRequests(lockReqProject.id)
    assert.equal(list.find((r) => r.id === 'lr-3').locked, true)
    assert.equal(list.find((r) => r.id === 'lr-3').pinned, true)
    await storage.setRequestPinned(lockReqProject.id, 'lr-3', false)
    await storage.setRequestLocked(lockReqProject.id, 'lr-3', false)
    await storage.deleteRequest(lockReqProject.id, 'lr-4')
  })

  await check('setRequestPinned валидирует аргументы', async () => {
    await assert.rejects(() => storage.setRequestPinned(lockReqProject.id, 'lr-2', 'yes'), /boolean/)
    await assert.rejects(() => storage.setRequestPinned(lockReqProject.id, 'nope', true), /не найден/)
  })

  // --- Postman-импорт: fixture + parseCollection (lib/postman.js) ---

  // Fixture: вложенные папки, все body-режимы, disabled-поля, collection-level auth, переменные.
  const FIXTURE_COLLECTION = {
    info: { name: 'API Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 't-coll' }] },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:4545', disabled: false },
      { key: 'legacy', value: 'x', disabled: true }
    ],
    item: [
      {
        name: 'Auth',
        item: [
          {
            name: 'OAuth',
            item: [
              {
                name: 'Token',
                request: {
                  method: 'POST',
                  url: { raw: '{{baseUrl}}/token', query: [{ key: 'mode', value: 'client', disabled: true }] },
                  header: [{ key: 'Accept', value: 'application/json' }],
                  body: {
                    mode: 'urlencoded',
                    urlencoded: [
                      { key: 'grant_type', value: 'client_credentials' },
                      { key: 'skip', value: 'x', disabled: true }
                    ]
                  },
                  auth: { type: 'basic', basic: [{ key: 'username', value: 'user' }, { key: 'password', value: 'pass' }] }
                }
              }
            ]
          }
        ]
      },
      {
        name: 'JSON echo',
        request: {
          method: 'POST',
          url: '{{baseUrl}}/echo',
          body: { mode: 'raw', options: { raw: { lang: 'json' } }, raw: '{"a":1}' }
        }
      },
      {
        name: 'Form',
        request: {
          method: 'POST',
          url: '{{baseUrl}}/form',
          header: [{ key: 'X-Trace', value: '1', disabled: true }],
          body: {
            mode: 'formdata',
            formdata: [
              { key: 'note', value: 'hi' },
              { key: 'doc', type: 'file', src: '/tmp/doc.pdf' }
            ]
          }
        }
      },
      {
        name: 'Raw text',
        request: { method: 'POST', url: '{{baseUrl}}/text', body: { mode: 'raw', raw: 'просто текст' } }
      },
      {
        name: 'File body',
        request: { method: 'POST', url: '{{baseUrl}}/file', body: { mode: 'file', file: { src: '/x' } } }
      },
      { name: 'No body', request: { method: 'GET', url: '{{baseUrl}}/ping' } }
    ]
  }

  await check('parseCollection: типичная коллекция → проект/запросы/переменные', () => {
    const result = postman.parseCollection(JSON.stringify(FIXTURE_COLLECTION))
    assert.equal(result.name, 'API Demo')
    assert.equal(result.requests.length, 6)
    assert.equal(result.variables.length, 2)
    assert.equal(result.variables[0].key, 'baseUrl')
    assert.equal(result.variables[0].enabled, true)
    assert.equal(result.variables[1].enabled, false, 'выключенная переменная — снятая галочка')
  })

  await check('parseCollection: папки и вложенность → префиксы « / »', () => {
    const { requests } = postman.parseCollection(JSON.stringify(FIXTURE_COLLECTION))
    assert.deepEqual(
      requests.map((r) => r.name),
      ['Auth / OAuth / Token', 'JSON echo', 'Form', 'Raw text', 'File body', 'No body']
    )
  })

  await check('parseCollection: query/headers с disabled, urlencoded', () => {
    const { requests } = postman.parseCollection(JSON.stringify(FIXTURE_COLLECTION))
    const token = requests[0]
    assert.equal(token.method, 'POST')
    assert.equal(token.url, '{{baseUrl}}/token')
    assert.equal(token.params[0].key, 'mode')
    assert.equal(token.params[0].enabled, false, 'disabled query → снятая галочка')
    assert.equal(token.headers[0].key, 'Accept')
    assert.equal(token.headers[0].enabled, true)
    assert.equal(token.body.type, 'urlencoded')
    assert.equal(token.body.urlencoded[0].value, 'client_credentials')
    assert.equal(token.body.urlencoded[1].enabled, false)
    // собственная basic перекрывает collection-level bearer
    assert.equal(token.auth.type, 'basic')
    assert.equal(token.auth.username, 'user')
  })

  await check('parseCollection: тела raw+json / formdata+file / raw text / file → none', () => {
    const { requests } = postman.parseCollection(JSON.stringify(FIXTURE_COLLECTION))
    assert.equal(requests[1].body.type, 'json')
    assert.equal(requests[1].body.json, '{"a":1}')
    // наследование: запрос без своего auth получает bearer коллекции
    assert.equal(requests[1].auth.type, 'bearer')
    assert.equal(requests[1].auth.token, 't-coll')

    const form = requests[2]
    assert.equal(form.body.type, 'form-data')
    assert.equal(form.body.form[0].value, 'hi')
    assert.equal(form.body.form[1].value, '@/tmp/doc.pdf', 'файл-поле → литерал @src')
    assert.equal(form.headers[0].enabled, false, 'disabled header → снятая галочка')

    assert.equal(requests[3].body.type, 'text')
    assert.equal(requests[3].body.text, 'просто текст')

    assert.equal(requests[4].body.type, 'none', 'file-режим → none')
    assert.equal(requests[5].body.type, 'none')
    assert.equal(requests[5].method, 'GET')
  })

    await check('parseCollection: ошибки — не-JSON и не-коллекция', () => {
      assert.throws(() => postman.parseCollection('{ это не json'), /не является корректным JSON/)
      assert.throws(() => postman.parseCollection('{"name": "не коллекция"}'), /Не похоже на коллекцию/)
      assert.throws(() => postman.parseCollection('{"info": {"name": ""}, "item": []}'), /Не похоже на коллекцию/)
    })

    // --- Postman-импорт: bulk-хранилище (importCollection) ---

    await check('importCollection: проект + запросы + активное окружение одной записью', async () => {
      const parsed = postman.parseCollection(JSON.stringify(FIXTURE_COLLECTION))
      const project = await storage.importCollection({
        name: parsed.name,
        requests: parsed.requests,
        variables: parsed.variables
      })
      assert.equal(project.name, 'API Demo')
      const projects = await storage.listProjects()
      assert.ok(projects.some((p) => p.id === project.id), 'проект в индексе')
      const onDisk = await storage.getProject(project.id)
      assert.equal(onDisk.requests.length, 6)
      assert.equal(onDisk.environments.length, 1)
      assert.equal(onDisk.environments[0].name, 'API Demo')
      assert.equal(onDisk.environments[0].variables[0].key, 'baseUrl')
      assert.equal(onDisk.activeEnvId, onDisk.environments[0].id, 'окружение активно')
      assert.equal(onDisk.requests[0].name, 'Auth / OAuth / Token')
      await assert.rejects(() => storage.importCollection({ name: '   ' }), /пустым/)
    })

  // --- Окружения проекта: save/list/setActive/delete ---
  const envProject = await storage.createProject('Хранилище окружений')

  await check('saveEnvironment upsert: добавление, обновление на позиции, пустое имя', async () => {
    await storage.saveEnvironment(envProject.id, {
      id: 'env-1',
      name: 'Dev',
      variables: [{ id: 'v1', key: 'baseUrl', value: 'http://localhost', enabled: true }]
    })
    await storage.saveEnvironment(envProject.id, { id: 'env-2', name: 'Prod', variables: [] })
    const list = await storage.saveEnvironment(envProject.id, { id: 'env-1', name: 'Dev v2' })
    assert.equal(list.length, 2)
    assert.equal(list[0].name, 'Dev v2', 'позиция сохранена')
    assert.equal(list[1].name, 'Prod')
    await assert.rejects(() => storage.saveEnvironment(envProject.id, { id: 'env-3', name: '  ' }), /пустым/)
  })

  await check('setActiveEnvironment персистентен и отклоняет неизвестный id', async () => {
    const { activeEnvId } = await storage.setActiveEnvironment(envProject.id, 'env-1')
    assert.equal(activeEnvId, 'env-1')
    const onDisk = await storage.getProject(envProject.id)
    assert.equal(onDisk.activeEnvId, 'env-1')
    await assert.rejects(() => storage.setActiveEnvironment(envProject.id, 'nope'), /не найден/)
  })

  await check('deleteEnvironment обнуляет activeEnvId удалённого активного', async () => {
    const { activeEnvId, environments } = await storage.deleteEnvironment(envProject.id, 'env-1')
    assert.equal(environments.length, 1)
    assert.equal(activeEnvId, null)
    await assert.rejects(() => storage.deleteEnvironment(envProject.id, 'env-1'), /не найден/)
  })

  // --- Невалидный JSON не затирается ---
  await check('повреждённый projects.json вызывает CORRUPT_STORAGE и не перезаписывается', async () => {
    const garbage = '{ это не json'
    await writeFile(join(root, 'projects.json'), garbage, 'utf8')
    await assert.rejects(
      () => storage.listProjects(),
      (err) => err.code === 'CORRUPT_STORAGE'
    )
    const after = await readFile(join(root, 'projects.json'), 'utf8')
    assert.equal(after, garbage, 'файл не должен быть перезаписан')
  })

  // --- Настройки ---
  await check('getSettings по умолчанию: тёмная тема и дефолты секции mcp', async () => {
    const settings = await storage.getSettings()
    assert.deepEqual(settings, { theme: 'dark', mcp: { enabled: false, port: 45460, token: null } })
  })

  await check('setSettings сохраняет тему и другие ключи не теряются', async () => {
    await storage.setSettings({ theme: 'light' })
    await storage.setSettings({ futureSetting: 42 })
    const settings = await storage.getSettings()
    assert.deepEqual(settings, {
      theme: 'light',
      futureSetting: 42,
      mcp: { enabled: false, port: 45460, token: null }
    })
    const onDisk = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    assert.equal(onDisk.theme, 'light')
    assert.deepEqual(onDisk.mcp, { enabled: false, port: 45460, token: null })
  })

  await check('getSettingsSync (для preload) отдаёт актуальный кэш', () => {
    assert.deepEqual(storage.getSettingsSync(), {
      theme: 'light',
      futureSetting: 42,
      mcp: { enabled: false, port: 45460, token: null }
    })
  })

  // --- HTTP: сборка запроса (buildRequest) ---

  await check('buildRequest мержит включённые params в query и сохраняет query из URL', () => {
    const built = http.buildRequest({
      method: 'GET',
      url: 'https://api.example.com/users?limit=10',
      params: [
        { id: '1', key: 'page', value: '2', enabled: true },
        { id: '2', key: 'limit', value: '99', enabled: true }
      ]
    })
    assert.equal(built.url, 'https://api.example.com/users?limit=10&page=2&limit=99')
    assert.equal(built.method, 'GET')
    assert.equal(built.body, undefined)
  })

  await check('buildRequest пропускает отключённые строки и строки с пустым ключом', () => {
    const built = http.buildRequest({
      method: 'GET',
      url: 'https://api.example.com',
      params: [
        { id: '1', key: 'debug', value: '1', enabled: false },
        { id: '2', key: '', value: 'x', enabled: true },
        { id: '3', key: 'ok', value: 'yes', enabled: true }
      ],
      headers: [
        { id: '4', key: 'X-Trace', value: 'abc', enabled: false },
        { id: '5', key: 'X-Real', value: 'yes', enabled: true }
      ]
    })
    assert.ok(!built.url.includes('debug'), 'отключённый param не попадает в URL')
    assert.ok(built.url.endsWith('ok=yes'))
    assert.deepEqual(built.headers, [{ key: 'X-Real', value: 'yes' }])
  })

  await check('buildRequest отклоняет пустой и невалидный URL кодом INVALID_URL', () => {
    assert.throws(() => http.buildRequest({ method: 'GET', url: '' }), (err) => err.code === 'INVALID_URL')
    assert.throws(() => http.buildRequest({ method: 'GET', url: 'not a url' }), (err) => err.code === 'INVALID_URL')
    assert.throws(() => http.buildRequest({ method: 'GET', url: 'ftp://example.com' }), (err) => err.code === 'INVALID_URL')
  })

  await check('buildRequest: bearer → Authorization: Bearer <token>', () => {
    const built = http.buildRequest({
      method: 'GET',
      url: 'https://api.example.com',
      auth: { type: 'bearer', token: 't-secret-123' }
    })
    assert.deepEqual(built.headers, [{ key: 'Authorization', value: 'Bearer t-secret-123' }])
  })

  await check('buildRequest: bearer с пустым токеном не добавляет заголовок', () => {
    const built = http.buildRequest({
      method: 'GET',
      url: 'https://api.example.com',
      auth: { type: 'bearer', token: '' }
    })
    assert.deepEqual(built.headers, [])
  })

  await check('buildRequest: basic → Authorization: Basic <base64>, unicode через Buffer', () => {
    const built = http.buildRequest({
      method: 'GET',
      url: 'https://api.example.com',
      auth: { type: 'basic', username: 'user', password: 'pass' }
    })
    assert.equal(built.headers[0].value, 'Basic dXNlcjpwYXNz')
    const unicode = http.buildRequest({
      method: 'GET',
      url: 'https://api.example.com',
      auth: { type: 'basic', username: 'user', password: 'пароль' }
    })
    assert.equal(unicode.headers[0].value, 'Basic ' + Buffer.from('user:пароль', 'utf8').toString('base64'))
  })

  await check('buildRequest: apikey в заголовок и в query по placement', () => {
    const asHeader = http.buildRequest({
      method: 'GET',
      url: 'https://api.example.com',
      auth: { type: 'apikey', key: 'X-Api-Key', value: 'k-42', placement: 'header' }
    })
    assert.deepEqual(asHeader.headers, [{ key: 'X-Api-Key', value: 'k-42' }])

    const asQuery = http.buildRequest({
      method: 'GET',
      url: 'https://api.example.com',
      auth: { type: 'apikey', key: 'apiKey', value: 'k-42', placement: 'query' }
    })
    assert.equal(asQuery.url, 'https://api.example.com/?apiKey=k-42')
    assert.deepEqual(asQuery.headers, [])
  })

  await check('buildRequest: тело json с Content-Type application/json', () => {
    const built = http.buildRequest({
      method: 'POST',
      url: 'https://api.example.com',
      body: { type: 'json', json: '{"name":"Ann"}' }
    })
    assert.equal(built.body, '{"name":"Ann"}')
    assert.deepEqual(built.headers, [{ key: 'Content-Type', value: 'application/json' }])
  })

  await check('buildRequest: пользовательский Content-Type не дублируется авто-заголовком', () => {
    const built = http.buildRequest({
      method: 'POST',
      url: 'https://api.example.com',
      headers: [{ id: '1', key: 'content-type', value: 'application/vnd.api+json', enabled: true }],
      body: { type: 'json', json: '{}' }
    })
    assert.deepEqual(built.headers, [{ key: 'content-type', value: 'application/vnd.api+json' }])
  })

  await check('buildRequest: тело urlencoded из таблицы с экранированием', () => {
    const built = http.buildRequest({
      method: 'POST',
      url: 'https://api.example.com/token',
      body: {
        type: 'urlencoded',
        urlencoded: [
          { id: '1', key: 'grant_type', value: 'client_credentials', enabled: true },
          { id: '2', key: 'client_id', value: 'abc', enabled: true },
          { id: '3', key: 'note', value: 'a b&c', enabled: true }
        ]
      }
    })
    assert.equal(built.body, 'grant_type=client_credentials&client_id=abc&note=a%20b%26c')
    assert.equal(built.headers[0].value, 'application/x-www-form-urlencoded')
  })

  await check('buildRequest: тело text без обработки и none без тела', () => {
    const text = http.buildRequest({
      method: 'POST',
      url: 'https://api.example.com',
      body: { type: 'text', text: 'просто текст' }
    })
    assert.equal(text.body, 'просто текст')
    assert.equal(text.headers[0].value, 'text/plain')

    const none = http.buildRequest({ method: 'GET', url: 'https://api.example.com', body: { type: 'none' } })
    assert.equal(none.body, undefined)
    assert.deepEqual(none.headers, [])
  })

  await check('buildRequest: form-data собирается как multipart с границей', () => {
    const built = http.buildRequest({
      method: 'POST',
      url: 'https://api.example.com',
      body: {
        type: 'form-data',
        form: [
          { id: '1', key: 'field1', value: 'value1', enabled: true },
          { id: '2', key: '', value: 'skip', enabled: true },
          { id: '3', key: 'field2', value: 'value2', enabled: true }
        ]
      }
    })
    const ct = built.headers.find((h) => h.key === 'Content-Type')
    assert.ok(ct.value.startsWith('multipart/form-data; boundary=----postmanlite'), 'boundary в Content-Type')
    const boundary = ct.value.split('boundary=')[1]
    assert.ok(built.body.startsWith(`--${boundary}\r\n`))
    assert.ok(built.body.includes('Content-Disposition: form-data; name="field1"\r\n\r\nvalue1\r\n'))
    assert.ok(built.body.includes('name="field2"'))
    assert.ok(!built.body.includes('skip'), 'строка с пустым ключом не попадает в multipart')
    assert.ok(built.body.endsWith(`--${boundary}--\r\n`))
  })

  // --- HTTP: выполнение (sendRequest) на локальном сервере ---

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 500)
        return
      }
      if (req.url === '/hang') return // не отвечает: таймаут и отмена
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('x'.repeat(5000))
        return
      }
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'X-Served-By': 'smoke' })
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const closeServer = async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }

  try {
    await check('sendRequest выполняет GET с params, auth и заголовками, ответ содержит статус/время/тело', async () => {
      const response = await http.sendRequest(
        {
          method: 'GET',
          url: `${base}/users`,
          params: [{ id: '1', key: 'page', value: '2', enabled: true }],
          headers: [{ id: '2', key: 'X-Request-Source', value: 'postman-lite', enabled: true }],
          auth: { type: 'bearer', token: 't-secret-123' },
          body: { type: 'none' }
        },
        'smoke-1'
      )
      assert.equal(response.status, 201)
      assert.ok(Number.isFinite(response.timeMs) && response.timeMs >= 0)
      assert.ok(response.size > 0)
      assert.equal(response.truncated, false)
      const echo = JSON.parse(response.body)
      assert.equal(echo.headers.authorization, 'Bearer t-secret-123')
      assert.equal(echo.headers['x-request-source'], 'postman-lite')
      assert.ok(echo.url.includes('page=2'))
      const served = response.headers.find((h) => h.key.toLowerCase() === 'x-served-by')
      assert.equal(served.value, 'smoke')
    })

    await check('sendRequest отправляет form-data так, как собрал buildRequest', async () => {
      const response = await http.sendRequest(
        {
          method: 'POST',
          url: `${base}/form`,
          body: {
            type: 'form-data',
            form: [
              { id: '1', key: 'field1', value: 'value1', enabled: true },
              { id: '2', key: 'field2', value: 'value2', enabled: true }
            ]
          }
        },
        'smoke-2'
      )
      const echo = JSON.parse(response.body)
      assert.equal(echo.headers['content-type'].startsWith('multipart/form-data; boundary='), true)
      assert.ok(echo.body.includes('name="field1"'), 'сервер получил часть field1')
      assert.ok(echo.body.includes('value2'), 'сервер получил значение field2')
    })

    await check('sendRequest: cancelRequest прерывает выполнение кодом ABORTED', async () => {
      const pending = http.sendRequest({ method: 'GET', url: `${base}/slow` }, 'smoke-3')
      http.cancelRequest('smoke-3')
      await assert.rejects(pending, (err) => err.code === 'ABORTED')
    })

    await check('sendRequest: таймаут даёт код TIMEOUT', async () => {
      await assert.rejects(
        () => http.sendRequest({ method: 'GET', url: `${base}/hang` }, 'smoke-4', { timeoutMs: 100 }),
        (err) => err.code === 'TIMEOUT'
      )
    })

    await check('sendRequest: недоступный сервер даёт код NETWORK', async () => {
      // Порт 1 на 127.0.0.1 практически наверняка закрыт — соединение будет отклонено.
      await assert.rejects(
        () => http.sendRequest({ method: 'GET', url: 'http://127.0.0.1:1/nope' }, 'smoke-5'),
        (err) => err.code === 'NETWORK'
      )
    })

    await check('sendRequest: GET с телом отправляется без тела (как в Postman)', async () => {
      const response = await http.sendRequest(
        {
          method: 'GET',
          url: `${base}/get-with-body`,
          body: { type: 'json', json: '{"ignored":true}' }
        },
        'smoke-7'
      )
      const echo = JSON.parse(response.body)
      assert.equal(echo.body, '', 'тело GET не ушло на сервер')
    })

    await check('sendRequest обрезает тело по лимиту и помечает truncated', async () => {
      const response = await http.sendRequest({ method: 'GET', url: `${base}/big` }, 'smoke-6', { bodyLimit: 1000 })
      assert.equal(response.size, 1000)
      assert.equal(response.body.length, 1000)
      assert.equal(response.truncated, true)
    })

    // --- Формат JSON (lib/format.js) ---

    await check('escapeHtml экранирует HTML-опасные символы', () => {
      assert.equal(
        format.escapeHtml(`<script>"'</script>`),
        '&lt;script&gt;&quot;&#39;&lt;/script&gt;'
      )
    })

    await check('prettyJson форматирует валидный JSON и возвращает null для невалидного', () => {
      assert.equal(format.prettyJson('{"a":1}'), '{\n  "a": 1\n}')
      assert.equal(format.prettyJson('не json'), null)
    })

    await check('highlightJson раскрашивает токены и экранирует содержимое строк', () => {
      const html = format.highlightJson('{"name":"<b>Ann</b>","age":30,"ok":true}')
      assert.ok(html.includes('<span class="tok-key">'), 'ключ раскрашен')
      assert.ok(html.includes('&lt;b&gt;Ann&lt;/b&gt;'), 'строка экранирована, XSS не пройдёт')
      assert.ok(html.includes('<span class="tok-number">30</span>'))
      assert.ok(html.includes('<span class="tok-bool">true</span>'))
      assert.ok(!html.includes('<b>'), 'сырой HTML в вывод не попадает')
    })

    // --- Дефолтные заголовки (lib/defaults.js) ---

    await check('DEFAULT_HEADERS: три включённых стандартных заголовка', () => {
      const keys = defaults.DEFAULT_HEADERS.map((h) => h.key)
      assert.deepEqual(keys, ['User-Agent', 'Accept', 'Accept-Language'])
      for (const header of defaults.DEFAULT_HEADERS) {
        assert.equal(header.enabled, true)
        assert.ok(header.key && header.value, 'ключ и значение заполнены')
      }
    })

    await check('DEFAULT_HEADERS отправляются вместо автозаголовков undici, без дублирования', async () => {
      const response = await http.sendRequest(
        { method: 'GET', url: `${base}/defaults`, headers: defaults.DEFAULT_HEADERS },
        'smoke-default-headers'
      )
      const echo = JSON.parse(response.body)
      assert.equal(echo.headers['user-agent'], 'PostmanLite/1.0')
      // Ровно одно значение — undici не добавил своё */* рядом с нашим Accept.
      assert.equal(echo.headers['accept'], 'application/json')
      assert.equal(echo.headers['accept-language'], 'ru-RU,ru;q=0.9')
    })

    await check('suggestRequestName: сегмент пути, hostname, невалидный URL', () => {
      assert.equal(requestName.suggestRequestName('https://example.com/api/users'), 'users')
      assert.equal(requestName.suggestRequestName('https://example.com/users?page=2'), 'users')
      assert.equal(requestName.suggestRequestName('https://example.com'), 'example.com')
      assert.equal(requestName.suggestRequestName('не URL'), '')
      assert.equal(requestName.suggestRequestName(''), '')
    })

    // --- Подстановка переменных окружения (lib/variables.js) ---

    await check('applyEnvironment подставляет url/params/headers/auth/body, выключенная — литерально', () => {
      const vars = variables.buildVars([
        { key: 'baseUrl', value: 'http://localhost:4545', enabled: true },
        { key: 'token', value: 't-1', enabled: true },
        { key: 'page', value: '2', enabled: true },
        { key: 'debug', value: '1', enabled: false }
      ])
      const resolved = variables.applyEnvironment(
        {
          url: '{{baseUrl}}/echo?page={{page}}',
          params: [{ id: 'p1', key: 'page', value: '{{page}}', enabled: true }],
          headers: [{ id: 'h1', key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
          auth: { type: 'bearer', token: '{{token}}' },
          body: { type: 'json', json: '{"page":"{{page}}","debug":"{{debug}}"}' }
        },
        vars
      )
      assert.equal(resolved.url, 'http://localhost:4545/echo?page=2')
      assert.equal(resolved.params[0].value, '2')
      assert.equal(resolved.headers[0].value, 'Bearer t-1')
      assert.equal(resolved.auth.token, 't-1', 'auth-token подставляется')
      assert.equal(resolved.body.json, '{"page":"2","debug":"{{debug}}"}', 'выключенная переменная не подставляется')
    })

    await check('applyEnvironment: пустой словарь и неразрешённые плейсхолдеры литеральны', () => {
      const resolved = variables.applyEnvironment(
        { url: '{{baseUrl}}/x', params: [], headers: [], body: { type: 'text', text: '{{a}}{{b}}' } },
        variables.buildVars([])
      )
      assert.equal(resolved.url, '{{baseUrl}}/x')
      assert.equal(resolved.body.text, '{{a}}{{b}}')
    })

    await check('applyEnvironment подставляет ключи и значения в активном слоте body', () => {
      const vars = variables.buildVars([
        { key: 'k', value: 'fieldX', enabled: true },
        { key: 'v', value: 'valY', enabled: true }
      ])
      const formData = variables.applyEnvironment(
        {
          url: 'http://x',
          params: [],
          headers: [],
          body: { type: 'form-data', form: [{ id: 'f1', key: '{{k}}', value: '{{v}}', enabled: true }] }
        },
        vars
      )
      assert.equal(formData.body.form[0].key, 'fieldX')
      assert.equal(formData.body.form[0].value, 'valY')

      const urlencoded = variables.applyEnvironment(
        {
          url: 'http://x',
          params: [],
          headers: [],
          body: { type: 'urlencoded', urlencoded: [{ id: 'u1', key: '{{k}}', value: '{{v}}', enabled: true }] }
        },
        vars
      )
      assert.equal(urlencoded.body.urlencoded[0].key, 'fieldX')
      assert.equal(urlencoded.body.urlencoded[0].value, 'valY')
    })

    // --- curl: парсер (lib/curl.js) ---

    await check('parseCurl: типичная команда -X/-H/-d json', () => {
      const snapshot = curl.parseCurl(
        `curl -X POST 'https://api.example.com/users' -H 'Authorization: Bearer t-1' -H 'Content-Type: application/json' -d '{"name":"Ann"}'`
      )
      assert.equal(snapshot.method, 'POST')
      assert.equal(snapshot.url, 'https://api.example.com/users')
      assert.equal(snapshot.headers.length, 2)
      assert.equal(snapshot.headers[0].key, 'Authorization')
      assert.equal(snapshot.headers[0].value, 'Bearer t-1')
      assert.equal(snapshot.body.type, 'json')
      assert.equal(snapshot.body.json, '{"name":"Ann"}')
    })

    await check('parseCurl: двойные кавычки с экранированием и многострочный перенос', () => {
      const snapshot = curl.parseCurl(
        'curl "https://api.example.com/x" \\\n  -H "X-Note: \\"quoted\\"" \\\n  -d \'plain\''
      )
      assert.equal(snapshot.url, 'https://api.example.com/x')
      const note = snapshot.headers.find((h) => h.key === 'X-Note')
      assert.equal(note.value, '"quoted"')
      assert.equal(snapshot.method, 'POST')
    })

    await check('parseCurl: -d без метода даёт POST, Content-Type по умолчанию curl', () => {
      const snapshot = curl.parseCurl(`curl https://api.example.com -d 'a=1&b=2'`)
      assert.equal(snapshot.method, 'POST')
      assert.equal(snapshot.body.type, 'text')
      assert.equal(snapshot.body.text, 'a=1&b=2')
      const ct = snapshot.headers.find((h) => h.key === 'Content-Type')
      assert.equal(ct.value, 'application/x-www-form-urlencoded')
    })

    await check('parseCurl: -u → basic, -b → Cookie', () => {
      const snapshot = curl.parseCurl(`curl -u user:pass -b 'k=v' https://api.example.com`)
      assert.equal(snapshot.auth.type, 'basic')
      assert.equal(snapshot.auth.username, 'user')
      assert.equal(snapshot.auth.password, 'pass')
      const cookie = snapshot.headers.find((h) => h.key === 'Cookie')
      assert.equal(cookie.value, 'k=v')
    })

    await check('parseCurl: -G переносит -d в query-параметры', () => {
      const snapshot = curl.parseCurl(`curl -G https://api.example.com -d 'page=2' -d 'limit=10'`)
      assert.equal(snapshot.method, 'GET')
      assert.equal(snapshot.body.type, 'none')
      assert.equal(snapshot.params.length, 2)
      assert.equal(snapshot.params[0].key, 'page')
      assert.equal(snapshot.params[1].value, '10')
    })

    await check('parseCurl: слитные формы -XPOST и --request=POST', () => {
      assert.equal(curl.parseCurl(`curl -XPOST https://x.test`).method, 'POST')
      assert.equal(curl.parseCurl(`curl --request=POST https://x.test`).method, 'POST')
    })

    await check('parseCurl: ошибка без URL и --json → тело json', () => {
      assert.throws(() => curl.parseCurl(`curl -X GET`), /не найден URL/)
      const json = curl.parseCurl(`curl --json '{"a":1}' https://x.test`)
      assert.equal(json.body.type, 'json')
      assert.equal(json.body.json, '{"a":1}')
      const ct = json.headers.find((h) => h.key === 'Content-Type')
      assert.equal(ct.value, 'application/json')
    })

    // --- curl: генератор ---

    await check('generateCurl: auth+тело, basic, экранирование, {{var}} литерально', () => {
      const command = curl.generateCurl({
        method: 'POST',
        url: '{{baseUrl}}/users',
        params: [{ id: 'p1', key: 'page', value: '2', enabled: true }],
        headers: [{ id: 'h1', key: 'X-Note', value: `it's fine`, enabled: true }],
        body: { type: 'json', json: '{"name":"Ann"}', form: [], urlencoded: [], text: '' },
        auth: { type: 'bearer', token: 't-1' },
        sslVerify: true
      })
      assert.ok(command.includes(`-X POST`))
      assert.ok(command.includes(`'{{baseUrl}}/users?page=2'`), 'params в URL, {{var}} литерально')
      assert.ok(command.includes(`-H 'Authorization: Bearer t-1'`))
      assert.ok(command.includes(`-H 'Content-Type: application/json'`))
      assert.ok(command.includes(`-d '{"name":"Ann"}'`))
      assert.ok(command.includes(`'X-Note: it'\\''s fine'`), 'экранирование одинарной кавычки')

      const basic = curl.generateCurl({
        method: 'GET',
        url: 'https://x.test',
        params: [],
        headers: [],
        body: { type: 'none' },
        auth: { type: 'basic', username: 'user', password: 'p@ss' },
        sslVerify: true
      })
      assert.ok(basic.includes(`-u 'user:p@ss'`))
      assert.ok(!basic.includes('-X'), 'GET без -X')
    })

    await check('generateCurl: urlencoded → --data-urlencode, form-data → -F, GET без тела', () => {
      const urlencoded = curl.generateCurl({
        method: 'POST',
        url: 'https://x.test/token',
        params: [],
        headers: [],
        body: { type: 'urlencoded', json: '', form: [], text: '', urlencoded: [
          { id: 'u1', key: 'grant_type', value: 'client_credentials', enabled: true },
          { id: 'u2', key: 'skip', value: 'x', enabled: false }
        ] },
        auth: { type: 'none' },
        sslVerify: true
      })
      assert.ok(urlencoded.includes(`--data-urlencode 'grant_type=client_credentials'`))
      assert.ok(!urlencoded.includes('skip'))

      const form = curl.generateCurl({
        method: 'POST',
        url: 'https://x.test',
        params: [],
        headers: [],
        body: { type: 'form-data', json: '', text: '', urlencoded: [], form: [
          { id: 'f1', key: 'field1', value: 'value1', enabled: true }
        ] },
        auth: { type: 'none' },
        sslVerify: true
      })
      assert.ok(form.includes(`-F 'field1=value1'`))

      const getWithBody = curl.generateCurl({
        method: 'GET',
        url: 'https://x.test',
        params: [],
        headers: [],
        body: { type: 'json', json: '{"x":1}', form: [], urlencoded: [], text: '' },
        auth: { type: 'none' },
        sslVerify: true
      })
      assert.ok(!getWithBody.includes('-d'), 'GET не несёт тела')
    })

    // Characterize: точный вывод generateCurl на момент выноса общих помощников экспорта
    // (lib/snippets.js пользуется ими же). Строки сняты с реализации до её правки.
    await check('generateCurl: characterize — точный вывод (порядок -H, авто Content-Type, -u, query)', () => {
      assert.equal(
        curl.generateCurl({
          method: 'POST',
          url: '{{baseUrl}}/users',
          params: [{ id: 'p1', key: 'page', value: '2', enabled: true }],
          headers: [{ id: 'h1', key: 'X-Note', value: `it's fine`, enabled: true }],
          body: { type: 'json', json: '{"name":"Ann"}', form: [], urlencoded: [], text: '' },
          auth: { type: 'bearer', token: 't-1' },
          sslVerify: true
        }),
        `curl '{{baseUrl}}/users?page=2' -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer t-1' -H 'X-Note: it'\\''s fine' -d '{"name":"Ann"}'`
      )
      assert.equal(
        curl.generateCurl({
          method: 'PUT',
          url: 'https://x.test/items/1',
          params: [],
          headers: [
            { id: 'h1', key: 'Content-Type', value: 'application/x-www-form-urlencoded; charset=utf-8', enabled: true },
            { id: 'h2', key: 'X-Skip', value: 'no', enabled: false },
            { id: 'h3', key: '', value: 'no-name', enabled: true }
          ],
          body: { type: 'urlencoded', json: '', form: [], text: '', urlencoded: [
            { id: 'u1', key: 'a', value: '1', enabled: true },
            { id: 'u2', key: 'b', value: 'x y', enabled: true }
          ] },
          auth: { type: 'apikey', key: 'X-Api-Key', value: 'k-1', placement: 'header' },
          sslVerify: true
        }),
        `curl 'https://x.test/items/1' -X PUT -H 'X-Api-Key: k-1' -H 'Content-Type: application/x-www-form-urlencoded; charset=utf-8' --data-urlencode 'a=1' --data-urlencode 'b=x y'`
      )
      assert.equal(
        curl.generateCurl({
          method: 'POST',
          url: 'https://x.test/notes',
          params: [],
          headers: [{ id: 'h1', key: 'content-type', value: 'text/markdown', enabled: true }],
          body: { type: 'text', json: '', form: [], urlencoded: [], text: 'hello' },
          auth: { type: 'basic', username: 'user', password: 'p@ss' },
          sslVerify: true
        }),
        `curl 'https://x.test/notes' -X POST -u 'user:p@ss' -H 'content-type: text/markdown' -d 'hello'`
      )
      assert.equal(
        curl.generateCurl({
          method: 'POST',
          url: 'https://x.test/upload?existing=1',
          params: [{ id: 'p1', key: 'page', value: '2', enabled: true }],
          headers: [{ id: 'h1', key: 'X-Trace', value: 'abc', enabled: true }],
          body: { type: 'form-data', json: '', text: '', urlencoded: [], form: [
            { id: 'f1', key: 'field1', value: 'value1', enabled: true }
          ] },
          auth: { type: 'apikey', key: 'api_key', value: 'k-1', placement: 'query' },
          sslVerify: true
        }),
        `curl 'https://x.test/upload?existing=1&page=2&api_key=k-1' -X POST -H 'X-Trace: abc' -F 'field1=value1'`
      )
      assert.equal(
        curl.generateCurl({
          method: 'HEAD',
          url: 'https://x.test/ping',
          params: [],
          headers: [],
          body: { type: 'json', json: '{"x":1}', form: [], urlencoded: [], text: '' },
          auth: { type: 'bearer', token: 't-1' },
          sslVerify: true
        }),
        `curl 'https://x.test/ping' -X HEAD -H 'Authorization: Bearer t-1'`
      )
    })

    await check('curl round-trip: parse(generate(snapshot)) воспроизводит запрос', () => {
      const original = {
        name: 'Demo',
        method: 'POST',
        url: 'https://api.example.com/token?page=2',
        params: [{ id: 'p1', key: 'page', value: '2', enabled: true }],
        headers: [
          { id: 'h1', key: 'X-Trace', value: 'abc', enabled: true },
          { id: 'h2', key: 'X-Skip', value: 'no', enabled: false }
        ],
        body: { type: 'urlencoded', json: '', form: [], text: '', urlencoded: [
          { id: 'u1', key: 'grant_type', value: 'client_credentials', enabled: true },
          { id: 'u2', key: 'client_id', value: 'ab c&d', enabled: true }
        ] },
        auth: { type: 'basic', username: 'user', password: 'pass word' },
        sslVerify: true
      }
      const command = curl.generateCurl(original)
      const parsed = curl.parseCurl(command)
      assert.equal(parsed.method, 'POST')
      // Эффективный URL: оригинал отправлял бы query из URL + params таблицы (дубль page=2);
      // после round-trip параметры живут в URL — эффективный запрос тот же.
      assert.equal(parsed.url, 'https://api.example.com/token?page=2&page=2', 'эффективный URL сохранён')
      assert.equal(parsed.params.length, 0, 'params переехали в URL при re-import')
      const trace = parsed.headers.find((h) => h.key === 'X-Trace')
      assert.equal(trace.value, 'abc')
      assert.ok(!parsed.headers.some((h) => h.key === 'X-Skip'), 'выключенный заголовок не экспортируется')
      assert.equal(parsed.body.type, 'urlencoded')
      const grant = parsed.body.urlencoded.find((r) => r.key === 'grant_type')
      assert.equal(grant.value, 'client_credentials')
      const clientId = parsed.body.urlencoded.find((r) => r.key === 'client_id')
      assert.equal(clientId.value, 'ab c&d', '--data-urlencode ↔ URLSearchParams кодирование согласовано')
      assert.equal(parsed.auth.type, 'basic')
      assert.equal(parsed.auth.password, 'pass word')
    })

    // --- Сниппеты кода (lib/snippets.js) ---
    // Текст сниппета — строки с одним завершающим переводом строки.
    const snippetText = (...lines) => `${lines.join('\n')}\n`
    const LANGS = ['fetch', 'axios', 'python']
    // Канонический снимок из design D4 (change add-code-snippets).
    const canonical = {
      method: 'POST',
      url: '{{baseUrl}}/users',
      params: [],
      headers: [],
      body: { type: 'json', json: '{"name":"Ann"}', form: [], urlencoded: [], text: '' },
      auth: { type: 'bearer', token: 't-1' }
    }
    const snippet = (snapshot, lang) => snippets.generateSnippet(snapshot, lang)

    await check('generateSnippet: метод, URL с params и apikey (сценарии спеки)', () => {
      const plain = { method: 'PUT', url: 'https://x.test/items/1', params: [], headers: [], body: { type: 'none' }, auth: { type: 'none' } }
      assert.ok(snippet(plain, 'fetch').includes(`method: 'PUT'`))
      assert.ok(snippet(plain, 'axios').includes(`method: 'put'`))
      assert.ok(snippet(plain, 'python').includes(`requests.put(`))
      assert.ok(
        snippet({ ...plain, method: 'PROPFIND' }, 'python').includes(`requests.request('PROPFIND', url)`),
        'метод без короткой формы — через requests.request'
      )

      const withParams = {
        ...plain,
        method: 'GET',
        url: 'https://api.example.com/users',
        params: [
          { id: 'p1', key: 'page', value: '2', enabled: true },
          { id: 'p2', key: 'token', value: 'abc', enabled: false }
        ]
      }
      for (const lang of LANGS) {
        const text = snippet(withParams, lang)
        assert.ok(text.includes(`'https://api.example.com/users?page=2'`), `${lang}: params в URL`)
        assert.ok(!text.includes('token=abc'), `${lang}: выключенный параметр не переносится`)
      }

      const apikeyQuery = { ...withParams, params: [], auth: { type: 'apikey', key: 'api_key', value: 'k-1', placement: 'query' } }
      const apikeyHeader = { ...withParams, params: [], auth: { type: 'apikey', key: 'X-Api-Key', value: 'k-1', placement: 'header' } }
      for (const lang of LANGS) {
        const query = snippet(apikeyQuery, lang)
        assert.ok(query.includes(`'https://api.example.com/users?api_key=k-1'`), `${lang}: apikey в query`)
        assert.ok(!query.includes(`'api_key':`), `${lang}: apikey в query не дублируется заголовком`)
        assert.ok(snippet(apikeyHeader, lang).includes(`'X-Api-Key': 'k-1'`), `${lang}: apikey заголовком`)
        const bearer = snippet({ ...withParams, auth: { type: 'bearer', token: 't-1' } }, lang)
        assert.ok(bearer.includes(`'Authorization': 'Bearer t-1'`), `${lang}: bearer`)
        assert.equal(bearer.split('Authorization').length - 1, 1, `${lang}: bearer без дубликата Authorization`)
      }
    })

    await check('generateSnippet: авто и пользовательский Content-Type, выключенные строки, GET/HEAD без тела, неизвестный язык', () => {
      const json = { method: 'POST', url: 'https://x.test', params: [], headers: [], body: { type: 'json', json: '{"a":1}' }, auth: { type: 'none' } }
      for (const lang of LANGS) {
        const text = snippet(json, lang)
        assert.equal(text.split('Content-Type').length - 1, 1, `${lang}: ровно один Content-Type`)
        assert.ok(text.includes(`'Content-Type': 'application/json'`), `${lang}: авто Content-Type для json`)
        for (const verb of ['GET', 'HEAD']) {
          const bodyless = snippet({ ...json, method: verb }, lang)
          assert.ok(!bodyless.includes('Content-Type'), `${lang}: ${verb} без авто Content-Type`)
          assert.ok(!bodyless.includes('{"a":1}'), `${lang}: ${verb} без тела`)
        }
      }

      const custom = snippet(
        { ...json, headers: [{ id: 'h1', key: 'Content-Type', value: 'application/vnd.api+json', enabled: true }] },
        'fetch'
      )
      assert.ok(custom.includes(`'Content-Type': 'application/vnd.api+json'`))
      assert.ok(!custom.includes('application/json'), 'пользовательский Content-Type не дублируется автоматическим')

      const noisy = snippet({ ...json, headers: [
        { id: 'h1', key: 'X-Skip', value: 'no', enabled: false },
        { id: 'h2', key: '', value: 'no-name', enabled: true },
        { id: 'h3', key: 'X-Keep', value: 'yes', enabled: true }
      ] }, 'fetch')
      assert.ok(noisy.includes(`'X-Keep': 'yes'`))
      assert.ok(!noisy.includes('X-Skip') && !noisy.includes('no-name'), 'выключенный заголовок и строка без имени не переносятся')

      assert.throws(() => snippet(json, 'go'), /Неизвестный язык сниппета: go/)
      assert.deepEqual(snippets.SNIPPET_LANGS.map((lang) => lang.value), LANGS)
    })

    await check('generateSnippet: экранирование литералов — JS и Python разворачиваются в исходный текст', async () => {
      // Fetch исполняется с подменённым fetch: снимок синтаксиса и реальных значений аргументов.
      const runStubbed = async (code) => {
        let captured
        await runInNewContext(`(async () => {\n${code}\n})()`, {
          fetch: async (url, init) => {
            captured = { url, init }
            return { status: 200, text: async () => 'ok' }
          },
          console: { log () {} }
        })
        return captured
      }
      // Axios не импортируется в smoke: строка import снимается, остальное должно парситься.
      const parseAxios = (code) => new Function(`return (async () => {\n${code.replace(/^import .*$/m, '')}\n})`)

      // В значении есть ' → литерал в двойных кавычках, ровно JSON-форма.
      const nasty = 'it\'s "quoted" \\ ${x}\n\tконец\u0001'
      const jsonLiteral = JSON.stringify(nasty)
      const nastySnapshot = {
        ...canonical,
        headers: [{ id: 'h1', key: 'X-Note', value: nasty, enabled: true }]
      }
      const generated = Object.fromEntries(LANGS.map((lang) => [lang, snippet(nastySnapshot, lang)]))
      for (const lang of LANGS) {
        assert.ok(generated[lang].includes(jsonLiteral), `${lang}: литерал JSON-формы`)
      }
      parseAxios(generated.axios)
      assert.equal((await runStubbed(generated.fetch)).init.headers['X-Note'], nasty, 'fetch: литерал разворачивается в исходный текст')

      // Одинарных кавычек нет → литерал в одинарных: двойные внутри не экранируются.
      const quoted = 'a "quoted" \\ value'
      const singleLiteral = `'a "quoted" \\\\ value'`
      const quotedSnapshot = { ...nastySnapshot, headers: [{ id: 'h1', key: 'X-Note', value: quoted, enabled: true }] }
      for (const lang of LANGS) {
        assert.ok(snippet(quotedSnapshot, lang).includes(singleLiteral), `${lang}: литерал в одинарных кавычках`)
      }
      const captured = await runStubbed(snippet(quotedSnapshot, 'fetch'))
      assert.equal(captured.init.headers['X-Note'], quoted)
      assert.equal(captured.init.body, '{"name":"Ann"}', 'тело json читается без экранированных кавычек')
    })

    await check('generateSnippet: json/text сырой строкой, urlencoded и form-data парами', () => {
      // Тело переносится байт в байт: лишний пробел и невалидный JSON не перестраиваются.
      for (const raw of ['{"name" :"Ann"}', '{"name":"Ann",}']) {
        const snapshot = { ...canonical, body: { type: 'json', json: raw } }
        assert.ok(snippet(snapshot, 'fetch').includes(`body: '${raw}'`), 'fetch: тело без изменений')
        assert.ok(snippet(snapshot, 'axios').includes(`data: '${raw}'`), 'axios: тело без изменений')
        assert.ok(snippet(snapshot, 'python').includes(`data='${raw}'`), 'python: тело без изменений')
      }
      const text = { ...canonical, url: 'https://x.test', body: { type: 'text', text: 'hello world' } }
      assert.ok(snippet(text, 'fetch').includes(`body: 'hello world'`))
      assert.ok(snippet(text, 'python').includes(`'Content-Type': 'text/plain'`))

      const urlencoded = { method: 'POST', url: 'https://x.test/token', params: [], headers: [], auth: { type: 'none' }, body: { type: 'urlencoded', urlencoded: [
        { id: 'u1', key: 'grant_type', value: 'client_credentials', enabled: true },
        { id: 'u2', key: 'client_id', value: 'ab c&d', enabled: true },
        { id: 'u3', key: 'skip', value: 'x', enabled: false }
      ] } }
      const urlFetch = snippet(urlencoded, 'fetch')
      assert.ok(urlFetch.includes(`body.append('grant_type', 'client_credentials')`))
      assert.ok(urlFetch.includes(`body.append('client_id', 'ab c&d')`), 'сырые значения: кодирует клиент при выполнении')
      assert.ok(!urlFetch.includes('skip'))
      assert.ok(urlFetch.includes(`'Content-Type': 'application/x-www-form-urlencoded'`))
      assert.ok(snippet(urlencoded, 'axios').includes(`data.append('client_id', 'ab c&d')`))
      const urlPython = snippet(urlencoded, 'python')
      assert.ok(urlPython.includes(`data={'grant_type': 'client_credentials', 'client_id': 'ab c&d'}`))
      assert.ok(!urlPython.includes('skip'))

      const formData = { ...urlencoded, url: 'https://x.test', body: { type: 'form-data', form: [
        { id: 'f1', key: 'field1', value: 'value1', enabled: true },
        { id: 'f2', key: 'field2', value: 'привет', enabled: true },
        { id: 'f3', key: 'skip', value: 'x', enabled: false }
      ] } }
      const formFetch = snippet(formData, 'fetch')
      assert.ok(formFetch.includes(`body.append('field1', 'value1')`))
      assert.ok(formFetch.includes(`body.append('field2', 'привет')`))
      assert.ok(!formFetch.includes('skip') && !formFetch.includes('Content-Type'), 'multipart: Content-Type ставит клиент')
      assert.ok(snippet(formData, 'axios').includes(`data.append('field2', 'привет')`) && !snippet(formData, 'axios').includes('Content-Type'))
      const formPython = snippet(formData, 'python')
      assert.ok(formPython.includes(`files={'field1': (None, 'value1'), 'field2': (None, 'привет')}`))
      assert.ok(!formPython.includes('skip') && !formPython.includes('Content-Type'))
    })

    await check('generateSnippet: basic-авторизация (fetch — заголовок, axios и python — опция клиента)', () => {
      const basic = { method: 'GET', url: 'https://x.test', params: [], headers: [], body: { type: 'none' }, auth: { type: 'basic', username: 'user', password: 'p@ss' } }
      assert.ok(snippet(basic, 'fetch').includes(`'Authorization': 'Basic dXNlcjpwQHNz'`))
      assert.ok(snippet(basic, 'axios').includes(`auth: { username: 'user', password: 'p@ss' }`))
      assert.ok(snippet(basic, 'python').includes(`auth=('user', 'p@ss')`))

      // Кириллический логин: base64 в UTF-8 совпадает с заголовком, который собирает main.
      const cyrillic = { ...basic, auth: { type: 'basic', username: 'логин', password: 'пароль' } }
      const expected = http.buildRequest(cyrillic).headers.find((h) => h.key === 'Authorization').value
      assert.ok(expected.startsWith('Basic '))
      assert.ok(snippet(cyrillic, 'fetch').includes(`'Authorization': '${expected}'`))

      // {{var}} в учётных данных: значение заранее не посчитать — btoa при выполнении сниппета.
      const withVars = { ...basic, auth: { type: 'basic', username: '{{user}}', password: '{{pass}}' } }
      assert.ok(snippet(withVars, 'fetch').includes(`'Authorization': 'Basic ' + btoa('{{user}}:{{pass}}')`))
      assert.ok(snippet(withVars, 'axios').includes(`auth: { username: '{{user}}', password: '{{pass}}' }`))
      assert.ok(snippet(withVars, 'python').includes(`auth=('{{user}}', '{{pass}}')`))
    })

    await check('generateSnippet: золотые тексты для снимка из design D4 (fetch, axios, python)', () => {
      assert.equal(snippet(canonical, 'fetch'), snippetText(
        "const response = await fetch('{{baseUrl}}/users', {",
        "  method: 'POST',",
        '  headers: {',
        "    'Content-Type': 'application/json',",
        "    'Authorization': 'Bearer t-1'",
        '  },',
        "  body: '{\"name\":\"Ann\"}'",
        '});',
        '',
        'console.log(response.status, await response.text());'
      ))
      assert.equal(snippet(canonical, 'axios'), snippetText(
        "import axios from 'axios';",
        '',
        'const response = await axios({',
        "  method: 'post',",
        "  url: '{{baseUrl}}/users',",
        '  headers: {',
        "    'Content-Type': 'application/json',",
        "    'Authorization': 'Bearer t-1'",
        '  },',
        "  data: '{\"name\":\"Ann\"}'",
        '});',
        '',
        'console.log(response.status, response.data);'
      ))
      assert.equal(snippet(canonical, 'python'), snippetText(
        'import requests',
        '',
        "url = '{{baseUrl}}/users'",
        '',
        'headers = {',
        "    'Content-Type': 'application/json',",
        "    'Authorization': 'Bearer t-1'",
        '}',
        '',
        "response = requests.post(url, headers=headers, data='{\"name\":\"Ann\"}')",
        '',
        'print(response.status_code, response.text)'
      ))

      // Сценарий спеки «Fetch с bearer и json-телом» — критерий приёмки issue #2.
      const specCase = snippet({ ...canonical, url: 'https://api.example.com/users' }, 'fetch')
      for (const part of [
        `fetch('https://api.example.com/users', {`,
        `'Authorization': 'Bearer t-1'`,
        `'Content-Type': 'application/json'`,
        `body: '{"name":"Ann"}'`
      ]) {
        assert.ok(specCase.includes(part), part)
      }

      // Без заголовков и авторизации секция headers опускается.
      const plain = { method: 'GET', url: 'https://x.test', params: [], headers: [], body: { type: 'none' }, auth: { type: 'none' } }
      assert.equal(snippet(plain, 'fetch'), snippetText(
        "const response = await fetch('https://x.test', {",
        "  method: 'GET'",
        '});',
        '',
        'console.log(response.status, await response.text());'
      ))
      assert.ok(!snippet(plain, 'axios').includes('headers'))
      const plainPython = snippet(plain, 'python')
      assert.ok(!plainPython.includes('headers') && plainPython.includes('requests.get(url)'))
    })

    await check('generateSnippet: {{var}} литерально, дубли имён заголовков схлопываются (побеждает последний)', () => {
      // Переменные не подставляются ни в одном поле — сниппет показывает запрос, а не окружение.
      const templated = {
        method: 'POST',
        url: '{{baseUrl}}/users',
        params: [{ id: 'p1', key: 'page', value: '{{page}}', enabled: true }],
        headers: [{ id: 'h1', key: 'X-Token', value: '{{token}}', enabled: true }],
        body: { type: 'json', json: '{"id":"{{id}}"}' },
        auth: { type: 'bearer', token: '{{bearer}}' }
      }
      for (const lang of LANGS) {
        const text = snippet(templated, lang)
        for (const name of ['{{baseUrl}}', '{{page}}', '{{token}}', '{{id}}', '{{bearer}}']) {
          assert.ok(text.includes(name), `${lang}: ${name} литерально`)
        }
      }

      // Пользовательский заголовок перекрывает авторский (имя без учёта регистра).
      const overridden = { ...canonical, url: 'https://x.test', headers: [{ id: 'h1', key: 'authorization', value: 'Custom x', enabled: true }] }
      for (const lang of LANGS) {
        const text = snippet(overridden, lang)
        assert.equal((text.match(/authorization'/gi) ?? []).length, 1, `${lang}: одно имя authorization`)
        assert.ok(text.includes(`'authorization': 'Custom x'`), `${lang}: побеждает пользовательский`)
        assert.ok(!text.includes('Bearer t-1'))
      }
      const twins = { ...canonical, url: 'https://x.test', auth: { type: 'none' }, headers: [
        { id: 'h1', key: 'X-A', value: '1', enabled: true },
        { id: 'h2', key: 'x-a', value: '2', enabled: true }
      ] }
      assert.ok(snippet(twins, 'fetch').includes(`'x-a': '2'`) && !snippet(twins, 'fetch').includes(`'X-A': '1'`))
      assert.ok(snippet(twins, 'python').includes(`'x-a': '2'`) && !snippet(twins, 'python').includes(`'X-A': '1'`))
    })

    // Fetch-сниппет исполняется как ES-модуль из data:-URL (top-level await). Статус и тело
    // ответа сниппет печатает — вывод перехватываем, чтобы сравнить echo с отправкой sendRequest.
    const runFetchSnippet = async (code) => {
      const printed = []
      const originalLog = console.log
      console.log = (...args) => printed.push(args)
      try {
        await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
      } finally {
        console.log = originalLog
      }
      assert.equal(printed.length, 1, 'сниппет один раз выводит статус и тело ответа')
      const [status, text] = printed[0]
      return { status, echo: JSON.parse(text) }
    }
    const appEcho = async (snapshot, id) => JSON.parse((await http.sendRequest(snapshot, id)).body)
    // Тело здесь не сравнивается: у urlencoded и multipart на проводе оно кодируется клиентом
    // (пробел → +, свой boundary) — пары и поля сверяются отдельно. Заголовки из skipHeaders
    // исключаются: их тоже добавляет клиент (content-type multipart, content-length).
    const requestLine = (echo, ...skipHeaders) => {
      const headers = { ...echo.headers }
      for (const name of skipHeaders) delete headers[name]
      return { method: echo.method, url: echo.url, headers }
    }

    await check('fetch-сниппет отправляет тот же запрос, что sendRequest (json, text, basic, urlencoded, form-data)', async () => {
      const solid = [
        ['json', { method: 'POST', url: `${base}/users`, params: [{ id: 'p1', key: 'page', value: '2', enabled: true }], headers: [{ id: 'h1', key: 'X-Trace', value: 'abc', enabled: true }], body: { type: 'json', json: '{"name":"Ann"}' }, auth: { type: 'bearer', token: 't-1' } }],
        ['text', { method: 'PUT', url: `${base}/notes`, params: [], headers: [], body: { type: 'text', text: 'hello world' }, auth: { type: 'none' } }],
        ['basic', { method: 'POST', url: `${base}/login`, params: [], headers: [], body: { type: 'json', json: '{}' }, auth: { type: 'basic', username: 'логин', password: 'пароль' } }]
      ]
      for (const [name, snapshot] of solid) {
        const { status, echo } = await runFetchSnippet(snippet(snapshot, 'fetch'))
        assert.equal(status, 201, `${name}: сниппет вывел статус ответа`)
        assert.deepEqual(echo, await appEcho(snapshot, `smoke-snippet-${name}`), `${name}: метод, URL, заголовки и тело совпадают с отправкой приложения`)
      }

      // urlencoded: кодировка на проводе своя (пробел → +), декодированные пары те же.
      const urlencoded = { method: 'POST', url: `${base}/token`, params: [], headers: [], auth: { type: 'none' }, body: { type: 'urlencoded', urlencoded: [
        { id: 'u1', key: 'grant_type', value: 'client_credentials', enabled: true },
        { id: 'u2', key: 'client_id', value: 'ab c&d', enabled: true }
      ] } }
      const { echo: urlEcho } = await runFetchSnippet(snippet(urlencoded, 'fetch'))
      const urlApp = await appEcho(urlencoded, 'smoke-snippet-urlencoded')
      assert.deepEqual([...new URLSearchParams(urlEcho.body)], [...new URLSearchParams(urlApp.body)])
      assert.deepEqual(requestLine(urlEcho, 'content-length'), requestLine(urlApp, 'content-length'))

      // multipart: boundary у клиента свой — сравниваем декодированные поля.
      const parseMultipart = ({ headers, body }) => {
        const boundary = /boundary=([^;]+)/.exec(headers['content-type'])[1]
        return body
          .split(`--${boundary}`)
          .slice(1, -1)
          .map((part) => {
            const [head, ...rest] = part.trim().split('\r\n\r\n')
            return [/name="([^"]*)"/.exec(head)[1], rest.join('\r\n\r\n')]
          })
      }
      const formData = { method: 'POST', url: `${base}/upload`, params: [], headers: [], auth: { type: 'none' }, body: { type: 'form-data', form: [
        { id: 'f1', key: 'field1', value: 'value1', enabled: true },
        { id: 'f2', key: 'field2', value: 'привет мир', enabled: true },
        { id: 'f3', key: 'skip', value: 'x', enabled: false }
      ] } }
      const { echo: formEcho } = await runFetchSnippet(snippet(formData, 'fetch'))
      const formApp = await appEcho(formData, 'smoke-snippet-form-data')
      assert.ok(formEcho.headers['content-type'].startsWith('multipart/form-data; boundary='), 'Content-Type с boundary поставил клиент')
      assert.deepEqual(parseMultipart(formEcho), [['field1', 'value1'], ['field2', 'привет мир']])
      assert.deepEqual(parseMultipart(formEcho), parseMultipart(formApp))
      assert.deepEqual(requestLine(formEcho, 'content-type', 'content-length'), requestLine(formApp, 'content-type', 'content-length'))
    })

    await check('axios-сниппет синтаксически корректен (import + async-стрелка парсятся)', () => {
      const cases = [
        canonical,
        { method: 'POST', url: 'https://x.test', params: [], headers: [], body: { type: 'urlencoded', urlencoded: [{ id: 'u1', key: 'a', value: 'b c', enabled: true }] }, auth: { type: 'none' } },
        { method: 'POST', url: 'https://x.test', params: [], headers: [], body: { type: 'form-data', form: [{ id: 'f1', key: 'a', value: 'b', enabled: true }] }, auth: { type: 'none' } },
        { method: 'GET', url: 'https://x.test', params: [], headers: [], body: { type: 'none' }, auth: { type: 'basic', username: 'u', password: 'p' } },
        { ...canonical, headers: [{ id: 'h1', key: 'X-Note', value: 'it\'s "quoted" \\ ${x}\n', enabled: true }] }
      ]
      for (const snapshot of cases) {
        const code = snippet(snapshot, 'axios')
        assert.ok(code.startsWith("import axios from 'axios';\n"), 'сниппет начинается с подключения клиента')
        assert.doesNotThrow(() => new Function(`return (async () => {\n${code.replace(/^import .*$/m, '')}\n})`))
      }
    })
  } finally {
    await closeServer()
  }

  // --- MCP-сервер: транспорт, токен и инструменты (src/main/mcp.js) ---
  // Отдельный корень хранилища: проверяем дефолты настроек на «старом» settings.json без секции mcp.

  const mcpRoot = await mkdtemp(join(tmpdir(), 'postman-lite-smoke-mcp-'))
  storage.initStorage(mcpRoot)
  await storage.bootstrap()

  const takeFreePort = async () => {
    const s = createServer()
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
    const port = s.address().port
    await new Promise((resolve) => s.close(resolve))
    return port
  }

  const mcpPort = await takeFreePort()

  try {
    await check('Настройки: старый settings.json без секции mcp получает дефолты', async () => {
      const settings = await storage.getSettings()
      assert.deepEqual(settings.mcp, { enabled: false, port: 45460, token: null })
    })

    await check('Включение поднимает слушателя на 127.0.0.1, генерирует и сохраняет токен', async () => {
      const status = await mcp.applyMcpConfig({ mcp: { enabled: true, port: mcpPort, token: null } })
      assert.equal(status.state, 'running')
      assert.equal(status.address, `http://127.0.0.1:${mcpPort}/mcp`)
      assert.ok(status.token)
      assert.equal((await storage.getSettings()).mcp.token, status.token)
    })

    const mcpToken = (await storage.getSettings()).mcp.token
    const mcpCall = async (body, token) =>
      fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body)
      })
    const mcpTool = async (name, args) => {
      const res = await mcpCall(
        { jsonrpc: '2.0', id: Math.random(), method: 'tools/call', params: { name, arguments: args } },
        mcpToken
      )
      const envelope = await res.json()
      return JSON.parse(envelope.result.content[0].text)
    }

    await check('Токен обязателен: без него и с неверным — 401, с верным — ответ', async () => {
      assert.equal((await mcpCall({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
      assert.equal((await mcpCall({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'nope')).status, 401)
      const res = await mcpCall({ jsonrpc: '2.0', id: 1, method: 'ping' }, mcpToken)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 1, result: {} })
    })

    await check('Рукопожатие initialize (включая более новую ревизию клиента), уведомление 202, неизвестный метод', async () => {
      let res = await mcpCall(
        { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'smoke', version: '0' } } },
        mcpToken
      )
      const init = await res.json()
      assert.equal(init.result.protocolVersion, '2025-06-18')
      assert.ok(init.result.capabilities.tools)
      assert.equal(init.result.serverInfo.name, 'request-lite')
      // Клиент с более новой ревизией получает последнюю поддерживаемую нами (а не ошибку):
      // по спеке согласование — ответ сервера, решение о совместимости за клиентом.
      res = await mcpCall(
        { jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
        mcpToken
      )
      assert.equal((await res.json()).result.protocolVersion, '2025-06-18')
      res = await mcpCall({ jsonrpc: '2.0', method: 'notifications/initialized' }, mcpToken)
      assert.equal(res.status, 202)
      res = await mcpCall({ jsonrpc: '2.0', id: 3, method: 'no/such' }, mcpToken)
      assert.equal((await res.json()).error.code, -32601)
    })

    await check('tools/list отдаёт все инструменты с именем, описанием и схемой входа', async () => {
      const res = await mcpCall({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, mcpToken)
      const tools = (await res.json()).result.tools
      assert.equal(tools.length, 12)
      assert.ok(tools.every((tool) => tool.name && tool.description && tool.inputSchema))
    })

    await check('Инструменты чтения: список проектов, «не найдено» для чужого id', async () => {
      const project = await storage.createProject('MCP Demo')
      const out = await mcpTool('list_projects', {})
      assert.equal(out.ok, true)
      assert.equal(out.data.find((p) => p.id === project.id).name, 'MCP Demo')
      const missing = await mcpTool('get_request', { projectId: project.id, requestId: 'nope' })
      assert.equal(missing.ok, false)
      assert.match(missing.error.message, /не найден/)
    })

    await check('Мутации: создание/обновление/окружение; заблокированный защищён', async () => {
      const project = (await storage.listProjects())[0]
      await storage.saveEnvironment(project.id, { id: 'env-mcp', name: 'Local', variables: [] })
      let out = await mcpTool('create_request', {
        projectId: project.id,
        request: { name: 'Echo', method: 'GET', url: 'http://x/echo' }
      })
      assert.equal(out.ok, true)
      const requestId = out.data.find((r) => r.name === 'Echo').id
      out = await mcpTool('update_request', {
        projectId: project.id,
        request: { id: requestId, name: 'Echo-2', url: 'http://x/echo2' }
      })
      assert.equal(out.ok, true)
      assert.equal(out.data.find((r) => r.id === requestId).name, 'Echo-2')
      out = await mcpTool('set_active_environment', { projectId: project.id, environmentId: 'env-mcp' })
      assert.equal(out.ok, true)
      await storage.setRequestLocked(project.id, requestId, true)
      const upd = await mcpTool('update_request', { projectId: project.id, request: { id: requestId, name: 'Hacked' } })
      assert.equal(upd.ok, false)
      assert.match(upd.error.message, /заблокирован/)
      const del = await mcpTool('delete_request', { projectId: project.id, requestId })
      assert.equal(del.ok, false)
      assert.match(del.error.message, /заблокирован/)
      await storage.setRequestLocked(project.id, requestId, false)
      out = await mcpTool('delete_request', { projectId: project.id, requestId })
      assert.equal(out.ok, true)
    })

    // Мини echo-сервер для инструментов отправки (JSON-эхо + большой маршрут).
    const echo = createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('x'.repeat(300 * 1024))
        return
      }
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () =>
        res.end(
          JSON.stringify({
            url: req.url,
            method: req.method,
            body: Buffer.concat(chunks).toString('utf8'),
            header: req.headers['x-mcp'] ?? null
          })
        )
      )
    })
    await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const echoBase = `http://127.0.0.1:${echo.address().port}`

    try {
      await check('send_request подставляет {{var}} активного окружения; усечение и сетевые ошибки', async () => {
        const project = (await storage.listProjects())[0]
        await storage.saveEnvironment(project.id, {
          id: 'env-mcp',
          name: 'Local',
          variables: [{ key: 'baseUrl', value: echoBase, enabled: true }]
        })
        await storage.setActiveEnvironment(project.id, 'env-mcp')
        let out = await mcpTool('create_request', {
          projectId: project.id,
          request: {
            name: 'EchoApi',
            method: 'POST',
            url: '{{baseUrl}}/api',
            headers: [{ key: 'X-Mcp', value: 'zz', enabled: true }],
            body: { type: 'text', text: 'hi' }
          }
        })
        const requestId = out.data.find((r) => r.name === 'EchoApi').id
        out = await mcpTool('send_request', { projectId: project.id, requestId })
        assert.equal(out.ok, true)
        assert.equal(out.data.status, 200)
        const echoed = JSON.parse(out.data.body)
        assert.equal(echoed.url, '/api')
        assert.equal(echoed.method, 'POST')
        assert.equal(echoed.body, 'hi')
        assert.equal(echoed.header, 'zz')
        out = await mcpTool('send_adhoc', { method: 'GET', url: `${echoBase}/big` })
        assert.equal(out.ok, true)
        assert.equal(out.data.truncated, true)
        assert.ok(out.data.actualSize >= 300 * 1024)
        assert.ok(out.data.body.length <= 100 * 1024)
        const fail = await mcpTool('send_adhoc', { url: 'http://127.0.0.1:1/nope' })
        assert.equal(fail.ok, false)
        assert.equal(fail.error.code, 'NETWORK')
      })

      await check('send_request пишет историю запроса; ошибка и send_adhoc историю не меняют', async () => {
        const project = (await storage.listProjects())[0]
        let out = await mcpTool('create_request', {
          projectId: project.id,
          request: { name: 'EchoHist', method: 'GET', url: '{{baseUrl}}/hist' }
        })
        const requestId = out.data.find((r) => r.name === 'EchoHist').id
        // Пять параллельных отправок одного запроса: очередь хранилища не ломает файл истории.
        const sent = await Promise.all(
          Array.from({ length: 5 }, () => mcpTool('send_request', { projectId: project.id, requestId }))
        )
        assert.ok(sent.every((r) => r.ok === true))
        const entries = await storage.listResponseHistory(project.id, requestId)
        assert.equal(entries.length, 5, 'все отправки в истории, файл валиден')
        assert.equal(entries[0].response.status, 200)

        // Ошибка отправки сохранённого запроса историю не пополняет.
        out = await mcpTool('create_request', {
          projectId: project.id,
          request: { name: 'EchoFail', method: 'GET', url: 'http://127.0.0.1:1/nope' }
        })
        const failId = out.data.find((r) => r.name === 'EchoFail').id
        const failed = await mcpTool('send_request', { projectId: project.id, requestId: failId })
        assert.equal(failed.ok, false)
        assert.deepEqual(await storage.listResponseHistory(project.id, failId), [])

        // Произвольный запрос агента историю не пишет вовсе: файлов в каталоге проекта — два.
        await mcpTool('send_adhoc', { method: 'GET', url: `${echoBase}/hist` })
        const projectFiles = await readdir(join(mcpRoot, 'history', project.id))
        assert.equal(projectFiles.length, 2, 'только EchoHist и EchoFail; send_adhoc файл не создал')
      })

      await check('curl-инструменты: экспорт и импорт без записи на диск', async () => {
        const project = (await storage.listProjects())[0]
        let out = await mcpTool('create_request', {
          projectId: project.id,
          request: { name: 'CurlSrc', method: 'POST', url: 'https://api.example.com/token', body: { type: 'text', text: 'q=1' } }
        })
        const requestId = out.data.find((r) => r.name === 'CurlSrc').id
        out = await mcpTool('export_curl', { projectId: project.id, requestId })
        assert.equal(out.ok, true)
        assert.match(out.data, /^curl /)
        out = await mcpTool('import_curl', { curl: `curl -X POST https://x.dev/p -H 'X-K: v' -d 'a=1'` })
        assert.equal(out.ok, true)
        assert.equal(out.data.method, 'POST')
        assert.equal(out.data.url, 'https://x.dev/p')
      })
    } finally {
      echo.closeAllConnections()
      await new Promise((resolve) => echo.close(resolve))
    }

    await check('Смена порта на лету, занятый порт — «ошибка», выключение закрывает порт', async () => {
      const newPort = await takeFreePort()
      let status = await mcp.applyMcpConfig({ mcp: { enabled: true, port: newPort, token: mcpToken } })
      assert.equal(status.state, 'running')
      assert.equal(status.port, newPort)
      const old = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST' }).catch(() => null)
      assert.equal(old, null, 'старый порт закрыт')
      const blocker = createServer()
      await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
      const busyPort = blocker.address().port
      status = await mcp.applyMcpConfig({ mcp: { enabled: true, port: busyPort, token: mcpToken } })
      assert.equal(status.state, 'error')
      assert.match(status.message, /занят/)
      assert.equal((await storage.getSettings()).mcp.enabled, true, 'настройка включения не сбрасывается')
      status = await mcp.applyMcpConfig({ mcp: { enabled: false, port: busyPort, token: mcpToken } })
      assert.equal(status.state, 'stopped')
      blocker.closeAllConnections()
      await new Promise((resolve) => blocker.close(resolve))
    })
  } finally {
    await mcp.stopMcpServer()
    await rm(mcpRoot, { recursive: true, force: true })
  }

  // --- Мок-сервер: хранилище мок-проектов (секция в src/main/storage.js) ---

  const mockRoot = await mkdtemp(join(tmpdir(), 'postman-lite-smoke-mock-'))
  storage.initStorage(mockRoot)
  await storage.bootstrap()

  await check('createMockProject создаёт мок-проект и файл с пустыми маршрутами', async () => {
    const project = await storage.createMockProject('Demo')
    assert.equal(project.name, 'Demo')
    assert.ok(project.id)
    const file = JSON.parse(await readFile(join(mockRoot, 'mock-projects', `${project.id}.json`), 'utf8'))
    assert.deepEqual(file, { routes: [], defaultResponse: null })
    const index = JSON.parse(await readFile(join(mockRoot, 'mock-projects.json'), 'utf8'))
    assert.equal(index.length, 1)
  })

  await check('createMockProject отклоняет пустое имя', async () => {
    await assert.rejects(() => storage.createMockProject('   '), /пустым/)
  })

  await check('renameMockProject отклоняет пустое имя и неизвестный id', async () => {
    const project = (await storage.listMockProjects())[0]
    await assert.rejects(() => storage.renameMockProject(project.id, '  '), /пустым/)
    await assert.rejects(() => storage.renameMockProject('nope', 'X'), /не найден/)
  })

  await check('saveMockProjectConfig нормализует маршруты и пишет на диск', async () => {
    const project = (await storage.listMockProjects())[0]
    const stored = await storage.saveMockProjectConfig(project.id, {
      routes: [
        { id: 'r1', method: 'get', path: '/api/users', status: 200, headers: [{ id: 'h1', key: 'X-K', value: 'v' }], body: '{"ok":1}', delayMs: 0 },
        { method: null, path: '/any' }
      ],
      defaultResponse: { status: 404, body: null }
    })
    assert.equal(stored.routes[0].method, 'GET')
    assert.equal(stored.routes[0].headers[0].enabled, true)
    assert.equal(stored.routes[1].status, 200, 'статус по умолчанию 200')
    assert.equal(stored.routes[1].method, null)
    assert.equal(stored.routes[1].body, null)
    assert.deepEqual(stored.defaultResponse, { status: 404, body: null })
    const file = JSON.parse(await readFile(join(mockRoot, 'mock-projects', `${project.id}.json`), 'utf8'))
    assert.equal(file.routes.length, 2)
  })

  await check('saveMockProjectConfig отклоняет пустой путь и невалидный статус', async () => {
    const project = (await storage.listMockProjects())[0]
    await assert.rejects(() => storage.saveMockProjectConfig(project.id, { routes: [{ path: '   ' }] }), /маршрута не может быть пустым/)
    await assert.rejects(() => storage.saveMockProjectConfig(project.id, { routes: [{ path: '/x', status: 99 }] }), /100–599/)
    await assert.rejects(() => storage.saveMockProjectConfig(project.id, { routes: [{ path: '/x', delayMs: -5 }] }), /неотриц/)
    await assert.rejects(() => storage.saveMockProjectConfig('nope', { routes: [] }), /не найден/)
  })

  await check('renameMockProject сохраняет маршруты', async () => {
    const project = (await storage.listMockProjects())[0]
    await storage.renameMockProject(project.id, 'Переименованный')
    const list = await storage.listMockProjects()
    assert.equal(list[0].name, 'Переименованный')
    const config = await storage.getMockProject(project.id)
    assert.equal(config.routes.length, 2)
  })

  await check('getMockProject неизвестного id возвращает null', async () => {
    assert.equal(await storage.getMockProject('nope'), null)
  })

  await check('deleteMockProject удаляет запись индекса и файл', async () => {
    const project = (await storage.listMockProjects())[0]
    await storage.deleteMockProject(project.id)
    assert.deepEqual(await storage.listMockProjects(), [])
    await assert.rejects(() => readFile(join(mockRoot, 'mock-projects', `${project.id}.json`), 'utf8'), /ENOENT/)
  })

  // --- Мок-сервер: жизненный цикл, обработка запросов, журнал (src/main/mock.js) ---

  const mockPort = await takeFreePort()
  const mockProject = await storage.createMockProject('Server')
  const mockProject2 = await storage.createMockProject('Server 2')

  const mockFetch = (path, init) => fetch(`http://127.0.0.1:${mockPort}${path}`, init)
  let mockPort2 = null

  try {
    await check('старт на неизвестном мок-проекте — ошибка', async () => {
      await assert.rejects(() => mock.startMockServer({ projectId: 'nope', port: mockPort }), /не найден/)
    })

    await check('запуск сервера: статус running с адресом на 127.0.0.1', async () => {
      await storage.saveMockProjectConfig(mockProject.id, {
        routes: [
          { method: 'GET', path: '/api/users', status: 200, body: '{"users":[1]}' },
          { method: null, path: '/any', status: 204 }
        ],
        defaultResponse: { status: 418, body: '{"teapot":true}' }
      })
      const status = await mock.startMockServer({ projectId: mockProject.id, port: mockPort })
      assert.equal(status.state, 'running')
      assert.equal(status.address, `http://127.0.0.1:${mockPort}`)
      assert.equal(status.projectId, mockProject.id)
    })

    await check('лог пуст до первого запроса', async () => {
      assert.deepEqual(mock.getMockLog(), [])
    })

    await check('ответ по маршруту: статус, тело, content-type по умолчанию', async () => {
      const res = await mockFetch('/api/users')
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type'), /application\/json/)
      assert.deepEqual(await res.json(), { users: [1] })
    })

    await check('query-строка не влияет на матчинг', async () => {
      const res = await mockFetch('/api/users?x=1&y=2')
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { users: [1] })
    })

    await check('маршрут без метода отвечает на любой метод', async () => {
      const res = await mockFetch('/any', { method: 'POST', headers: { 'X-Custom': 'abc' }, body: '{"a":1}' })
      assert.equal(res.status, 204)
    })

    await check('неотматченный запрос — ответ по умолчанию', async () => {
      const res = await mockFetch('/missing')
      assert.equal(res.status, 418)
      assert.deepEqual(await res.json(), { teapot: true })
    })

    await check('заголовки маршрута попадают в ответ и перекрывают content-type', async () => {
      await mock.applyMockConfig({
        routes: [{ method: 'GET', path: '/plain', status: 200, headers: [{ key: 'Content-Type', value: 'text/plain' }, { key: 'X-Request-Id', value: 'mock-1' }], body: 'привет' }],
        defaultResponse: { status: 404, body: null }
      })
      const res = await mockFetch('/plain')
      assert.equal(res.headers.get('content-type'), 'text/plain')
      assert.equal(res.headers.get('x-request-id'), 'mock-1')
      assert.equal(await res.text(), 'привет')
      // возвращаем исходную конфигурацию для следующих проверок
      await mock.applyMockConfig({
        routes: [
          { method: 'GET', path: '/api/users', status: 200, body: '{"users":[1]}' },
          { method: null, path: '/any', status: 204 }
        ],
        defaultResponse: { status: 418, body: '{"teapot":true}' }
      })
    })

    await check('applyMockConfig меняет ответ без рестарта сервера', async () => {
      await mock.applyMockConfig({
        routes: [{ method: 'GET', path: '/api/users', status: 200, body: '{"v":2}' }],
        defaultResponse: { status: 418, body: '{"teapot":true}' }
      })
      const res = await mockFetch('/api/users')
      assert.deepEqual(await res.json(), { v: 2 })
      const status = await mock.applyMockConfig({ routes: [{ method: 'GET', path: '/api/users', status: 200, body: '{"users":[1]}' }], defaultResponse: { status: 418, body: '{"teapot":true}' } })
      assert.equal(status.state, 'running')
    })

    await check('задержка маршрута откладывает ответ', async () => {
      await mock.applyMockConfig({
        routes: [{ method: 'GET', path: '/slow', status: 200, body: '{"ok":1}', delayMs: 700 }],
        defaultResponse: null
      })
      const started = Date.now()
      const res = await mockFetch('/slow')
      assert.ok(Date.now() - started >= 650, 'ответ пришёл раньше задержки')
      assert.deepEqual(await res.json(), { ok: 1 })
      await mock.applyMockConfig({
        routes: [
          { method: 'GET', path: '/api/users', status: 200, body: '{"users":[1]}' },
          { method: null, path: '/any', status: 204 }
        ],
        defaultResponse: { status: 418, body: '{"teapot":true}' }
      })
    })

    await check('журнал: тело распарсено, заголовки сохранены, метод и путь на месте', async () => {
      const res = await mockFetch('/any?x=1', { method: 'POST', headers: { 'X-Custom': 'abc', 'content-type': 'application/json' }, body: '{"name":"Тест"}' })
      assert.equal(res.status, 204)
      const log = mock.getMockLog()
      assert.equal(log.length, 8)
      const last = log[log.length - 1]
      assert.equal(last.method, 'POST')
      assert.equal(last.url, '/any?x=1')
      assert.equal(last.headers['x-custom'], 'abc')
      assert.deepEqual(last.body, { name: 'Тест' })
      assert.ok(last.ts)
    })

    await check('журнал: тело без JSON хранится сырой строкой', async () => {
      await mockFetch('/api/users', { method: 'POST', body: 'plain text' })
      const last = mock.getMockLog().at(-1)
      assert.equal(last.body, 'plain text')
    })

    await check('занятый порт — статус error с сообщением, сервер не запущен', async () => {
      const blocker = createServer()
      await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
      const busyPort = blocker.address().port
      const status = await mock.startMockServer({ projectId: mockProject2.id, port: busyPort })
      assert.equal(status.state, 'error')
      assert.match(status.message, /занят/)
      blocker.closeAllConnections()
      await new Promise((resolve) => blocker.close(resolve))
      // Попытка занятого порта остановила предыдущий слушатель — поднимаем снова для следующих проверок.
      const restored = await mock.startMockServer({ projectId: mockProject.id, port: mockPort })
      assert.equal(restored.state, 'running')
    })

    await check('некорректный порт отклоняется валидацией', async () => {
      await assert.rejects(() => mock.startMockServer({ projectId: mockProject2.id, port: 80 }), /1024–65535/)
    })

    await check('журнал: лимит буфера вытесняет самые старые записи', async () => {
      mock.clearMockLog()
      // Последовательно: сотни параллельных fetch у undici рвутся с ECONNRESET (ограничение клиента, не сервера).
      for (let i = 0; i < 505; i += 1) await mockFetch(`/api/users?bulk=${i}`)
      const log = mock.getMockLog()
      assert.equal(log.length, 500)
      assert.equal(log[0].url, '/api/users?bulk=5', 'старейшие записи вытеснены')
      assert.equal(log[log.length - 1].url, '/api/users?bulk=504')
      assert.ok(!log.some((e) => e.url === '/api/users?bulk=0'))
    })

    await check('clear обнуляет журнал', async () => {
      assert.equal(mock.clearMockLog(), true)
      assert.deepEqual(mock.getMockLog(), [])
      await mockFetch('/api/users')
      assert.equal(mock.getMockLog().length, 1)
    })

    await check('setLogListener получает каждую новую запись', async () => {
      const seen = []
      mock.setLogListener((entry) => seen.push(entry))
      await mockFetch('/api/users')
      assert.equal(seen.length, 1)
      assert.equal(seen[0].url, '/api/users')
      mock.setLogListener(null)
      await mockFetch('/api/users')
      assert.equal(seen.length, 1)
    })

    await check('переключение мок-проекта останавливает старый и стартует новый', async () => {
      await storage.saveMockProjectConfig(mockProject2.id, { routes: [{ method: 'GET', path: '/second', status: 201, body: '{"n":2}' }], defaultResponse: null })
      const newPort = await takeFreePort()
      const status = await mock.startMockServer({ projectId: mockProject2.id, port: newPort })
      assert.equal(status.state, 'running')
      assert.equal(status.port, newPort)
      assert.equal(status.projectId, mockProject2.id)
      const old = await mockFetch('/api/users').catch(() => null)
      assert.equal(old, null, 'старый порт закрыт')
      const res = await fetch(`http://127.0.0.1:${newPort}/second`)
      assert.equal(res.status, 201)
      mockPort2 = newPort
    })

    await check('остановка: статус stopped, порт закрыт', async () => {
      const status = await mock.stopMockServer()
      assert.equal(status.state, 'stopped')
      const res = await fetch(`http://127.0.0.1:${mockPort2}/second`).catch(() => null)
      assert.equal(res, null)
    })
  } finally {
    await mock.stopMockServer()
    await rm(mockRoot, { recursive: true, force: true })
  }

  // --- История ответов (секция в src/main/storage.js) ---
  // Отдельный корень хранилища: не зависит от состояния основного (там после
  // CORRUPT-теста projects.json оставлен битым намеренно).

  const histRoot = await mkdtemp(join(tmpdir(), 'postman-lite-smoke-hist-'))
  storage.initStorage(histRoot)

  try {
    const histProject = await storage.createProject('Hist')
    const P = histProject.id
    const REQ = 'req-1'
    await storage.saveRequest(P, { id: REQ, name: 'Req', method: 'GET', url: 'http://127.0.0.1/x', headers: [], params: [] })
    const makeResponse = (body, status = 200) => ({
      status,
      statusText: 'OK',
      timeMs: 12,
      size: Buffer.byteLength(String(body)),
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: String(body),
      truncated: false
    })

    await check('append→list: новая запись первая, поля ответа сохранены', async () => {
      await storage.appendResponseHistory(P, REQ, makeResponse('{"a":1}'))
      await storage.appendResponseHistory(P, REQ, makeResponse('{"a":2}'))
      const entries = await storage.listResponseHistory(P, REQ)
      assert.equal(entries.length, 2)
      assert.equal(entries[0].response.body, '{"a":2}', 'новая запись первая')
      assert.equal(entries[1].response.body, '{"a":1}')
      assert.ok(entries[0].createdAt, 'время получения в записи')
      assert.equal(entries[0].response.status, 200)
      assert.equal(entries[0].response.timeMs, 12)
    })

    await check('persist: история читается после переинициализации на той же папке', async () => {
      storage.initStorage(histRoot)
      const entries = await storage.listResponseHistory(P, REQ)
      assert.equal(entries.length, 2)
    })

    await check('лимит глубины: 11-я запись вытесняет старейшую', async () => {
      for (let i = 0; i < 11; i += 1) await storage.appendResponseHistory(P, 'req-limit', makeResponse(`{"n":${i}}`))
      const entries = await storage.listResponseHistory(P, 'req-limit')
      assert.equal(entries.length, 10)
      assert.equal(entries[0].response.body, '{"n":10}')
      assert.equal(entries[9].response.body, '{"n":1}', 'старейшая {"n":0} вытеснена')
    })

    await check('урезание тела: >100 КБ → bodyCut, исходный size сохранён', async () => {
      const big = 'x'.repeat(150 * 1024)
      await storage.appendResponseHistory(P, 'req-big', makeResponse(big))
      const [entry] = await storage.listResponseHistory(P, 'req-big')
      assert.equal(entry.response.body.length, 100 * 1024)
      assert.equal(entry.response.bodyCut, true)
      assert.equal(entry.response.size, 150 * 1024, 'исходный размер тела в size')
    })

    await check('бинарный content-type: тело не сохраняется, метаданные остаются', async () => {
      await storage.appendResponseHistory(P, 'req-bin', {
        ...makeResponse('raw-bytes'),
        headers: [{ key: 'Content-Type', value: 'application/octet-stream' }]
      })
      const [entry] = await storage.listResponseHistory(P, 'req-bin')
      assert.equal(entry.response.binary, true)
      assert.equal(entry.response.body, null)
      assert.equal(entry.response.size, Buffer.byteLength('raw-bytes'))
    })

    await check('текстовые content-type сохраняют тело (json, text/plain, без заголовка)', async () => {
      await storage.appendResponseHistory(P, 'req-plain', {
        ...makeResponse('привет'),
        headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }]
      })
      const [plain] = await storage.listResponseHistory(P, 'req-plain')
      assert.equal(plain.response.body, 'привет')
      assert.equal(plain.response.binary, undefined)

      await storage.appendResponseHistory(P, 'req-noct', { ...makeResponse('нет заголовка'), headers: [] })
      const [noct] = await storage.listResponseHistory(P, 'req-noct')
      assert.equal(noct.response.body, 'нет заголовка')
      assert.equal(noct.response.binary, undefined)
    })

    await check('неизвестный проект отклоняется в append и list', async () => {
      await assert.rejects(() => storage.appendResponseHistory('nope', 'r', makeResponse('{}')), /Проект не найден/)
      await assert.rejects(() => storage.listResponseHistory('nope', 'r'), /Проект не найден/)
    })

    await check('повреждённый файл истории: append пропускается, list бросает CORRUPT_STORAGE', async () => {
      await storage.appendResponseHistory(P, 'req-corrupt', makeResponse('{}')) // создаёт валидный файл
      const file = join(histRoot, 'history', P, 'req-corrupt.json')
      await writeFile(file, '{ битый', 'utf8')
      await storage.appendResponseHistory(P, 'req-corrupt', makeResponse('{"new":1}')) // не бросает, не пишет
      const after = await readFile(file, 'utf8')
      assert.equal(after, '{ битый', 'повреждённый файл не перезаписан')
      await assert.rejects(
        () => storage.listResponseHistory(P, 'req-corrupt'),
        (err) => err.code === 'CORRUPT_STORAGE'
      )
    })

    await check('параллельные append в одну историю: все записи учтены, tmp-остатков нет', async () => {
      // 30 append по 5 параллельно: очередь сериализует read-modify-write,
      // каждая запись видит результат предыдущей; в файле остаются последние 10.
      for (let round = 0; round < 6; round += 1) {
        await Promise.all(
          Array.from({ length: 5 }, (_, k) =>
            storage.appendResponseHistory(P, 'req-race', makeResponse(`{"r${round}-${k}"}`))
          )
        )
      }
      const entries = await storage.listResponseHistory(P, 'req-race')
      assert.equal(entries.length, 10)
      assert.ok(entries.every((e) => /^\{"r\d+-\d+"\}$/.test(e.response.body)), 'все тела из отправленных')
      const leftovers = (await readdir(join(histRoot, 'history', P))).filter((f) => f.includes('.tmp'))
      assert.equal(leftovers.length, 0, 'временных файлов не осталось')
    })

    await check('параллельные мутации файла проекта не теряют обновления', async () => {
      const ids = ['p1', 'p2', 'p3']
      for (let round = 0; round < 8; round += 1) {
        await Promise.all(
          ids.map((id) =>
            storage.saveRequest(P, { id, name: `${id}-${round}`, method: 'GET', url: 'http://x', headers: [], params: [] })
          )
        )
      }
      const requests = await storage.listRequests(P)
      for (const id of ids) {
        const record = requests.find((r) => r.id === id)
        assert.equal(record.name, `${id}-7`, 'последняя мутация каждого запроса в файле')
      }
    })

    await check('заблокированный запрос пишет историю', async () => {
      await storage.setRequestLocked(P, REQ, true)
      await storage.appendResponseHistory(P, REQ, makeResponse('{"locked":true}'))
      const entries = await storage.listResponseHistory(P, REQ)
      assert.equal(entries[0].response.body, '{"locked":true}')
      await storage.setRequestLocked(P, REQ, false)
    })

    await check('переименование проекта историю не трогает', async () => {
      const before = await storage.listResponseHistory(P, REQ)
      await storage.renameProject(P, 'Hist-renamed')
      const after = await storage.listResponseHistory(P, REQ)
      assert.deepEqual(after, before)
    })

    // Path traversal: id приходит и из MCP (внешний вход) — путь не должен выходить
    // за пределы хранилища ни на чтение, ни на запись, ни на удаление.
    await check('path traversal в requestId/projectId отвергается (INVALID_ID)', async () => {
      const outside = join(root, 'target.json')
      await writeFile(outside, '{"safe":true}', 'utf8')
      const evil = '../target'
      await assert.rejects(() => storage.appendResponseHistory(P, evil, makeResponse('{}')), (err) => err.code === 'INVALID_ID')
      await assert.rejects(() => storage.listResponseHistory(P, evil), (err) => err.code === 'INVALID_ID')
      // delete* сперва ищут запись в индексе — traversal до пути не доходит, ожидаем «не найден»
      await assert.rejects(() => storage.deleteRequest(P, evil), /не найден/)
      await assert.rejects(() => storage.deleteProject(evil), /не найден/)
      await assert.rejects(() => storage.deleteMockProject(evil), /не найден/)
      assert.equal(await readFile(outside, 'utf8'), '{"safe":true}', 'файл вне хранилища не тронут')
    })

    await check('удаление запроса удаляет файл истории; удаление проекта — каталог', async () => {
      const P2 = (await storage.createProject('Hist2')).id
      await storage.appendResponseHistory(P2, 'r1', makeResponse('{}'))
      const dir2 = join(histRoot, 'history', P2)
      await storage.deleteProject(P2)
      await assert.rejects(() => readdir(dir2), (err) => err.code === 'ENOENT', 'каталог истории проекта удалён')

      await storage.deleteRequest(P, REQ)
      const leftFiles = await readdir(join(histRoot, 'history', P))
      assert.equal(leftFiles.includes(`${REQ}.json`), false, 'файл истории запроса удалён')
      assert.deepEqual(await storage.listResponseHistory(P, REQ), [])
    })
  } finally {
    await rm(histRoot, { recursive: true, force: true })
  }

  console.log(`\nSMOKE OK: ${passed} проверок пройдено`)
} finally {
  await rm(root, { recursive: true, force: true })
}
