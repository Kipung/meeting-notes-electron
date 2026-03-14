/// <reference types="vite/client" />

export {}

declare global {
  interface BackendDevice {
    index: number
    name?: string
    maxInputChannels?: number
    maxOutputChannels?: number
    isLoopback?: boolean
  }

  type BackendStatusState = 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error'

  interface BackendSessionMetadataPayload {
    modality?: string
    subject?: string
    studentId?: string
    studentName?: string
    coachInitials?: string
  }

  interface BackendStartOptions {
    deviceIndex?: number
    loopbackDeviceIndex?: number
    model?: string
    metadata?: BackendSessionMetadataPayload
  }

  interface BackendSimpleResult {
    ok: boolean
    error?: string
  }

  interface BackendDeleteSessionAudioResult extends BackendSimpleResult {
    deleted?: string[]
  }

  interface BackendGenerateFollowUpPayload {
    summary: string
    studentName?: string
    instructions?: string
    temperature?: number
    maxTokens?: number
  }

  interface BackendProcessWithMetadataPayload {
    metadata?: BackendSessionMetadataPayload
  }

  interface BackendSummarizeTranscriptPayload extends BackendProcessWithMetadataPayload {
    text: string
  }

  interface BackendProcessInputPathPayload extends BackendProcessWithMetadataPayload {
    inputPath: string
  }

  interface BackendGenerateFollowUpResult extends BackendSimpleResult {
    text?: string
  }

  interface BackendListDevicesResult {
    devices?: BackendDevice[]
    error?: string
    raw?: string
  }

  interface SessionStartedEvent {
    sessionDir?: string | null
    sessionsRoot?: string
  }

  interface TranscriptReadyEvent {
    sessionDir?: string | null
    transcriptPath?: string
    text?: string
  }

  interface TranscriptPartialEvent {
    sessionDir?: string | null
    text?: string
    fullText?: string
  }

  interface TranscriptionStatusEvent {
    state?: BackendStatusState
    sessionDir?: string | null
    message?: string
  }

  interface RecordingReadyEvent {
    ready?: boolean
  }

  interface RecordingStartedEvent {
    sessionDir?: string | null
    startedAtMs?: number
  }

  interface SummaryReadyEvent {
    sessionDir?: string | null
    summaryPath?: string
    text?: string
  }

  interface SummaryStatusEvent {
    state?: BackendStatusState
    sessionDir?: string | null
    message?: string
  }

  interface SummaryStreamEvent {
    sessionDir?: string | null
    reset?: boolean
    delta?: string
  }

  interface BootstrapStatusEvent {
    state?: BackendStatusState
    message?: string
    percent?: number
  }

  type BackendEventHandler<T> = (event: unknown, data: T) => void

  interface BackendApi {
    start: (opts?: BackendStartOptions) => void
    stop: () => void
    pause: () => void
    resume: () => void
    listDevices: () => Promise<BackendListDevicesResult>
    getSessionsRoot: () => Promise<string | null>
    chooseSessionsRoot: () => Promise<string | null>
    setSessionMetadata: (metadata: BackendSessionMetadataPayload) => Promise<BackendSimpleResult>
    deleteSessionAudio: (sessionDir: string) => Promise<BackendDeleteSessionAudioResult>
    generateFollowUpEmail: (payload: BackendGenerateFollowUpPayload) => Promise<BackendGenerateFollowUpResult>
    processRecording: (payload?: BackendProcessWithMetadataPayload) => Promise<BackendSimpleResult>
    processTranscriptFile: (payload?: BackendProcessWithMetadataPayload) => Promise<BackendSimpleResult>
    summarizeTranscriptText: (payload: BackendSummarizeTranscriptPayload) => Promise<BackendSimpleResult>
    processInputPath: (payload: BackendProcessInputPathPayload) => Promise<BackendSimpleResult>
    onSession: (cb: BackendEventHandler<SessionStartedEvent>) => () => void
    onTranscript: (cb: BackendEventHandler<TranscriptReadyEvent>) => () => void
    onTranscriptPartial: (cb: BackendEventHandler<TranscriptPartialEvent>) => () => void
    onTranscriptionStatus: (cb: BackendEventHandler<TranscriptionStatusEvent>) => () => void
    onRecordingReady: (cb: BackendEventHandler<RecordingReadyEvent>) => () => void
    onRecordingStarted: (cb: BackendEventHandler<RecordingStartedEvent>) => () => void
    onSummary: (cb: BackendEventHandler<SummaryReadyEvent>) => () => void
    onSummaryStatus: (cb: BackendEventHandler<SummaryStatusEvent>) => () => void
    onSummaryStream: (cb: BackendEventHandler<SummaryStreamEvent>) => () => void
    onBootstrapStatus: (cb: BackendEventHandler<BootstrapStatusEvent>) => () => void
  }

  interface Window {
    backend: BackendApi
  }
}
