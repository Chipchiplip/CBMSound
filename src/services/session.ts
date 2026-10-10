// Logout is the boundary for account-owned work. Token renewal deliberately does
// not change this generation, so an upload can resume with the same file/session.
let generation = 0
let controller = new AbortController()
const resetListeners = new Set<() => void>()

export function getSessionGeneration(): number { return generation }

export function isSessionCurrent(value: number): boolean { return value === generation }

export function getSessionSignal(): AbortSignal { return controller.signal }

export function subscribeSessionReset(listener: () => void): () => void {
  resetListeners.add(listener)
  return () => resetListeners.delete(listener)
}

export function invalidateSession(): void {
  generation += 1
  const previous = controller
  controller = new AbortController()
  previous.abort(new DOMException('Phiên đã đăng xuất.', 'AbortError'))
  for (const listener of resetListeners) listener()
}

export function assertSessionCurrent(value: number): void {
  if (!isSessionCurrent(value)) throw new DOMException('Phiên đã thay đổi.', 'AbortError')
}

// Use a fresh composed signal per operation. Remove the forwarding listeners once
// the operation finishes instead of retaining every request for the tab lifetime.
export function sessionRequestSignal(signal?: AbortSignal | null): { signal: AbortSignal; release: () => void } {
  const sessionSignal = getSessionSignal()
  const requestController = new AbortController()
  const abortSession = () => requestController.abort(sessionSignal.reason)
  const abortRequest = () => requestController.abort(signal?.reason)
  if (sessionSignal.aborted) abortSession()
  else sessionSignal.addEventListener('abort', abortSession, { once: true })
  if (signal?.aborted) abortRequest()
  else signal?.addEventListener('abort', abortRequest, { once: true })
  return {
    signal: requestController.signal,
    release: () => {
      sessionSignal.removeEventListener('abort', abortSession)
      signal?.removeEventListener('abort', abortRequest)
    },
  }
}
