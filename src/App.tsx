import { useEffect, useRef, useState } from 'react'

const MODEL_CHOICES = ['tiny.en', 'small.en', 'base.en', 'medium.en']
type StepState = 'idle' | 'running' | 'done' | 'error'
const STEP_COLORS: Record<StepState, string> = {
  idle: '#9e9e9e',
  running: '#e67e22',
  done: '#2e7d32',
  error: '#c62828',
}
const STEP_LABELS: Record<StepState, string> = {
  idle: 'idle',
  running: 'in progress',
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
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [blinkOn, setBlinkOn] = useState(false)
  const recordingStartRef = useRef<number | null>(null)
  const [transcript, setTranscript] = useState('')
  const [sessionDir, setSessionDir] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await (window as any).backend.listDevices()
        if (res && res.devices) setDevices(res.devices)
      } catch (e) {
        console.error('listDevices failed', e)
      }
    })()

    ;(window as any).backend.onSession((_ev: any, data: any) => {
      setSessionDir(data.sessionDir || null)
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
      // append summary below transcript for now
      setTranscript((prev) => prev + '\n\n--- Summary ---\n' + text)
    })

    ;(window as any).backend.onSummaryStatus((_ev: any, data: any) => {
      const state = data.state === 'starting' || data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setSummarizationState(state)
      if (state === 'running') setStatus('summarizing')
      if (state === 'done') setStatus('summary-ready')
      if (state === 'error') setStatus('summary-error')
      setStatusDetail(data.message || '')
    })
  }, [])

  useEffect(() => {
    if (recordingState !== 'running') {
      setBlinkOn(false)
      return
    }
    const interval = setInterval(() => {
      setBlinkOn((prev) => !prev)
      if (recordingStartRef.current) {
        const elapsed = Math.floor((Date.now() - recordingStartRef.current) / 1000)
        setElapsedSeconds(elapsed)
      }
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

  const onStart = () => {
    setTranscript('')
    setStatus('recording')
    setStatusDetail('recording audio')
    setRecordingState('running')
    setTranscriptionState('idle')
    setSummarizationState('idle')
    setSessionDir(null)
    recordingStartRef.current = Date.now()
    setElapsedSeconds(0)
    setRunning(true)
    ;(window as any).backend.start({ deviceIndex: selectedDevice, model })
  }

  const onStop = () => {
    setStatus('stopping')
    setStatusDetail('stopping recording')
    setRecordingState('done')
    setTranscriptionState('running')
    ;(window as any).backend.stop()
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Meeting Notes</h1>

      <div style={{ marginBottom: 16, textAlign: 'left', border: '1px solid #2f2f2f', borderRadius: 8, padding: 12, background: '#1b1b1b', color: '#f5f5f5' }}>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>Session status</div>
        {sessionDir ? <div style={{ marginBottom: 8, color: '#c7c7c7' }}>Session: {sessionDir}</div> : <div style={{ marginBottom: 8, color: '#9b9b9b' }}>Session: (not started)</div>}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: STEP_COLORS[recordingState], display: 'inline-block', marginRight: 8 }} />
          <span style={{ width: 120, fontWeight: 600 }}>Recording</span>
          <span style={{ minWidth: 90 }}>{STEP_LABELS[recordingState]}</span>
          {recordingState === 'running' ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: blinkOn ? '#ff3b30' : '#4b1b1b',
                  boxShadow: blinkOn ? '0 0 6px #ff3b30' : 'none',
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
        {statusDetail ? <div style={{ marginTop: 8, color: '#c7c7c7' }}>{statusDetail}</div> : null}
      </div>

      <div style={{ marginBottom: 8 }}>
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

      <div style={{ marginBottom: 8 }}>
        <label>Model: </label>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {MODEL_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 12 }}>
        <button onClick={onStart} disabled={running}>
          Start
        </button>
        <button onClick={onStop} disabled={!running} style={{ marginLeft: 10 }}>
          Stop
        </button>
        <span style={{ marginLeft: 12 }}>{status}</span>
      </div>

      <div>
        <h3>Transcript</h3>
        <div style={{ whiteSpace: 'pre-wrap', background: '#151515', color: '#f1f1f1', padding: 10, minHeight: 160, border: '1px solid #2b2b2b', borderRadius: 6 }}>{transcript || '(empty)'}</div>
        {sessionDir ? (
          <div style={{ marginTop: 8 }}>
            Session saved: <a href={`file://${sessionDir}`}>{sessionDir}</a>
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
    </div>
  )
}

export default App
