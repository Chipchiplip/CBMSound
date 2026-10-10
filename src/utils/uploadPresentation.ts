import { isAudioFile, type UploadJob } from '../types'

export function canRetryUploadJob(job: UploadJob): boolean {
  return isAudioFile(job.file) && job.file.size > 0
    && ['error', 'paused', 'needsAuth', 'cancelled'].includes(job.state)
    && !['invalidAudioFile', 'uploadContextChanged'].includes(job.error?.reason || '')
}

export function uploadProgress(job: UploadJob): number {
  return job.totalBytes ? Math.min(100, Math.floor(job.confirmedBytes / job.totalBytes * 100)) : 0
}

export function uploadEtaText(job: UploadJob): string {
  if (job.state === 'done') return 'Đã lưu lên Drive'
  if (job.state === 'uploading' || job.state === 'retrying') return `Đã xác nhận ${formatBytes(job.confirmedBytes)} / ${formatBytes(job.totalBytes)}`
  if (job.state === 'queued') return 'Đang chờ trong hàng đợi'
  if (job.state === 'needsAuth') return 'Chờ kết nối lại Google; phiên upload vẫn được giữ trong tab này'
  if (job.state === 'paused') return 'Upload đang tạm dừng; có thể tiếp tục trong tab này'
  if (job.state === 'skipped') return 'Đã bỏ qua file trùng tên'
  if (job.state === 'cancelled') return 'Đã hủy'
  return job.error?.message || 'Upload thất bại'
}

export function formatBytes(size: number): string {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const order = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)))
  return `${(size / 1024 ** order).toFixed(order === 0 ? 0 : 1)} ${units[order]}`
}
