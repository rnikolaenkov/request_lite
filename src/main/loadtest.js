// Нагрузочный прогон запроса из main-процесса: пул воркеров с ограничением
// конкурентности, статистика латентности (min/avg/p95/max) и RPS.
// Использует sendRequest напрямую (минуя IPC) — как MCP-сервер.
import { sendRequest, cancelRequest } from './http.js'

let activeAbort = null

export function cancelLoadTest() {
  if (activeAbort) {
    activeAbort.aborted = true
    // В-flight запросы прерываем принудительно — иначе «Остановить» ждёт до таймаута.
    for (const requestId of activeAbort.inflight) cancelRequest(requestId)
  }
  return { ok: true }
}

/**
 * Запускает нагрузочное тестирование указанного запроса.
 * @param {object} payload - { request, totalRequests, concurrency }
 */
export async function runLoadTest({ request, totalRequests = 20, concurrency = 5 }) {
  const total = Math.max(1, Math.min(500, Number(totalRequests) || 20))
  const workersCount = Math.max(1, Math.min(50, Number(concurrency) || 5))

  const state = { aborted: false, inflight: new Set() }
  activeAbort = state

  const latencies = []
  const statusCounts = {}
  let errors = 0
  let nextIndex = 0
  const startedAt = Date.now()

  async function worker() {
    while (!state.aborted) {
      const idx = nextIndex++
      if (idx >= total) break

      const reqId = `lt-${Date.now()}-${idx}`
      state.inflight.add(reqId)
      const t0 = performance.now()
      try {
        const res = await sendRequest(request, reqId, {})
        latencies.push(performance.now() - t0)
        const code = String(res.status ?? 'unknown')
        statusCounts[code] = (statusCounts[code] || 0) + 1
        if (res.status >= 400) errors++
      } catch {
        // sendRequest бросает codedError (NETWORK/SSL/TIMEOUT/ABORTED) — любая ошибка считается неуспехом.
        latencies.push(performance.now() - t0)
        errors++
      } finally {
        state.inflight.delete(reqId)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(workersCount, total) }, () => worker()))
  if (activeAbort === state) activeAbort = null

  const totalMs = Math.max(1, Date.now() - startedAt)
  const completed = latencies.length
  const sorted = [...latencies].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const minMs = completed ? Math.round(sorted[0]) : 0
  const maxMs = completed ? Math.round(sorted[completed - 1]) : 0
  const avgMs = completed ? Math.round(sum / completed) : 0
  const p95Index = completed ? Math.min(completed - 1, Math.floor(completed * 0.95)) : 0
  const p95Ms = completed ? Math.round(sorted[p95Index]) : 0
  const rps = Number(((completed / totalMs) * 1000).toFixed(1))

  return {
    ok: true,
    cancelled: state.aborted,
    completed,
    total,
    errors,
    totalMs,
    rps,
    minMs,
    avgMs,
    p95Ms,
    maxMs,
    statusCounts
  }
}
