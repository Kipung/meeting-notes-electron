import { useEffect, useRef, useState } from 'react'

const MODEL_CHOICES = ['tiny.en', 'small.en', 'base.en', 'medium.en']
type StepState = 'idle' | 'running' | 'paused' | 'done' | 'error'
const STEP_COLORS: Record<StepState, string> = {
  idle: '#9e9e9e',
  running: '#e67e22',
  paused: '#f1c40f',
  done: '#2e7d32',
  error: '#c62828',
}
const STEP_LABELS: Record<StepState, string> = {
  idle: 'idle',
  running: 'in progress',
  paused: 'paused',
  done: 'done',
  error: 'error',
}

function App() {
  const [devices, setDevices] = useState<any[]>([])
  const [selectedDevice, setSelectedDevice] = useState<number | null>(null)
  const [model, setModel] = useState<string>('small.en')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('idle')
  const [statusDetail, setStatusDetail] = useState('')
  const [recordingState, setRecordingState] = useState<StepState>('idle')
  const [transcriptionState, setTranscriptionState] = useState<StepState>('idle')
  const [summarizationState, setSummarizationState] = useState<StepState>('idle')
  const [setupState, setSetupState] = useState<StepState>('idle')
  const [setupMessage, setSetupMessage] = useState('')
  const [setupPercent, setSetupPercent] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [blinkOn, setBlinkOn] = useState(false)
  const recordingStartRef = useRef<number | null>(null)
  const pauseStartRef = useRef<number | null>(null)
  const pausedMsRef = useRef(0)
  const [transcript, setTranscript] = useState('')
  const [summary, setSummary] = useState('')
  const [sessionDir, setSessionDir] = useState<string | null>(null)
  const [sessionsRoot, setSessionsRoot] = useState<string | null>(null)
  const [studentId, setStudentId] = useState('')
  const [studentName, setStudentName] = useState('')

  const getElapsedSeconds = () => {
    if (!recordingStartRef.current) return 0
    const now = Date.now()
    const pausedMs = pausedMsRef.current + (pauseStartRef.current ? now - pauseStartRef.current : 0)
    return Math.max(0, Math.floor((now - recordingStartRef.current - pausedMs) / 1000))
  }

  useEffect(() => {
    ;(async () => {
      try {
        const res = await (window as any).backend.listDevices()
        if (res && res.devices) setDevices(res.devices)
      } catch (e) {
        console.error('listDevices failed', e)
      }
    })()

    ;(async () => {
      try {
        const root = await (window as any).backend.getSessionsRoot()
        if (root) setSessionsRoot(root)
      } catch (e) {
        console.error('getSessionsRoot failed', e)
      }
    })()

    ;(window as any).backend.onSession((_ev: any, data: any) => {
      setSessionDir(data.sessionDir || null)
      if (data.sessionsRoot) setSessionsRoot(data.sessionsRoot)
    })

    ;(window as any).backend.onTranscript((_ev: any, data: any) => {
      setTranscript(data.text || '')
      setSessionDir(data.sessionDir || null)
      setStatus('transcript-ready')
      setStatusDetail('transcription complete')
      setTranscriptionState('done')
      setRunning(false)
    })

    ;(window as any).backend.onTranscriptionStatus((_ev: any, data: any) => {
      const state = data.state === 'starting' || data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setTranscriptionState(state)
      if (state === 'running') setStatus('transcribing')
      if (state === 'done') setStatus('transcript-ready')
      if (state === 'error') setStatus('transcription-error')
      setStatusDetail(data.message || '')
    })

    ;(window as any).backend.onSummary((_ev: any, data: any) => {
      setStatus('summary-ready')
      setStatusDetail('summary ready')
      setSummarizationState('done')
      const text = data.text || ''
      setSummary(text)
    })

    ;(window as any).backend.onSummaryStatus((_ev: any, data: any) => {
      const state = data.state === 'starting' || data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setSummarizationState(state)
      if (state === 'running') setStatus('summarizing')
      if (state === 'done') setStatus('summary-ready')
      if (state === 'error') setStatus('summary-error')
      setStatusDetail(data.message || '')
    })

    ;(window as any).backend.onBootstrapStatus((_ev: any, data: any) => {
      const state = data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setSetupState(state)
      setSetupMessage(data.message || '')
      setSetupPercent(typeof data.percent === 'number' ? data.percent : null)
    })
  }, [])

  useEffect(() => {
    if (recordingState !== 'running') {
      setBlinkOn(false)
      return
    }
    const interval = setInterval(() => {
      setBlinkOn((prev) => !prev)
      setElapsedSeconds(getElapsedSeconds())
    }, 500)
    return () => clearInterval(interval)
  }, [recordingState])

  const formatElapsed = (secs: number) => {
    const hours = Math.floor(secs / 3600)
    const minutes = Math.floor((secs % 3600) / 60)
    const seconds = secs % 60
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  const normalizePath = (value: string) => value.replace(/\\/g, '/')
  const compactPath = (value: string, root?: string | null) => {
    const raw = normalizePath(value)
    if (root) {
      const rootNorm = normalizePath(root).replace(/\/+$/, '')
      const rawLower = raw.toLowerCase()
      const rootLower = rootNorm.toLowerCase()
      if (rawLower.startsWith(`${rootLower}/`)) {
        const rel = raw.slice(rootNorm.length + 1)
        const rootName = rootNorm.split('/').filter(Boolean).pop()
        return rootName ? `${rootName}/${rel}` : rel
      }
    }
    const parts = raw.split('/').filter(Boolean)
    if (parts.length <= 2) return raw
    return `.../${parts.slice(-2).join('/')}`
  }

  const onStart = () => {
    setTranscript('')
    setSummary('')
    setStatus('recording')
    setStatusDetail('recording audio')
    setRecordingState('running')
    setTranscriptionState('idle')
    setSummarizationState('idle')
    setSessionDir(null)
    recordingStartRef.current = Date.now()
    pauseStartRef.current = null
    pausedMsRef.current = 0
    setElapsedSeconds(0)
    setRunning(true)
    ;(window as any).backend.start({ deviceIndex: selectedDevice, model })
  }

  const onStop = () => {
    if (pauseStartRef.current) {
      pausedMsRef.current += Date.now() - pauseStartRef.current
      pauseStartRef.current = null
    }
    setStatus('stopping')
    setStatusDetail('stopping recording')
    setRecordingState('done')
    setTranscriptionState('running')
    ;(window as any).backend.stop()
  }

  const onPauseToggle = () => {
    if (!running) return
    if (recordingState === 'running') {
      pauseStartRef.current = Date.now()
      setElapsedSeconds(getElapsedSeconds())
      setStatus('paused')
      setStatusDetail('recording paused')
      setRecordingState('paused')
      ;(window as any).backend.pause()
      return
    }
    if (recordingState === 'paused') {
      if (pauseStartRef.current) {
        pausedMsRef.current += Date.now() - pauseStartRef.current
        pauseStartRef.current = null
      }
      setElapsedSeconds(getElapsedSeconds())
      setStatus('recording')
      setStatusDetail('recording audio')
      setRecordingState('running')
      ;(window as any).backend.resume()
    }
  }

  const copyToClipboard = (text: string) => {
    if (!text) return
    navigator.clipboard.writeText(text).catch((err) => {
      console.error('copy to clipboard failed', err)
    })
  }

  const canPause = running && (recordingState === 'running' || recordingState === 'paused')
  const studentInfo = [studentId ? `Student ID: ${studentId}` : '', studentName ? `Student Name: ${studentName}` : '']
    .filter(Boolean)
    .join('\n')
  const summaryWithStudent = summary && studentInfo ? `${summary}\n\n${studentInfo}` : summary
  const sessionDirLabel = sessionDir ? compactPath(sessionDir, sessionsRoot) : null
  const sessionsRootLabel = sessionsRoot ? compactPath(sessionsRoot) : '(loading...)'

  const onChangeSaveLocation = async () => {
    try {
      const nextRoot = await (window as any).backend.chooseSessionsRoot()
      if (nextRoot) setSessionsRoot(nextRoot)
    } catch (e) {
      console.error('chooseSessionsRoot failed', e)
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 28, margin: '0 0 12px' }}>Meeting Notes</h1>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ flex: '1 1 360px', textAlign: 'left', border: '1px solid #2f2f2f', borderRadius: 8, padding: 12, background: '#1b1b1b', color: '#f5f5f5' }}>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>Session status</div>
          {sessionDir ? (
            <div style={{ marginBottom: 8, color: '#c7c7c7' }}>
              Session: <span title={sessionDir}>{sessionDirLabel}</span>
            </div>
          ) : (
            <div style={{ marginBottom: 8, color: '#9b9b9b' }}>Session: (not started)</div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: STEP_COLORS[setupState], display: 'inline-block', marginRight: 8 }} />
            <span style={{ width: 120, fontWeight: 600 }}>Setup</span>
            <span style={{ minWidth: 90 }}>{STEP_LABELS[setupState]}</span>
            {setupState === 'running' && typeof setupPercent === 'number' ? <span style={{ marginLeft: 8, color: '#c7c7c7' }}>{setupPercent}%</span> : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: STEP_COLORS[recordingState], display: 'inline-block', marginRight: 8 }} />
            <span style={{ width: 120, fontWeight: 600 }}>Recording</span>
            <span style={{ minWidth: 90 }}>{STEP_LABELS[recordingState]}</span>
            {recordingState === 'running' || recordingState === 'paused' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: recordingState === 'running' ? (blinkOn ? '#ff3b30' : '#4b1b1b') : '#8e8e8e',
                    boxShadow: recordingState === 'running' && blinkOn ? '0 0 6px #ff3b30' : 'none',
                    display: 'inline-block',
                  }}
                />
                <span style={{ color: '#c7c7c7' }}>{formatElapsed(elapsedSeconds)}</span>
              </span>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: STEP_COLORS[transcriptionState], display: 'inline-block', marginRight: 8 }} />
            <span style={{ width: 120, fontWeight: 600 }}>Transcribing</span>
            <span>{STEP_LABELS[transcriptionState]}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: STEP_COLORS[summarizationState], display: 'inline-block', marginRight: 8 }} />
            <span style={{ width: 120, fontWeight: 600 }}>Summarizing</span>
            <span>{STEP_LABELS[summarizationState]}</span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#c7c7c7' }}>Save location:</span>
            <span title={sessionsRoot || ''}>{sessionsRootLabel}</span>
            <button onClick={onChangeSaveLocation} disabled={running || setupState === 'running'}>
              Change
            </button>
          </div>
          {setupMessage ? <div style={{ marginTop: 8, color: '#c7c7c7' }}>{setupMessage}</div> : null}
          {statusDetail ? <div style={{ marginTop: 8, color: '#c7c7c7' }}>{statusDetail}</div> : null}
        </div>

        <div style={{ flex: '1 1 320px', textAlign: 'left' }}>
          <div style={{ marginBottom: 8 }}>
            <div style={{ marginBottom: 6, fontWeight: 600 }}>Student info</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Student ID</span>
                <input
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  placeholder="e.g. 20231234"
                  style={{ minWidth: 200 }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Student Name</span>
                <input
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  placeholder="e.g. Kim Minji"
                  style={{ minWidth: 220 }}
                />
              </label>
            </div>
          </div>

          <div style={{ marginBottom: 6 }}>
            <label>Input device: </label>
            <select value={selectedDevice ?? ''} onChange={(e) => setSelectedDevice(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">Default input</option>
              {devices.map((d) => (
                <option key={d.index} value={d.index}>
                  {d.index}: {d.name} (in:{d.maxInputChannels} out:{d.maxOutputChannels})
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 6 }}>
            <label>Model: </label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODEL_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 6 }}>
            <button onClick={onStart} disabled={running || setupState !== 'done'}>
              Start
            </button>
            <button onClick={onStop} disabled={!running} style={{ marginLeft: 10 }}>
              Stop
            </button>
            <button onClick={onPauseToggle} disabled={!canPause} style={{ marginLeft: 10 }}>
              {recordingState === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <span style={{ marginLeft: 12 }}>{status}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 360px' }}>
          <h3>Transcript</h3>
          <button onClick={() => copyToClipboard(transcript)} disabled={!transcript} style={{ marginBottom: 8 }}>
            Copy transcript
          </button>
          <div style={{ whiteSpace: 'pre-wrap', background: '#151515', color: '#f1f1f1', padding: 10, minHeight: 160, border: '1px solid #2b2b2b', borderRadius: 6 }}>{transcript || '(empty)'}</div>
          {sessionDir ? (
            <div style={{ marginTop: 8 }}>
              Session saved: <a href={`file://${sessionDir}`} title={sessionDir}>{sessionDirLabel}</a>
              <div style={{ marginTop: 6 }}>
                <button onClick={() => {
                  // open session folder in OS file manager
                  const url = `file://${sessionDir}`
                  window.open(url)
                }}>Open Session Folder</button>
              </div>
            </div>
          ) : null}
        </div>

        <div style={{ flex: '1 1 360px' }}>
          <h3>Summary</h3>
          <button onClick={() => copyToClipboard(summaryWithStudent)} disabled={!summary} style={{ marginBottom: 8 }}>
            Copy summary
          </button>
          <div style={{ whiteSpace: 'pre-wrap', background: '#151515', color: '#f1f1f1', padding: 10, minHeight: 160, border: '1px solid #2b2b2b', borderRadius: 6 }}>{summaryWithStudent || '(empty)'}</div>
        </div>
      </div>
    </div>
  )
}

export default App
