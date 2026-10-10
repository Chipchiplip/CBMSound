import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })

it('keeps worker scope and private media URLs inside a GitHub project base path', async () => {
  vi.stubEnv('BASE_URL', '/CBMSound/')
  vi.resetModules()
  const register = vi.fn().mockRejectedValue(new Error('Offline in test'))
  vi.stubGlobal('navigator', { serviceWorker: { register, addEventListener: vi.fn(), removeEventListener: vi.fn() } })
  const media = await import('./media')
  expect(media.mediaUrl('private/id')).toBe('/CBMSound/__cbm_media__/private%2Fid')
  await media.registerMediaWorker()
  expect(register).toHaveBeenCalledWith('/CBMSound/sw.js', { type: 'module', scope: '/CBMSound/', updateViaCache: 'none' })
})
