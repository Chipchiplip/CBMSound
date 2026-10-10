export interface ByteRange { start: number; end: number }

export function parseByteRange(header: string | null, size: number): ByteRange | undefined | 'invalid' {
  if (!header) return undefined
  const match = header.match(/^bytes=(\d*)-(\d*)$/i)
  if (!match || (!match[1] && !match[2])) return 'invalid'
  if (!match[1]) {
    const suffix = Number(match[2])
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : 'invalid'
  }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return 'invalid'
  return { start, end }
}
