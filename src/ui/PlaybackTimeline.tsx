import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'

interface PlaybackTimelineProps {
  currentTime: number
  duration: number
  trackId?: string
  disabled?: boolean
  onSeek: (seconds: number) => void
}

const SEEK_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

function formatPosition(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor(whole / 60) % 60
  const remaining = String(whole % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remaining}` : `${minutes}:${remaining}`
}

/** Keep scrub previews local so a drag does not repeatedly restart Drive requests. */
export function PlaybackTimeline({ currentTime, duration, trackId, disabled = false, onSeek }: PlaybackTimelineProps) {
  const instructionId = useId()
  const [draft, setDraft] = useState<{ trackId?: string; seconds: number } | null>(null)
  const gesture = useRef<{ trackId?: string; kind: 'pointer' | 'keyboard'; cancelled?: boolean } | null>(null)
  const draftSeconds = useRef<number | null>(null)
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0
  const unavailable = disabled || !trackId || total === 0
  const clamp = (seconds: number) => Math.min(total, Math.max(0, Number.isFinite(seconds) ? seconds : 0))
  const previewing = !unavailable && draft !== null && draft.trackId === trackId
  const position = previewing ? clamp(draft.seconds) : Math.max(0, Number.isFinite(currentTime) ? currentTime : 0)
  const rangePosition = clamp(position)

  const cancel = () => {
    gesture.current = null
    draftSeconds.current = null
    setDraft(null)
  }

  const commit = () => {
    const active = gesture.current
    const seconds = draftSeconds.current
    cancel()
    if (!unavailable && active?.trackId === trackId && !active.cancelled && seconds !== null) onSeek(clamp(seconds))
  }

  useEffect(() => {
    // Keep the old gesture's identity until release, ignoring late drag input.
    if (gesture.current && (gesture.current.trackId !== trackId || unavailable)) gesture.current.cancelled = true
    draftSeconds.current = null
    setDraft(null)
  }, [trackId, unavailable])

  return <div className={`playback-timeline${previewing ? ' is-seeking' : ''}`}>
    <time className="timeline-elapsed" aria-label="Thời gian đã phát">{formatPosition(position)}</time>
    <input
      className="timeline-range"
      aria-label="Vị trí phát"
      aria-describedby={instructionId}
      aria-valuetext={total ? `${formatPosition(position)} trên ${formatPosition(total)}` : `${formatPosition(position)}, chưa xác định thời lượng`}
      type="range"
      min={0}
      max={total || 1}
      step="0.25"
      value={rangePosition}
      disabled={unavailable}
      style={{ '--timeline-progress': `${total ? rangePosition / total * 100 : 0}%` } as CSSProperties}
      onPointerDown={(event) => {
        if (unavailable || (event.pointerType === 'mouse' && event.button !== 0)) return
        gesture.current = { trackId, kind: 'pointer' }
        draftSeconds.current = null
        // Capture keeps a release outside the narrow rail attached to this drag.
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onPointerUp={() => { if (gesture.current?.kind === 'pointer') commit() }}
      onPointerCancel={cancel}
      onLostPointerCapture={() => { if (gesture.current?.kind === 'pointer') cancel() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (gesture.current) gesture.current.cancelled = true
          draftSeconds.current = null
          setDraft(null)
          return
        }
        if (!unavailable && SEEK_KEYS.has(event.key) && !gesture.current) {
          gesture.current = { trackId, kind: 'keyboard' }
          draftSeconds.current = null
        }
      }}
      onKeyUp={(event) => { if (SEEK_KEYS.has(event.key) && gesture.current?.kind === 'keyboard') commit() }}
      onBlur={() => { if (gesture.current?.kind === 'keyboard') commit(); else cancel() }}
      onChange={(event) => {
        if (unavailable) return
        const seconds = clamp(Number(event.currentTarget.value))
        const active = gesture.current
        if (active) {
          if (active.trackId !== trackId || active.cancelled) return
          draftSeconds.current = seconds
          setDraft({ trackId, seconds })
        } else {
          // Screen readers can change a native range without pointer/key events.
          onSeek(seconds)
        }
      }}
    />
    <time className="timeline-duration" aria-label="Thời lượng bài hát">{total ? formatPosition(total) : '—:—'}</time>
    <span id={instructionId} className="sr-only">Kéo rồi thả để tua. Dùng phím mũi tên để chọn vị trí; nhấn Escape để hủy.</span>
  </div>
}
