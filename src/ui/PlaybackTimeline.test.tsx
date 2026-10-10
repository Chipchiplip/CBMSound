import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlaybackTimeline } from './PlaybackTimeline'

afterEach(cleanup)

function setup() {
  const onSeek = vi.fn<(seconds: number) => void>()
  const props = { currentTime: 5, duration: 104, trackId: 'song-a', onSeek }
  const view = render(<PlaybackTimeline {...props} />)
  return { ...view, onSeek, props, range: screen.getByRole('slider', { name: 'Vị trí phát' }) }
}

describe('playback timeline', () => {
  it('previews pointer dragging without seeking repeatedly or snapping to incoming playback time', () => {
    const { range, onSeek, props, rerender } = setup()
    fireEvent.pointerDown(range, { pointerId: 1, pointerType: 'mouse', button: 0 })
    fireEvent.change(range, { target: { value: '35' } })
    fireEvent.change(range, { target: { value: '48.25' } })
    rerender(<PlaybackTimeline {...props} currentTime={9} />)
    expect(range).toHaveValue('48.25')
    expect(screen.getByLabelText('Thời gian đã phát')).toHaveTextContent('0:48')
    expect(range).toHaveAttribute('aria-valuetext', '0:48 trên 1:44')
    expect(onSeek).not.toHaveBeenCalled()
    fireEvent.pointerUp(range, { pointerId: 1 })
    fireEvent.pointerUp(range, { pointerId: 1 })
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(48.25)
  })

  it('commits a native keyboard gesture once when its key is released', () => {
    const { range, onSeek } = setup()
    fireEvent.keyDown(range, { key: 'ArrowRight' })
    fireEvent.change(range, { target: { value: '5.25' } })
    fireEvent.keyDown(range, { key: 'ArrowRight', repeat: true })
    fireEvent.change(range, { target: { value: '5.5' } })
    expect(onSeek).not.toHaveBeenCalled()
    fireEvent.keyUp(range, { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(5.5)
  })

  it('supports native Home and End gestures and commits before keyboard focus leaves', () => {
    const { range, onSeek } = setup()
    fireEvent.keyDown(range, { key: 'End' })
    fireEvent.change(range, { target: { value: '104' } })
    fireEvent.keyUp(range, { key: 'End' })
    expect(onSeek).toHaveBeenLastCalledWith(104)
    fireEvent.keyDown(range, { key: 'Home' })
    fireEvent.change(range, { target: { value: '0' } })
    fireEvent.blur(range)
    expect(onSeek).toHaveBeenLastCalledWith(0)
    expect(onSeek).toHaveBeenCalledTimes(2)
  })

  it('accepts a touch gesture and discards cancellation without seeking', () => {
    const { range, onSeek } = setup()
    fireEvent.pointerDown(range, { pointerId: 2, pointerType: 'touch' })
    fireEvent.change(range, { target: { value: '60' } })
    fireEvent.pointerCancel(range, { pointerId: 2 })
    expect(onSeek).not.toHaveBeenCalled()
    expect(range).toHaveValue('5')
    fireEvent.pointerDown(range, { pointerId: 3, pointerType: 'touch' })
    fireEvent.change(range, { target: { value: '72' } })
    fireEvent.pointerUp(range, { pointerId: 3 })
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(72)
  })

  it('cancels an old drag when the song changes instead of seeking the new song', () => {
    const { range, onSeek, props, rerender } = setup()
    fireEvent.pointerDown(range, { pointerId: 1 })
    fireEvent.change(range, { target: { value: '80' } })
    rerender(<PlaybackTimeline {...props} trackId="song-b" currentTime={0} duration={200} />)
    expect(range).toHaveValue('0')
    fireEvent.change(range, { target: { value: '90' } })
    expect(range).toHaveValue('0')
    fireEvent.pointerUp(range, { pointerId: 1 })
    expect(onSeek).not.toHaveBeenCalled()
    fireEvent.pointerDown(range, { pointerId: 2 })
    fireEvent.change(range, { target: { value: '12' } })
    fireEvent.pointerUp(range, { pointerId: 2 })
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(12)
  })

  it('discards the preview when Escape is pressed', () => {
    const { range, onSeek } = setup()
    fireEvent.keyDown(range, { key: 'ArrowRight' })
    fireEvent.change(range, { target: { value: '35' } })
    fireEvent.keyDown(range, { key: 'Escape' })
    fireEvent.change(range, { target: { value: '36' } })
    fireEvent.keyUp(range, { key: 'ArrowRight' })
    expect(range).toHaveValue('5')
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('allows assistive technology to change the native range without a pointer or key gesture', () => {
    const { range, onSeek } = setup()
    fireEvent.change(range, { target: { value: '30' } })
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(30)
  })

  it('cancels dragging when playback becomes unavailable even if it becomes available before release', () => {
    const { range, onSeek, props, rerender } = setup()
    fireEvent.pointerDown(range, { pointerId: 1 })
    fireEvent.change(range, { target: { value: '35' } })
    rerender(<PlaybackTimeline {...props} disabled />)
    expect(range).toBeDisabled()
    rerender(<PlaybackTimeline {...props} />)
    fireEvent.change(range, { target: { value: '36' } })
    fireEvent.pointerUp(range, { pointerId: 1 })
    expect(onSeek).not.toHaveBeenCalled()
    expect(range).toHaveValue('5')
  })

  it('disables seeking while duration is unknown and formats long recordings without wrapping minutes', () => {
    const { range, onSeek, props, rerender } = setup()
    rerender(<PlaybackTimeline {...props} duration={Number.NaN} />)
    expect(range).toBeDisabled()
    expect(range).toHaveAttribute('aria-valuetext', '0:05, chưa xác định thời lượng')
    expect(screen.getByLabelText('Thời lượng bài hát')).toHaveTextContent('—:—')
    expect(screen.getByLabelText('Thời gian đã phát')).toHaveTextContent('0:05')
    fireEvent.change(range, { target: { value: '1' } })
    expect(onSeek).not.toHaveBeenCalled()
    rerender(<PlaybackTimeline {...props} duration={7300} currentTime={3661} />)
    expect(range).toHaveAttribute('aria-valuetext', '1:01:01 trên 2:01:40')
  })

  it('uses the corrected full duration for a long recording and never clips the elapsed label', () => {
    const { range, props, rerender } = setup()
    rerender(<PlaybackTimeline {...props} duration={104} currentTime={130} />)
    expect(screen.getByLabelText('Thời gian đã phát')).toHaveTextContent('2:10')
    rerender(<PlaybackTimeline {...props} duration={4800} currentTime={2400} />)
    expect(range).toHaveAttribute('max', '4800')
    expect(range).toHaveValue('2400')
    expect(screen.getByLabelText('Thời lượng bài hát')).toHaveTextContent('1:20:00')
    expect(range).toHaveAttribute('aria-valuetext', '40:00 trên 1:20:00')
  })
})
