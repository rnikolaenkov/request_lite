/**
 * Парсер OpenAPI 3.x / Swagger 2.0 (JSON) в формат проекта Request Lite.
 * Возвращает { name, requests, variables } для projects.importCollection.
 * Запросы формируются в модели хранилища: body — объект {type, json}, sslVerify — флаг.
 */
export function parseOpenApi(rawJson) {
  let spec
  if (typeof rawJson === 'string') {
    try {
      spec = JSON.parse(rawJson)
    } catch {
      throw new Error('Файл не является корректным JSON')
    }
  } else {
    spec = rawJson
  }
  if (!spec || typeof spec !== 'object' || (!spec.openapi && !spec.swagger) || !spec.paths) {
    throw new Error('Файл не является корректной спецификацией OpenAPI / Swagger JSON')
  }

  const name = spec.info?.title?.trim() || 'OpenAPI Import'
  const baseUrl = spec.servers?.[0]?.url || (spec.host ? `https://${spec.host}${spec.basePath || ''}` : 'http://localhost:3000')
  const variables = [{ key: 'baseUrl', value: baseUrl, enabled: true }]

  const allowedMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
  const requests = []

  for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : []

    for (const method of allowedMethods) {
      const op = pathItem[method]
      if (!op) continue

      const allParams = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
      const params = allParams
        .filter((p) => p.in === 'query')
        .map((p) => ({
          key: p.name,
          value: p.example !== undefined ? String(p.example) : '',
          enabled: Boolean(p.required)
        }))

      const headers = allParams
        .filter((p) => p.in === 'header')
        .map((p) => ({
          key: p.name,
          value: p.example !== undefined ? String(p.example) : '',
          enabled: true
        }))

      let body = { type: 'none' }
      const jsonContent = op.requestBody?.content?.['application/json']
      if (jsonContent) {
        let sample = jsonContent.example
        if (sample === undefined && jsonContent.schema) sample = sampleFromSchema(jsonContent.schema)
        body = { type: 'json', json: sample !== undefined ? JSON.stringify(sample, null, 2) : '' }
      }

      const reqName = op.summary?.trim() || op.operationId?.trim() || `${method.toUpperCase()} ${pathKey}`
      requests.push({
        name: reqName,
        method: method.toUpperCase(),
        url: `{{baseUrl}}${pathKey}`,
        params,
        headers,
        body,
        auth: { type: 'none' },
        sslVerify: true
      })
    }
  }

  return { name, requests, variables }
}

function sampleFromSchema(schema, depth = 0) {
  if (!schema || depth > 3) return null
  if (schema.example !== undefined) return schema.example
  if (schema.type === 'object' || schema.properties) {
    const obj = {}
    for (const [k, v] of Object.entries(schema.properties || {})) {
      obj[k] = sampleFromSchema(v, depth + 1)
    }
    return obj
  }
  if (schema.type === 'array') {
    return schema.items ? [sampleFromSchema(schema.items, depth + 1)] : []
  }
  if (schema.type === 'integer' || schema.type === 'number') return 0
  if (schema.type === 'boolean') return false
  return ''
}
