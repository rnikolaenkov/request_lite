import http from 'node:http'

// Hop-by-hop заголовки (RFC 7230 §6.1): описывают конкретное TCP-соединение, а не запрос —
// прокси обязан снять их перед форвардом (undici отклоняет «connection» и их пачку).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection'
])

let server = null
let currentPort = 8888
let logs = []

export function getProxyStatus() {
  return {
    running: server !== null,
    port: currentPort
  }
}

export function getProxyLog() {
  return logs
}

export function clearProxyLog() {
  logs = []
  return { ok: true }
}

export function stopProxy() {
  if (!server) return { ok: true }
  return new Promise((resolve) => {
    server.close(() => {
      server = null
      resolve({ ok: true })
    })
  })
}

export function startProxy(port = 8888) {
  if (server) return Promise.resolve({ ok: true, port: currentPort })
  const targetPort = Math.max(1024, Math.min(65535, Number(port) || 8888))

  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const startedAt = Date.now()
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', async () => {
        const bodyBuf = Buffer.concat(chunks)
        const targetUrl = req.url?.startsWith('http')
          ? req.url
          : `http://${req.headers.host || 'localhost'}${req.url || '/'}`

        const headers = { ...req.headers }
        for (const key of Object.keys(headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) delete headers[key]
        }
        delete headers['host']

        let status = 502
        let respText = ''
        try {
          const upstream = await fetch(targetUrl, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method || 'GET') || !bodyBuf.length ? undefined : bodyBuf
          })
          status = upstream.status
          const respBuf = Buffer.from(await upstream.arrayBuffer())
          respText = respBuf.toString('utf8').slice(0, 4000)

          const outHeaders = {}
          upstream.headers.forEach((v, k) => {
            if (k.toLowerCase() !== 'transfer-encoding') outHeaders[k] = v
          })
          res.writeHead(status, outHeaders)
          res.end(respBuf)
        } catch (err) {
          respText = err?.message ?? 'Proxy error'
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(respText)
        }

        const entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          time: new Date().toLocaleTimeString(),
          method: req.method || 'GET',
          url: targetUrl,
          status,
          durationMs: Date.now() - startedAt,
          body: bodyBuf.toString('utf8'),
          headers: Object.entries(headers).map(([key, value]) => ({
            key,
            value: Array.isArray(value) ? value.join(', ') : String(value ?? ''),
            enabled: true
          })),
          responsePreview: respText
        }
        logs = [entry, ...logs].slice(0, 200)
      })
    })

    srv.on('error', (err) => {
      server = null
      resolve({ ok: false, error: err.message })
    })

    srv.listen(targetPort, '127.0.0.1', () => {
      server = srv
      currentPort = targetPort
      resolve({ ok: true, port: currentPort })
    })
  })
}
