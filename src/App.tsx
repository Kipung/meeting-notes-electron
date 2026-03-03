import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import './App.css'

const DEFAULT_WHISPER_MODEL = 'medium.en'
const SUMMARY_META_PLACEHOLDER = '(not provided)'
type StepState = 'idle' | 'running' | 'paused' | 'done' | 'error'
type DroppedFile = File & { path?: string }
const backend = window.backend
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
const HEADING_PREFIX_RE = /^[-*#>\s]+/
const SUMMARY_HEADING_LINE_RE = /^summary(?:\s*[:\-]|$)/i
const ACTION_HEADING_LINE_RE = /^action items?(?:\s*[:\-]|$)/i
const HIGH_IMPORTANCE_HEADING_LINE_RE = /^high importance(?:\s*[:\-]|$)/i
const LEADING_BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s*/
const ACTION_NONE_RE = /^(?:none|none\.|no action items?\.?|no actionable follow-?up(?: tasks?)?\.?)$/i
const ACTION_PLACEHOLDER_RE = /\b(?:owner|topic|due date|tbd)\b/i
const ACTION_INSTRUCTION_RE = /\b(?:return only|in summary|in action items?|summary must|stay focused|do not add|do not invent|include up to|if no actionable|if no explicit|each bullet)\b/i
const ACTION_INCOMPLETE_END_RE =
  /\b(?:to|for|with|and|or|the|a|an|of|in|on|by|from|about|around|into|through|that|this|these|those)\s*$/i
const SUMMARY_META_LINE_RE = /^(?:modality|subject|student id|student name|coach)\s*:/i
const MAX_ACTION_ITEMS = 5

type ParsedSummaryView = {
  summaryText: string
  actionItems: string[]
  actionItemsNone: boolean
  hasActionSection: boolean
}

const cleanLine = (value: string) => value.trim().replace(/\s+/g, ' ')

const normalizeBulletText = (value: string) => cleanLine(value.replace(LEADING_BULLET_RE, '')).replace(/[;]+$/, '')

const normalizeSummaryText = (value: string) => {
  let cleaned = cleanLine(value)
  if (!cleaned) return ''
  cleaned = cleaned
    .replace(/^example\s+\d+\s*/i, '')
    .replace(/\bspeaker\s*([0-9]+)\b/gi, (_match, speakerId: string) => `Speaker ${speakerId}`)
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
}

const splitInlineActionMarker = (line: string) => {
  const marker = /\baction items?\s*:\s*/i
  const match = marker.exec(line)
  if (!match || typeof match.index !== 'number') return null
  const before = cleanLine(line.slice(0, match.index))
  const after = cleanLine(line.slice(match.index + match[0].length))
  return { before, after }
}

const canonicalActionItemKey = (value: string) =>
  normalizeBulletText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const splitActionCandidates = (line: string) =>
  cleanLine(line)
    .split(/\s*;\s+/)
    .map((segment) => normalizeBulletText(segment))
    .filter(Boolean)

const parseActionItems = (lines: string[]) => {
  const items: string[] = []
  let sawNone = false
  for (const line of lines) {
    const cleaned = cleanLine(line)
    if (!cleaned) continue
    const segments = splitActionCandidates(cleaned)
    for (const item of segments) {
      if (!item) continue
      if (ACTION_NONE_RE.test(item)) {
        sawNone = true
        continue
      }
      if (ACTION_PLACEHOLDER_RE.test(item)) continue
      if (ACTION_INSTRUCTION_RE.test(item)) continue
      const words = item.split(/\s+/)
      if (words.length < 2 || words.length > 28) continue
      if (ACTION_INCOMPLETE_END_RE.test(item)) continue
      items.push(item[0].toUpperCase() + item.slice(1))
      if (items.length >= MAX_ACTION_ITEMS) break
    }
    if (items.length >= MAX_ACTION_ITEMS) break
  }
  const seen = new Set<string>()
  const unique = items.filter((item) => {
    const key = canonicalActionItemKey(item)
    if (!key) return false
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { items: unique.slice(0, MAX_ACTION_ITEMS), sawNone }
}

const stripHeadingPrefix = (line: string) => line.trim().replace(HEADING_PREFIX_RE, '')

const getSectionHeading = (line: string): 'summary' | 'action' | 'high' | null => {
  const normalized = stripHeadingPrefix(line)
  if (SUMMARY_HEADING_LINE_RE.test(normalized)) return 'summary'
  if (ACTION_HEADING_LINE_RE.test(normalized)) return 'action'
  if (HIGH_IMPORTANCE_HEADING_LINE_RE.test(normalized)) return 'high'
  return null
}

const getHeadingRemainder = (line: string) =>
  stripHeadingPrefix(line).replace(/^(?:summary|action items?|high importance)\s*(?::|-)?\s*/i, '').trim()

const extractSummaryFallbackText = (rawSummary: string) => {
  const normalized = rawSummary.replace(/\r\n/g, '\n').trim()
  if (!normalized) return ''
  const lines = normalized.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const cleaned = cleanLine(line)
    if (!cleaned) continue
    const heading = getSectionHeading(cleaned)
    if (heading === 'action') break
    if (heading === 'summary' || heading === 'high') {
      const remainder = cleanLine(getHeadingRemainder(cleaned))
      if (remainder) kept.push(remainder)
      continue
    }
    const inlineSplit = splitInlineActionMarker(cleaned)
    if (inlineSplit) {
      if (inlineSplit.before) kept.push(inlineSplit.before)
      break
    }
    if (!SUMMARY_META_LINE_RE.test(cleaned)) kept.push(cleaned)
  }
  return normalizeSummaryText(kept.join(' '))
}

const parseSummaryForView = (rawSummary: string): ParsedSummaryView => {
  const normalized = rawSummary.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return {
      summaryText: '',
      actionItems: [],
      actionItemsNone: false,
      hasActionSection: false,
    }
  }
  const lines = normalized.split('\n')
  const summaryLines: string[] = []
  const actionLines: string[] = []
  let currentSection: 'summary' | 'action' = 'summary'
  let sawActionHeading = false

  for (const line of lines) {
    const heading = getSectionHeading(line)
    if (heading) {
      const remainder = cleanLine(getHeadingRemainder(line))
      if (heading === 'summary') {
        currentSection = 'summary'
        if (remainder) summaryLines.push(remainder)
        continue
      }
      if (heading === 'action') {
        currentSection = 'action'
        sawActionHeading = true
        if (remainder) actionLines.push(remainder)
        continue
      }
      if (heading === 'high') {
        currentSection = 'summary'
        if (remainder) summaryLines.push(remainder)
        continue
      }
    }

    const cleaned = line.trim()
    if (!cleaned) continue
    if (currentSection === 'summary') {
      const inlineSplit = splitInlineActionMarker(cleaned)
      if (inlineSplit) {
        if (inlineSplit.before) summaryLines.push(inlineSplit.before)
        currentSection = 'action'
        sawActionHeading = true
        if (inlineSplit.after) actionLines.push(inlineSplit.after)
        continue
      }
      summaryLines.push(cleaned)
      continue
    }
    if (currentSection === 'action') {
      actionLines.push(cleaned)
    }
  }

  const parsedSummaryText = normalizeSummaryText(summaryLines.map(normalizeBulletText).filter(Boolean).join(' '))
  const summaryText = parsedSummaryText || extractSummaryFallbackText(rawSummary)

  const { items: actionItems, sawNone: actionItemsNone } = parseActionItems(actionLines)
  return {
    summaryText,
    actionItems,
    actionItemsNone,
    hasActionSection: sawActionHeading || actionLines.length > 0,
  }
}

function App() {
  const [devices, setDevices] = useState<BackendDevice[]>([])
  const [loopbackDevices, setLoopbackDevices] = useState<BackendDevice[]>([])
  const [selectedDevice, setSelectedDevice] = useState<number | null>(null)
  const [selectedLoopback, setSelectedLoopback] = useState<number | null>(null)
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
  const [processingTranscriptFile, setProcessingTranscriptFile] = useState(false)
  const [summarizingTranscriptText, setSummarizingTranscriptText] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const isWindows = /Windows/.test(navigator.userAgent)

  const getElapsedSeconds = () => {
    if (!recordingStartRef.current) return 0
    const now = Date.now()
    const pausedMs = pausedMsRef.current + (pauseStartRef.current ? now - pauseStartRef.current : 0)
    return Math.max(0, Math.floor((now - recordingStartRef.current - pausedMs) / 1000))
  }

  useEffect(() => {
    void (async () => {
      try {
        const res = await backend.listDevices()
        const allDevices = Array.isArray(res?.devices) ? res.devices : []
        const loopbacks = allDevices.filter((d) => d.isLoopback)
        setDevices(allDevices.filter((d) => !d.isLoopback))
        setLoopbackDevices(loopbacks)
      } catch (e) {
        console.error('listDevices failed', e)
      }
    })()

    void (async () => {
      try {
        const root = await backend.getSessionsRoot()
        if (root) setSessionsRoot(root)
      } catch (e) {
        console.error('getSessionsRoot failed', e)
      }
    })()

    const offSession = backend.onSession((_ev, data) => {
      setSessionDir(data.sessionDir || null)
      if (data.sessionsRoot) setSessionsRoot(data.sessionsRoot)
      setAudioDeleteMessage('')
    })

    const offTranscript = backend.onTranscript((_ev, data) => {
      setTranscript(data.text || '')
      setSessionDir(data.sessionDir || null)
      setStatus('transcript-ready')
      setStatusDetail('transcription complete')
      setTranscriptionState('done')
      setRunning(false)
    })

    const offTranscriptPartial = backend.onTranscriptPartial((_ev, data) => {
      const next = data.fullText || data.text || ''
      if (next) setTranscript(next)
      if (data.sessionDir) setSessionDir(data.sessionDir)
    })

    const offTranscriptionStatus = backend.onTranscriptionStatus((_ev, data) => {
      const state = data.state === 'starting' || data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setTranscriptionState(state)
      if (state === 'running') setStatus('transcribing')
      if (state === 'done') setStatus('transcript-ready')
      if (state === 'error') setStatus('transcription-error')
      if (state === 'done' || state === 'error') setRunning(false)
      setStatusDetail(data.message || '')
    })

    const offRecordingReady = backend.onRecordingReady((_ev, data) => {
      setRecorderReady(Boolean(data?.ready))
    })

    const offRecordingStarted = backend.onRecordingStarted((_ev, data) => {
      const startedAtMs = typeof data?.startedAtMs === 'number' ? data.startedAtMs : Date.now()
      recordingStartRef.current = startedAtMs
      pauseStartRef.current = null
      pausedMsRef.current = 0
      setElapsedSeconds(0)
    })

    const offSummary = backend.onSummary((_ev, data) => {
      setStatus('summary-ready')
      setStatusDetail('summary ready')
      setSummarizationState('done')
      const text = data.text || ''
      setSummary(text)
      setFollowUpEmail('')
      setFollowUpStatus('')
      setFollowUpGenerating(false)
    })

    const offSummaryStream = backend.onSummaryStream((_ev, data) => {
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

    const offSummaryStatus = backend.onSummaryStatus((_ev, data) => {
      const state = data.state === 'starting' || data.state === 'running' ? 'running' : data.state === 'done' ? 'done' : data.state === 'error' ? 'error' : 'idle'
      setSummarizationState(state)
      if (state === 'running') setStatus('summarizing')
      if (state === 'done') setStatus('summary-ready')
      if (state === 'error') setStatus('summary-error')
      setStatusDetail(data.message || '')
    })

    const offBootstrapStatus = backend.onBootstrapStatus((_ev, data) => {
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
    backend.start({
      deviceIndex: selectedDevice ?? undefined,
      loopbackDeviceIndex: selectedLoopback ?? undefined,
      model: DEFAULT_WHISPER_MODEL,
    })
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
    backend.stop()
  }

  const onPauseToggle = () => {
    if (!running) return
    if (recordingState === 'running') {
      pauseStartRef.current = Date.now()
      setElapsedSeconds(getElapsedSeconds())
      setStatus('paused')
      setStatusDetail('recording paused')
      setRecordingState('paused')
      backend.pause()
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
      backend.resume()
    }
  }

  const copyToClipboard = (text: string) => {
    if (!text) return
    navigator.clipboard.writeText(text).catch((err) => {
      console.error('copy to clipboard failed', err)
    })
  }

  const onProcessRecordingFile = async () => {
    if (processingRecordingFile || processingTranscriptFile || summarizingTranscriptText) return
    setProcessingRecordingFile(true)
    setStatus('transcribing')
    setStatusDetail('processing uploaded audio...')
    try {
      const res = await backend.processRecording()
      if (!res?.ok) {
        if (res?.error === 'no file selected') {
          setStatus('idle')
          setStatusDetail('')
          return
        }
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

  const onProcessTranscriptFile = async () => {
    if (processingRecordingFile || processingTranscriptFile || summarizingTranscriptText) return
    setProcessingTranscriptFile(true)
    setStatus('transcribing')
    setStatusDetail('processing uploaded transcript...')
    try {
      const res = await backend.processTranscriptFile()
      if (!res?.ok) {
        if (res?.error === 'no file selected') {
          setStatus('idle')
          setStatusDetail('')
          return
        }
        setStatus('transcription-error')
        setStatusDetail(res?.error || 'failed to process transcript')
      }
    } catch (e) {
      console.error('processTranscriptFile failed', e)
      setStatus('transcription-error')
      setStatusDetail('Failed to process transcript file')
    } finally {
      setProcessingTranscriptFile(false)
    }
  }

  const onSummarizeTranscriptText = async () => {
    const text = transcript.trim()
    if (!text) {
      setStatus('transcription-error')
      setStatusDetail('Transcript text is empty')
      return
    }
    if (processingRecordingFile || processingTranscriptFile || summarizingTranscriptText) return
    setSummarizingTranscriptText(true)
    setStatus('summarizing')
    setStatusDetail('summarizing current transcript text...')
    setSummarizationState('running')
    try {
      const res = await backend.summarizeTranscriptText(text)
      if (!res?.ok) {
        setStatus('summary-error')
        setStatusDetail(res?.error || 'failed to summarize transcript text')
        setSummarizationState('error')
      }
    } catch (e) {
      console.error('summarizeTranscriptText failed', e)
      setStatus('summary-error')
      setStatusDetail('Failed to summarize transcript text')
      setSummarizationState('error')
    } finally {
      setSummarizingTranscriptText(false)
    }
  }

  const onDragOverApp = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropActive) setDropActive(true)
  }

  const onDragLeaveApp = (e: DragEvent<HTMLDivElement>) => {
    const relatedTarget = e.relatedTarget as Node | null
    if (relatedTarget && e.currentTarget.contains(relatedTarget)) return
    setDropActive(false)
  }

  const onDropApp = async (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return
    e.preventDefault()
    setDropActive(false)
    if (running || processingRecordingFile || processingTranscriptFile || summarizingTranscriptText) return
    const file = e.dataTransfer.files?.[0] as DroppedFile | undefined
    const droppedPath = file?.path ?? null
    if (!droppedPath) {
      setStatus('transcription-error')
      setStatusDetail('Dropped file path is unavailable')
      return
    }
    setStatus('transcribing')
    setStatusDetail('processing dropped file...')
    setProcessingTranscriptFile(true)
    try {
      const res = await backend.processInputPath(droppedPath)
      if (!res?.ok) {
        setStatus('transcription-error')
        setStatusDetail(res?.error || 'failed to process dropped file')
      }
    } catch (e2) {
      console.error('processInputPath failed', e2)
      setStatus('transcription-error')
      setStatusDetail('Failed to process dropped file')
    } finally {
      setProcessingTranscriptFile(false)
    }
  }

  const canPause = running && (recordingState === 'running' || recordingState === 'paused')
  const importBusy = processingRecordingFile || processingTranscriptFile || summarizingTranscriptText
  const canImportFiles = !running && !importBusy
  const canDeleteAudio = Boolean(sessionDir) && transcriptionState === 'done' && recordingState !== 'running' && recordingState !== 'paused'
  const followUpActionLabel = followUpGenerating ? 'Generating...' : followUpEmail ? 'Regenerate from summary' : 'Generate from summary'
  const parsedSummary = useMemo(() => parseSummaryForView(summary), [summary])
  const effectiveSummaryText = parsedSummary.summaryText || extractSummaryFallbackText(summary)
  const summaryDateText = useMemo(
    () =>
      new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
    []
  )
  const summaryModalityText = cleanLine(sessionModality) || SUMMARY_META_PLACEHOLDER
  const summarySubjectText = cleanLine(sessionSubject) || SUMMARY_META_PLACEHOLDER
  const summaryCoachText = cleanLine(coachInitials) || SUMMARY_META_PLACEHOLDER
  const summaryStudentNameText = cleanLine(studentName) || SUMMARY_META_PLACEHOLDER
  const summaryStudentIdText = cleanLine(studentId) || SUMMARY_META_PLACEHOLDER
  const summaryHeaderLine = `${summaryDateText} ${summaryModalityText} re: ${summarySubjectText} - ${summaryCoachText}`
  const summaryHeaderSubline = `Student: ${summaryStudentNameText} | Student ID: ${summaryStudentIdText}`
  const normalizedSummaryBody = summary
    ? [
        'Summary:',
        effectiveSummaryText || 'No summary content found.',
        '',
        'Action Items:',
        parsedSummary.actionItems.length > 0 ? parsedSummary.actionItems.map((item) => `- ${item}`).join('\n') : 'none.',
      ].join('\n')
    : ''
  const summaryWithMeta = summary
    ? [
        summaryHeaderLine,
        summaryHeaderSubline,
        '',
        normalizedSummaryBody,
      ].join('\n')
    : summary
  const sessionDirLabel = sessionDir ? compactPath(sessionDir, sessionsRoot) : null
  const sessionsRootLabel = sessionsRoot ? compactPath(sessionsRoot) : '(loading...)'
  const recorderLoading = !running && (setupState !== 'done' || !recorderReady)
  const primaryActionLabel = !running ? 'Start' : recordingState === 'paused' ? 'Resume' : 'Pause'
  const primaryActionColor = !running ? '#ff3b30' : '#f1f1f1'
  const primaryActionIcon = recorderLoading ? (
    <span className="primary-action-spinner" aria-hidden="true" />
  ) : !running ? (
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
      const nextRoot = await backend.chooseSessionsRoot()
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
      const res = await backend.generateFollowUpEmail({
        summary: normalizedSummaryBody,
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
      const res = await backend.deleteSessionAudio(sessionDir)
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
    <div className="app-shell" onDragOver={onDragOverApp} onDragLeave={onDragLeaveApp} onDrop={onDropApp}>
      <h1 style={{ fontSize: 24, margin: '0 0 10px' }}>SSC Meeting Helper</h1>
      {dropActive ? (
        <div style={{ marginBottom: 10, padding: 8, border: '1px dashed #6c6c6c', borderRadius: 6, color: '#d8d8d8' }}>
          Drop an audio file or transcript file to process.
        </div>
      ) : null}

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

          {isWindows ? (
            loopbackDevices.length > 0 ? (
              <div className="form-inline" style={{ marginBottom: 6 }}>
                <label>System audio (WASAPI loopback): </label>
                <select className="form-inline__control" value={selectedLoopback ?? ''} onChange={(e) => setSelectedLoopback(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">None</option>
                  {loopbackDevices.map((d) => (
                    <option key={d.index} value={d.index}>
                      {d.index}: {d.name} (in:{d.maxInputChannels})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div style={{ marginBottom: 6, color: '#c7c7c7' }}>
                System audio (WASAPI loopback): no loopback devices found.
              </div>
            )
          ) : null}

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
            <button onClick={onProcessRecordingFile} disabled={!canImportFiles}>
              {processingRecordingFile ? 'Processing audio...' : 'Process audio file'}
            </button>
            <button onClick={onProcessTranscriptFile} disabled={!canImportFiles}>
              {processingTranscriptFile ? 'Processing transcript...' : 'Process transcript file'}
            </button>
            <button onClick={onSummarizeTranscriptText} disabled={running || importBusy || !transcript.trim()}>
              {summarizingTranscriptText ? 'Summarizing...' : 'Summarize transcript text'}
            </button>
          </div>
          <textarea
            className="output-panel__textarea output-panel__textarea--scrollable"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Transcript will appear here..."
          />
        </div>

        <div className="output-panel">
          <h3>Summary</h3>
          <button onClick={() => copyToClipboard(summaryWithMeta)} disabled={!summary} style={{ marginBottom: 8 }}>
            Copy summary
          </button>
          <div className="summary-display">
            <div className="summary-display__meta-inline">
              <div className="summary-display__meta-line">{summaryHeaderLine}</div>
              <div className="summary-display__meta-subline">{summaryHeaderSubline}</div>
            </div>
            <>
              <div className="summary-display__section-title">Summary</div>
              <div className="summary-display__text-block">
                {summary ? effectiveSummaryText || 'No summary content found.' : 'Summary will appear here...'}
              </div>
              <div className="summary-display__section-title">Action Items</div>
              {parsedSummary.actionItems.length > 0 ? (
                <ul className="summary-display__list summary-display__list--actions">
                  {parsedSummary.actionItems.map((item, idx) => (
                    <li key={`action-${idx}`}>{item}</li>
                  ))}
                </ul>
              ) : (
                <div className="summary-display__empty">
                  {summary && (parsedSummary.actionItemsNone || parsedSummary.hasActionSection) ? 'No action items.' : 'No action items yet.'}
                </div>
              )}
            </>
          </div>
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
