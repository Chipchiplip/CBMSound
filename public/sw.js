// Sessions live only in RAM. A restarted worker asks the owning tab to
// supply its token again; tokens never appear in media addresses or caches.
const sessions = new Map()
const pendingSessions = new Map()
const activeRequests = new Map()
const clientGenerations = new Map()
const MAX_RANGE_BYTES = 8 * 1024 * 1024
const SESSION_TIMEOUT = 5000

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('message', (event) => {
  const clientId = event.source?.id
  const data = event.data
  if (!clientId || !data || typeof data !== 'object') return
  if (data.type === 'CLEAR_SESSION' && (!data.requestId || pendingSessions.get(clientId)?.requestId === data.requestId)) {
    if (!data.requestId) clientGenerations.set(clientId, (clientGenerations.get(clientId) || 0) + 1)
    sessions.delete(clientId)
    abortRequests(clientId)
    settleSession(clientId, undefined)
  }
  if (data.type === 'RELEASE_MEDIA') abortRequests(clientId)
  if (data.type === 'SET_SESSION' && typeof data.token === 'string' && data.expiresAt > Date.now() && data.files && typeof data.files === 'object'
    && (!data.requestId || pendingSessions.get(clientId)?.requestId === data.requestId)) {
    const session = { token: data.token, expiresAt: data.expiresAt, files: data.files }
    sessions.set(clientId, session)
    const pending = pendingSessions.get(clientId)
    if (!data.requestId || pending?.requestId === data.requestId) settleSession(clientId, session)
  }
  event.ports?.[0]?.postMessage({ type: 'SESSION_ACK', protocol: 2 })
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const scope = new URL(self.registration.scope)
  const prefix = `${scope.pathname.replace(/\/$/, '')}/__cbm_media__/`
  if (url.origin !== scope.origin || !url.pathname.startsWith(prefix)) return
  event.respondWith(serveMedia(event.request, event.clientId, url.pathname.slice(prefix.length)))
})

function settleSession(clientId, session) {
  const pending = pendingSessions.get(clientId)
  if (!pending) return
  clearTimeout(pending.timeout)
  pendingSessions.delete(clientId)
  pending.resolve(session)
}

async function getSession(clientId) {
  if (!clientId) return undefined
  const existing = sessions.get(clientId)
  if (existing?.expiresAt > Date.now()) return existing
  sessions.delete(clientId)
  const pending = pendingSessions.get(clientId)
  if (pending) return pending.promise
  const generation = clientGenerations.get(clientId) || 0
  const client = await self.clients.get(clientId)
  if (generation !== (clientGenerations.get(clientId) || 0)) return undefined
  if (!client) return undefined
  // Several media ranges can arrive while clients.get is resolving.
  const concurrent = pendingSessions.get(clientId)
  if (concurrent) return concurrent.promise
  const refreshed = sessions.get(clientId)
  if (refreshed?.expiresAt > Date.now()) return refreshed
  const requestId = crypto.randomUUID()
  let resolve
  const promise = new Promise((done) => { resolve = done })
  const timeout = setTimeout(() => settleSession(clientId, undefined), SESSION_TIMEOUT)
  pendingSessions.set(clientId, { promise, resolve, timeout, requestId })
  client.postMessage({ type: 'REQUEST_SESSION', requestId })
  return promise
}

function abortRequests(clientId) {
  const requests = activeRequests.get(clientId)
  if (!requests) return
  for (const controller of requests) controller.abort()
  activeRequests.delete(clientId)
}

async function tellClient(clientId, type, rejectedToken) {
  const client = await self.clients.get(clientId)
  client?.postMessage({ type, rejectedToken })
}

async function serveMedia(request, clientId, encodedId) {
  if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'METHOD_NOT_ALLOWED')
  let fileId
  try { fileId = decodeURIComponent(encodedId) } catch { return error(400, 'INVALID_FILE_ID') }
  if (!fileId || fileId.includes('/') || fileId.length > 200) return error(400, 'INVALID_FILE_ID')
  const generation = clientGenerations.get(clientId) || 0
  const session = await getSession(clientId)
  if (request.signal.aborted || generation !== (clientGenerations.get(clientId) || 0)) return error(503, 'REQUEST_CANCELLED')
  if (!session || session.expiresAt <= Date.now()) {
    return error(401, 'AUTH_REQUIRED')
  }
  const file = session.files[fileId]
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0) return error(404, 'FILE_NOT_IN_LIBRARY')
  const range = parseRange(request.headers.get('Range'), file.size)
  if (range === 'invalid') return error(416, 'INVALID_RANGE', { 'Content-Range': `bytes */${file.size}` })
  if (file.size === 0) return new Response(null, { status: 200, headers: { 'Content-Length': '0', 'Content-Type': file.mimeType } })
  const start = range?.start ?? 0
  const end = range ? Math.min(range.end, start + MAX_RANGE_BYTES - 1, file.size - 1) : file.size - 1
  if (start >= file.size || start > end) return error(416, 'INVALID_RANGE', { 'Content-Range': `bytes */${file.size}` })

  const abort = new AbortController()
  const requests = activeRequests.get(clientId) || new Set()
  activeRequests.set(clientId, requests)
  requests.add(abort)
  let cancelRead
  const abortRequest = () => abort.abort()
  request.signal.addEventListener('abort', abortRequest, { once: true })
  const finish = () => {
    request.signal.removeEventListener('abort', abortRequest)
    if (cancelRead) abort.signal.removeEventListener('abort', cancelRead)
    requests.delete(abort)
    if (!requests.size && activeRequests.get(clientId) === requests) activeRequests.delete(clientId)
  }
  if (request.signal.aborted) abort.abort()
  let upstream
  try {
    // GET with a one-byte range probes HEAD, since Drive documents GET media.
    upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.token}`, Range: `bytes=${start}-${request.method === 'HEAD' ? start : end}` },
      signal: abort.signal, cache: 'no-store',
    })
  } catch {
    finish()
    return error(503, abort.signal.aborted ? 'REQUEST_CANCELLED' : 'NETWORK_ERROR')
  }
  const rejectUpstream = async (status, code, headers = {}) => {
    await upstream.body?.cancel().catch(() => undefined)
    abort.abort()
    finish()
    return error(status, code, headers)
  }
  if (upstream.status === 401) {
    if (sessions.get(clientId) === session) {
      sessions.delete(clientId)
      // Include the rejected token only in the RAM message to its owning tab,
      // so a delayed 401 cannot invalidate a replacement token.
      void tellClient(clientId, 'MEDIA_AUTH_REQUIRED', session.token)
    }
    return rejectUpstream(401, 'AUTH_REQUIRED')
  }
  if (upstream.status === 403) return rejectUpstream(403, 'DRIVE_ACCESS_DENIED')
  if (upstream.status === 404) return rejectUpstream(404, 'FILE_NOT_FOUND')
  if (upstream.status === 416) return rejectUpstream(416, 'INVALID_RANGE', { 'Content-Range': upstream.headers.get('Content-Range') || `bytes */${file.size}` })
  if (upstream.status === 200) return rejectUpstream(502, 'RANGE_NOT_SUPPORTED')
  if (upstream.status !== 206 || !upstream.body) return rejectUpstream(upstream.ok ? 502 : upstream.status, 'DRIVE_MEDIA_ERROR')
  if (abort.signal.aborted) return rejectUpstream(503, 'REQUEST_CANCELLED')

  const contentRange = upstream.headers.get('Content-Range')
  const upstreamEnd = request.method === 'HEAD' ? start : end
  const declaredLength = upstream.headers.get('Content-Length')
  let actual
  if (contentRange) {
    actual = parseContentRange(contentRange)
  } else {
    // Content-Range is not CORS-safelisted. A readable 206 can hide it while
    // exposing Content-Length. Require that independent length evidence and
    // fresh authenticated metadata before describing the interval locally.
    if (declaredLength === null) return rejectUpstream(502, 'RANGE_LENGTH_UNAVAILABLE')
    const expectedLength = upstreamEnd - start + 1
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expectedLength) return rejectUpstream(502, 'INVALID_UPSTREAM_LENGTH')
    let metadataResponse
    let metadata
    try {
      metadataResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=size,modifiedTime,trashed,capabilities(canDownload)`, {
        method: 'GET', headers: { Authorization: `Bearer ${session.token}` }, signal: abort.signal, cache: 'no-store',
      })
      if (metadataResponse.ok) metadata = await metadataResponse.json()
    } catch {
      return rejectUpstream(503, abort.signal.aborted ? 'REQUEST_CANCELLED' : 'DRIVE_METADATA_UNAVAILABLE')
    }
    if (abort.signal.aborted) return rejectUpstream(503, 'REQUEST_CANCELLED')
    if (!metadataResponse.ok) {
      await metadataResponse.body?.cancel().catch(() => undefined)
      if (metadataResponse.status === 401) {
        if (sessions.get(clientId) === session) {
          sessions.delete(clientId)
          void tellClient(clientId, 'MEDIA_AUTH_REQUIRED', session.token)
        }
        return rejectUpstream(401, 'AUTH_REQUIRED')
      }
      if (metadataResponse.status === 403) return rejectUpstream(403, 'DRIVE_ACCESS_DENIED')
      if (metadataResponse.status === 404) return rejectUpstream(404, 'FILE_NOT_FOUND')
      return rejectUpstream(metadataResponse.status, 'DRIVE_METADATA_UNAVAILABLE')
    }
    if (!metadata || typeof metadata.size !== 'string' || !/^\d+$/.test(metadata.size) || !Number.isSafeInteger(Number(metadata.size))
      || typeof metadata.trashed !== 'boolean' || typeof metadata.capabilities?.canDownload !== 'boolean') return rejectUpstream(502, 'INVALID_DRIVE_METADATA')
    if (metadata.trashed) return rejectUpstream(404, 'FILE_NOT_FOUND')
    if (!metadata.capabilities.canDownload) return rejectUpstream(403, 'DOWNLOAD_RESTRICTED')
    if (Number(metadata.size) !== file.size || typeof file.modifiedTime === 'string' && metadata.modifiedTime !== file.modifiedTime) return rejectUpstream(409, 'FILE_CHANGED')
    actual = { start, end: upstreamEnd, size: Number(metadata.size) }
  }
  if (!actual || actual.start !== start || actual.end !== upstreamEnd) return rejectUpstream(502, 'INVALID_UPSTREAM_RANGE')
  if (actual.size !== file.size) return rejectUpstream(409, 'FILE_CHANGED')
  const length = actual.end - actual.start + 1
  if (declaredLength !== null && Number(declaredLength) !== length) return rejectUpstream(502, 'INVALID_UPSTREAM_LENGTH')
  const headers = {
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Content-Length': String(length), 'Content-Range': `bytes ${actual.start}-${actual.end}/${actual.size}`,
    'Content-Type': file.mimeType || 'application/octet-stream',
  }
  if (!range) delete headers['Content-Range']
  if (request.method === 'HEAD') {
    await upstream.body.cancel().catch(() => undefined)
    abort.abort()
    finish()
    if (range) {
      headers['Content-Length'] = String(end - start + 1)
      headers['Content-Range'] = `bytes ${start}-${end}/${actual.size}`
    } else {
      headers['Content-Length'] = String(actual.size)
      delete headers['Content-Range']
    }
    return new Response(null, { status: range ? 206 : 200, headers })
  }
  const reader = upstream.body.getReader()
  cancelRead = () => { void reader.cancel().catch(() => undefined) }
  abort.signal.addEventListener('abort', cancelRead, { once: true })
  let received = 0
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        const { done, value } = await reader.read()
        if (abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        if (done) {
          if (received !== length) throw new Error('INCOMPLETE_UPSTREAM_RANGE')
          finish()
          controller.close()
          return
        }
        received += value.byteLength
        if (received > length) throw new Error('INVALID_UPSTREAM_LENGTH')
        controller.enqueue(value)
      } catch (cause) {
        abort.abort()
        await reader.cancel().catch(() => undefined)
        finish()
        controller.error(cause)
      }
    },
    async cancel() {
      abort.abort()
      await reader.cancel().catch(() => undefined)
      finish()
    },
  })
  return new Response(stream, { status: range ? 206 : 200, headers })
}

function parseContentRange(header) {
  const match = header?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
  if (!match) return undefined
  const start = Number(match[1]), end = Number(match[2]), size = Number(match[3])
  if (![start, end, size].every(Number.isSafeInteger) || start > end || end >= size) return undefined
  return { start, end, size }
}

function parseRange(header, size) {
  if (!header) return undefined
  const match = header.match(/^bytes=(\d*)-(\d*)$/i)
  if (!match || (!match[1] && !match[2]) || !size) return 'invalid'
  if (!match[1]) {
    const suffix = Number(match[2])
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : 'invalid'
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

function error(status, code, extraHeaders = {}) {
  return new Response(code, { status, headers: {
    'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-CBM-Error': code, ...extraHeaders,
  } })
}
