import { useEffect, useRef, useState } from 'react'
import './App.css'

const DEFAULT_WHISPER_MODEL = 'small.en'
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

const getTodayDateString = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function App() {
  const [devices, setDevices] = useState<any[]>([])
  const [selectedDevice, setSelectedDevice] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('idle')
  const [statusDetail, setStatusDetail] = useState('')
  const [recordingState, setRecordingState] = useState<StepState>('idle')
  const [transcriptionState, setTranscriptionState] = useState<StepState>('idle')
  const [summarizationState, setSummarizationState] = useState<StepState>('idle')
  const [setupState, setSetupState] = useState<StepState>('idle')
  const [setupMessage, setSetupMessage] = useState('')
  const [setupPercent, setSetupPercent] = useState<number | null>(null)
  const [recorderReady, setRecorderReady] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [blinkOn, setBlinkOn] = useState(false)
  const recordingStartRef = useRef<number | null>(null)
  const pauseStartRef = useRef<number | null>(null)
  const pausedMsRef = useRef(0)
  const [transcript, setTranscript] = useState('')
  const [summary, setSummary] = useState('')
  const [sessionDir, setSessionDir] = useState<string | null>(null)
  const [sessionsRoot, setSessionsRoot] = useState<string | null>(null)
  const [sessionDate, setSessionDate] = useState(() => getTodayDateString())
  const [sessionModality, setSessionModality] = useState('Email')
  const [sessionSubject, setSessionSubject] = useState('')
  const [coachInitials, setCoachInitials] = useState('')
  const [studentId, setStudentId] = useState('')
  const [studentName, setStudentName] = useState('')
  const [audioDeleteMessage, setAudioDeleteMessage] = useState('')
  const [followUpEmail, setFollowUpEmail] = useState('')
  const [followUpInstructions, setFollowUpInstructions] = useState('')
  const [followUpGenerating, setFollowUpGenerating] = useState(false)
  const [followUpStatus, setFollowUpStatus] = useState('')
  const [processingRecordingFile, setProcessingRecordingFile] = useState(false)

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

    const offSession = (window as any).backend.onSession((_ev: any, data: any) => {
      setSessionDir(data.sessionDir || null)
      if (data.sessionsRoot) setSessionsRoot(data.sessionsRoot)
      setAudioDeleteMessage('')
    })

    const offTranscript = (window as any).backend.onTranscript((_ev: any, data: any) => {
      setTranscript(data.text || '')
      setSessionDir(data.sessionDir || null)
      setStatus('transcript-ready')
      setStatusDetail('transcription complete')
      setTranscriptionState('done')
      setRunning(false)
    })

    const offTranscriptPartial = (window as any).backend.onTranscriptPartial((_ev: any, data: any) => {
      const next = data.fullText || data.text || ''
      if (next) setTranscript(next)
      if (data.sessionDir) setSessionDir(data.sessionDir)
    })

    const offTranscriptionStatus = (window as any).backend.onTranscriptionStatus((_ev: any, data: any) => {
      const state = data.state === 'starting' || data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setTranscriptionState(state)
      if (state === 'running') setStatus('transcribing')
      if (state === 'done') setStatus('transcript-ready')
      if (state === 'error') setStatus('transcription-error')
      setStatusDetail(data.message || '')
    })

    const offRecordingReady = (window as any).backend.onRecordingReady((_ev: any, data: any) => {
      setRecorderReady(Boolean(data?.ready))
    })

    const offRecordingStarted = (window as any).backend.onRecordingStarted((_ev: any, data: any) => {
      const startedAtMs = typeof data?.startedAtMs === 'number' ? data.startedAtMs : Date.now()
      recordingStartRef.current = startedAtMs
      pauseStartRef.current = null
      pausedMsRef.current = 0
      setElapsedSeconds(0)
    })

    const offSummary = (window as any).backend.onSummary((_ev: any, data: any) => {
      setStatus('summary-ready')
      setStatusDetail('summary ready')
      setSummarizationState('done')
      const text = data.text || ''
      setSummary(text)
      setFollowUpEmail('')
      setFollowUpStatus('')
      setFollowUpGenerating(false)
    })

    const offSummaryStream = (window as any).backend.onSummaryStream((_ev: any, data: any) => {
      if (!data) return
      if (data.reset) {
        setSummary('')
        setFollowUpEmail('')
        setFollowUpStatus('')
        setFollowUpGenerating(false)
        return
      }
      const delta = typeof data.delta === 'string' ? data.delta : ''
      if (delta) setSummary((prev) => prev + delta)
    })

    const offSummaryStatus = (window as any).backend.onSummaryStatus((_ev: any, data: any) => {
      const state = data.state === 'starting' || data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setSummarizationState(state)
      if (state === 'running') setStatus('summarizing')
      if (state === 'done') setStatus('summary-ready')
      if (state === 'error') setStatus('summary-error')
      setStatusDetail(data.message || '')
    })

    const offBootstrapStatus = (window as any).backend.onBootstrapStatus((_ev: any, data: any) => {
      const state = data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setSetupState(state)
      setSetupMessage(data.message || '')
      setSetupPercent(typeof data.percent === 'number' ? data.percent : null)
    })
    return () => {
      offSession()
      offTranscript()
      offTranscriptPartial()
      offTranscriptionStatus()
      offRecordingReady()
      offRecordingStarted()
      offSummary()
      offSummaryStream()
      offSummaryStatus()
      offBootstrapStatus()
    }
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
    setFollowUpEmail('')
    setFollowUpStatus('')
    setFollowUpGenerating(false)
    setSessionDate(getTodayDateString())
    setStatus('recording')
    setStatusDetail('recording audio')
    setRecordingState('running')
    setTranscriptionState('idle')
    setSummarizationState('idle')
    setSessionDir(null)
    recordingStartRef.current = null
    pauseStartRef.current = null
    pausedMsRef.current = 0
    setElapsedSeconds(0)
    setRunning(true)
    setAudioDeleteMessage('')
    ;(window as any).backend.start({ deviceIndex: selectedDevice, model: DEFAULT_WHISPER_MODEL })
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

  const onProcessRecordingFile = async () => {
    if (processingRecordingFile) return
    setProcessingRecordingFile(true)
    setStatus('transcribing')
    setStatusDetail('processing uploaded recording...')
    try {
      const res = await (window as any).backend.processRecording()
      if (!res?.ok) {
        setStatus('transcription-error')
        setStatusDetail(res?.error || 'failed to process recording')
      }
    } catch (e) {
      console.error('processRecording failed', e)
      setStatus('transcription-error')
      setStatusDetail('Failed to start transcription')
    } finally {
      setProcessingRecordingFile(false)
    }
  }

  const canPause = running && (recordingState === 'running' || recordingState === 'paused')
  const canDeleteAudio = Boolean(sessionDir) && transcriptionState === 'done' && recordingState !== 'running' && recordingState !== 'paused'
  const followUpActionLabel = followUpGenerating ? 'Generating...' : followUpEmail ? 'Regenerate from summary' : 'Generate from summary'
  const studentInfo = [studentId ? `Student ID: ${studentId}` : '', studentName ? `Student Name: ${studentName}` : '']
    .filter(Boolean)
    .join('\n')
  const sessionDetailsLine = summary
    ? (() => {
        const baseParts = [
          sessionDate || '',
          sessionModality || '',
          sessionSubject ? `re: ${sessionSubject}` : '',
        ].filter(Boolean)
        let line = baseParts.join(' ')
        if (coachInitials) {
          line = line ? `${line} - ${coachInitials}` : coachInitials
        }
        return line
      })()
    : ''
  const summaryWithMeta = summary
    ? [
        studentInfo,
        sessionDetailsLine,
        summary,
      ]
        .filter(Boolean)
        .join('\n\n')
    : summary
  const sessionDirLabel = sessionDir ? compactPath(sessionDir, sessionsRoot) : null
  const sessionsRootLabel = sessionsRoot ? compactPath(sessionsRoot) : '(loading...)'
  const primaryActionLabel = !running ? 'Start' : recordingState === 'paused' ? 'Resume' : 'Pause'
  const primaryActionColor = !running ? '#ff3b30' : '#f1f1f1'
  const primaryActionIcon = !running ? (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="currentColor" />
    </svg>
  ) : recordingState === 'paused' ? (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <polygon points="4,2.5 11,7 4,11.5" fill="currentColor" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="3" y="2.5" width="3" height="9" fill="currentColor" />
      <rect x="8" y="2.5" width="3" height="9" fill="currentColor" />
    </svg>
  )
  const stopIcon = (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" fill="currentColor" />
    </svg>
  )
  const onPrimaryToggle = () => {
    if (!running) {
      onStart()
      return
    }
    onPauseToggle()
  }

  const onChangeSaveLocation = async () => {
    try {
      const nextRoot = await (window as any).backend.chooseSessionsRoot()
      if (nextRoot) setSessionsRoot(nextRoot)
    } catch (e) {
      console.error('chooseSessionsRoot failed', e)
    }
  }

  const onGenerateFollowUpEmail = async () => {
    if (!summary || followUpGenerating) return
    setFollowUpGenerating(true)
    setFollowUpStatus('Generating follow-up email...')
    try {
      const res = await (window as any).backend.generateFollowUpEmail({
        summary,
        studentName: studentName.trim() || undefined,
        instructions: followUpInstructions,
      })
      if (res && res.ok) {
        setFollowUpEmail(res.text || '')
        setFollowUpStatus('')
      } else {
        setFollowUpStatus(res?.error || 'Failed to generate follow-up email.')
      }
    } catch (e) {
      console.error('generateFollowUpEmail failed', e)
      setFollowUpStatus('Failed to generate follow-up email.')
    } finally {
      setFollowUpGenerating(false)
    }
  }

  const onDeleteAudio = async () => {
    if (!sessionDir || !canDeleteAudio) return
    const ok = window.confirm('Delete audio for this session? This removes audio.wav and any chunk .wav files.')
    if (!ok) return
    setAudioDeleteMessage('Deleting session audio...')
    try {
      const res = await (window as any).backend.deleteSessionAudio(sessionDir)
      if (res && res.ok) {
        const deletedCount = Array.isArray(res.deleted) ? res.deleted.length : 0
        setAudioDeleteMessage(deletedCount > 0 ? 'Session audio deleted.' : 'No audio files found.')
      } else {
        setAudioDeleteMessage(res?.error || 'Failed to delete session audio.')
      }
    } catch (e) {
      console.error('deleteSessionAudio failed', e)
      setAudioDeleteMessage('Failed to delete session audio.')
    }
  }

  return (
    <div className="app-shell">
      <h1 style={{ fontSize: 24, margin: '0 0 10px' }}>Meeting Notes</h1>

      <div className="app-columns">
        <div className="status-card" style={{ textAlign: 'left', border: '1px solid #2f2f2f', borderRadius: 8, padding: 12, background: '#1b1b1b', color: '#f5f5f5' }}>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>Session status</div>
          {sessionDir ? (
            <div style={{ marginBottom: 8, color: '#c7c7c7' }}>
              Session: <span className="path-label" title={sessionDir}>{sessionDirLabel}</span>
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
            <span className="path-label" title={sessionsRoot || ''}>{sessionsRootLabel}</span>
            <button
              onClick={onChangeSaveLocation}
              disabled={running || setupState === 'running'}
              style={{
                border: '1px solid #3a3a3a',
                background: '#202020',
                color: '#f1f1f1',
                padding: '4px 10px',
                borderRadius: 6,
                cursor: running || setupState === 'running' ? 'not-allowed' : 'pointer',
              }}
            >
              Change Folder
            </button>
          </div>
          {sessionDir ? (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: '#c7c7c7' }}>Audio:</span>
              <button
                onClick={onDeleteAudio}
                disabled={!canDeleteAudio}
                style={{
                  border: '1px solid #5a2a2a',
                  background: '#2a1616',
                  color: '#f1f1f1',
                  padding: '4px 10px',
                  borderRadius: 6,
                  cursor: canDeleteAudio ? 'pointer' : 'not-allowed',
                }}
              >
                Delete Audio
              </button>
              <span style={{ color: '#9b9b9b' }}>
                {canDeleteAudio ? 'Removes audio.wav and chunk .wav files.' : 'Available after transcription is done.'}
              </span>
            </div>
          ) : null}
          {setupMessage ? <div style={{ marginTop: 8, color: '#c7c7c7' }}>{setupMessage}</div> : null}
          {statusDetail ? <div style={{ marginTop: 8, color: '#c7c7c7' }}>{statusDetail}</div> : null}
          {audioDeleteMessage ? <div style={{ marginTop: 8, color: '#c7c7c7' }}>{audioDeleteMessage}</div> : null}
        </div>

        <div className="details-panel" style={{ textAlign: 'left' }}>
          <div style={{ marginBottom: 6 }}>
            <div style={{ marginBottom: 6, fontWeight: 600 }}>Session details</div>
            <div className="form-row">
              <label className="field field--modality">
                <span>Modality</span>
                <select value={sessionModality} onChange={(e) => setSessionModality(e.target.value)} style={{ width: '100%' }}>
                  <option value="Email">Email</option>
                  <option value="Walk-In">Walk-In</option>
                  <option value="Virtual Office Hour">Virtual Office Hour</option>
                  <option value="Phone">Phone</option>
                  <option value="Virtual Appointment">Virtual Appointment</option>
                  <option value="Phone Appointment">Phone Appointment</option>
                  <option value="In Person Appointment">In Person Appointment</option>
                </select>
              </label>
              <label className="field field--subject">
                <span>Subject</span>
                <input
                  value={sessionSubject}
                  onChange={(e) => setSessionSubject(e.target.value)}
                  style={{ width: '100%' }}
                />
              </label>
            </div>
          </div>

          <div style={{ marginBottom: 6 }}>
            <div style={{ marginBottom: 6, fontWeight: 600 }}>Student info</div>
            <div className="form-row">
              <label className="field field--student-id">
                <span>Student ID</span>
                <input
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  style={{ width: '100%' }}
                />
              </label>
              <label className="field field--student-name">
                <span>Student Name</span>
                <input
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  style={{ width: '100%' }}
                />
              </label>
              <label className="field field--coach">
                <span>Coach</span>
                <input
                  value={coachInitials}
                  onChange={(e) => setCoachInitials(e.target.value)}
                  style={{ width: '100%' }}
                />
              </label>
            </div>
          </div>

          <div className="form-inline" style={{ marginBottom: 6 }}>
            <label>Input device: </label>
            <select className="form-inline__control" value={selectedDevice ?? ''} onChange={(e) => setSelectedDevice(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">Default input</option>
              {devices.map((d) => (
                <option key={d.index} value={d.index}>
                  {d.index}: {d.name} (in:{d.maxInputChannels} out:{d.maxOutputChannels})
                </option>
              ))}
            </select>
          </div>

          <div className="control-row" style={{ marginBottom: 6 }}>
            <button
              onClick={onPrimaryToggle}
              disabled={setupState !== 'done' || !recorderReady || (running && !canPause)}
              title={primaryActionLabel}
              aria-label={primaryActionLabel}
              style={{
                width: 30,
                height: 30,
                borderRadius: 999,
                border: '1px solid #2b2b2b',
                background: '#151515',
                color: primaryActionColor,
                cursor: setupState !== 'done' || !recorderReady || (running && !canPause) ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                opacity: setupState !== 'done' || !recorderReady || (running && !canPause) ? 0.5 : 1,
              }}
            >
              {primaryActionIcon}
            </button>
            <button
              onClick={onStop}
              disabled={!running}
              title="Stop"
              aria-label="Stop"
              style={{
                width: 30,
                height: 30,
                borderRadius: 999,
                border: '1px solid #2b2b2b',
                background: '#151515',
                color: '#f1f1f1',
                cursor: !running ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                opacity: !running ? 0.5 : 1,
              }}
            >
              {stopIcon}
            </button>
            {recordingState === 'running' || recordingState === 'paused' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
                <span style={{ color: '#c7c7c7', minWidth: 56, textAlign: 'right', display: 'inline-block' }}>
                  {formatElapsed(elapsedSeconds)}
                </span>
              </span>
            ) : null}
            <span style={{ marginLeft: 4 }}>{status}</span>
          </div>
        </div>
      </div>

      <div className="output-columns">
        <div className="output-panel">
          <h3>Transcript</h3>
          <div style={{ marginBottom: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => copyToClipboard(transcript)} disabled={!transcript}>
              Copy transcript
            </button>
            <button onClick={onProcessRecordingFile} disabled={processingRecordingFile || running}>
              {processingRecordingFile ? 'Processing...' : 'Process recording file'}
            </button>
          </div>
          <div className="output-panel__body output-panel__body--scrollable">{transcript || '(empty)'}</div>
        </div>

        <div className="output-panel">
          <h3>Summary</h3>
          <button onClick={() => copyToClipboard(summaryWithMeta)} disabled={!summary} style={{ marginBottom: 8 }}>
            Copy summary
          </button>
          <div className="output-panel__body">{summaryWithMeta || '(empty)'}</div>
        </div>

        <div className="output-panel">
          <h3>Follow-up Email</h3>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', marginBottom: 6, color: '#c7c7c7' }}>Email instructions (optional)</label>
            <textarea
              value={followUpInstructions}
              onChange={(e) => setFollowUpInstructions(e.target.value)}
              placeholder="Hints: brief, bullets, omit action items; subject: ...; greeting: ...; closing: ...; signature: ..."
              rows={3}
              style={{ width: '100%', background: '#151515', color: '#f1f1f1', border: '1px solid #2b2b2b', borderRadius: 6, padding: 8 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button onClick={onGenerateFollowUpEmail} disabled={!summary || followUpGenerating}>
              {followUpActionLabel}
            </button>
            <button onClick={() => copyToClipboard(followUpEmail)} disabled={!followUpEmail}>
              Copy email
            </button>
          </div>
          {followUpStatus ? <div style={{ marginBottom: 8, color: '#c7c7c7' }}>{followUpStatus}</div> : null}
          <div style={{ whiteSpace: 'pre-wrap', background: '#151515', color: '#f1f1f1', padding: 10, minHeight: 160, border: '1px solid #2b2b2b', borderRadius: 6 }}>
            {followUpEmail || '(empty)'}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
