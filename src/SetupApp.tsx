import { useEffect, useState } from 'react'

type Phase = 'downloading' | 'complete' | 'error'

type ProgressData = {
  percent: number
  message: string
  downloaded?: number
  total?: number
}

declare global {
  interface Window {
    setupApi: {
      startDownload: () => Promise<void>
      onProgress: (cb: (data: ProgressData) => void) => () => void
      onComplete: (cb: () => void) => () => void
      onError: (cb: (data: { message: string }) => void) => () => void
    }
  }
}

export default function SetupApp() {
  const [phase, setPhase] = useState<Phase>('downloading')
  const [percent, setPercent] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')

  async function startDownload() {
    setPhase('downloading')
    setPercent(0)
    try {
      await window.setupApi.startDownload()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  useEffect(() => {
    const unsubProgress = window.setupApi.onProgress((data) => {
      setPercent((prev) => Math.max(prev, data.percent))
    })
    const unsubComplete = window.setupApi.onComplete(() => {
      setPhase('complete')
    })
    const unsubError = window.setupApi.onError((data) => {
      setErrorMessage(data.message)
      setPhase('error')
    })

    void startDownload()

    return () => {
      unsubProgress()
      unsubComplete()
      unsubError()
    }
  }, [])

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.logo}>🎙️</div>
        <h1 style={styles.title}>SSC Meeting Helper</h1>

        {phase === 'downloading' && (
          <>
            <p style={styles.description}>
              Setting up for the first time. The app will start automatically once ready — this won't happen again.
            </p>
            <div style={styles.progressContainer}>
              <div style={{ ...styles.progressBar, width: `${percent}%` }} />
            </div>
            <p style={styles.percent}>{percent}%</p>
          </>
        )}

        {phase === 'complete' && (
          <p style={styles.description}>All done! The app will open shortly.</p>
        )}

        {phase === 'error' && (
          <>
            <p style={styles.errorText}>{errorMessage}</p>
            <button style={styles.button} onClick={startDownload}>
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    backgroundColor: '#1a1a2e',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#e0e0e0',
    padding: '24px',
    boxSizing: 'border-box',
  },
  card: {
    backgroundColor: '#16213e',
    borderRadius: '16px',
    padding: '40px',
    maxWidth: '400px',
    width: '100%',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    textAlign: 'center',
  },
  logo: {
    fontSize: '48px',
    marginBottom: '12px',
  },
  title: {
    fontSize: '22px',
    fontWeight: 700,
    marginBottom: '20px',
    color: '#ffffff',
  },
  description: {
    fontSize: '14px',
    lineHeight: 1.6,
    color: '#b0b8c8',
    marginBottom: '20px',
  },
  progressContainer: {
    backgroundColor: '#0f3460',
    borderRadius: '8px',
    height: '8px',
    overflow: 'hidden',
    marginBottom: '10px',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#e94560',
    borderRadius: '8px',
    transition: 'width 0.3s ease',
  },
  percent: {
    fontSize: '12px',
    color: '#7f8fa6',
    margin: 0,
  },
  button: {
    backgroundColor: '#e94560',
    color: '#ffffff',
    border: 'none',
    borderRadius: '8px',
    padding: '12px 32px',
    fontSize: '15px',
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
    marginTop: '12px',
  },
  errorText: {
    fontSize: '12px',
    color: '#e74c3c',
    marginBottom: '8px',
    wordBreak: 'break-word',
  },
}
