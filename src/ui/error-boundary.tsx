import React from 'react'

/**
 * Last-resort boundary so a render throw degrades to a reload card instead of
 * a blank, dead app. Inline styles only — must render even if Tailwind or the
 * store are the thing that broke.
 */
interface ErrorBoundaryProps {
  children?: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

// No @types/react in this project — React.Component is untyped, so declare
// the instance members the class relies on.
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  declare props: ErrorBoundaryProps
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[error-boundary]', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#101014',
          color: '#f2f2f2',
          fontFamily: 'system-ui, sans-serif',
          zIndex: 9999,
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 360, padding: 24 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Something broke</div>
          <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 20, wordBreak: 'break-word' }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px',
              borderRadius: 999,
              border: 'none',
              background: '#f2f2f2',
              color: '#101014',
              fontWeight: 700,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}

/** Global catch-alls: log instead of dying silently (or noisily, on Quest). */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    console.error('[global] uncaught error:', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[global] unhandled rejection:', event.reason)
    // Suppress Quest Browser's intrusive overlay; the log above still lands.
    event.preventDefault()
  })
}
