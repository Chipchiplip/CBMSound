import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch() {
    // Avoid logging app state or Google credentials from a rendering failure.
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <main className="setup-screen"><div className="setup-card" role="alert"><h1>Không thể hiển thị trang này.</h1><p>Thử tải lại website. Nhạc vẫn được lưu trên Google Drive.</p><button className="button button-primary" onClick={() => location.reload()}>Tải lại website</button></div></main>
  }
}
