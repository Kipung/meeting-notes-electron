import type { IpcMain } from 'electron'

import type { SessionMetadataInput } from './sessionMetadata'

type ProcessResult = { ok: boolean; error?: string }
type FollowUpResult = { ok: boolean; text?: string; error?: string }
type DeleteSessionAudioResult = { ok: boolean; deleted?: string[]; error?: string }
type BackendStartOptions = {
  deviceIndex?: number
  loopbackDeviceIndex?: number
  model?: string
  metadata?: SessionMetadataInput
}

type RegisterIpcHandlersOptions = {
  ipcMain: IpcMain
  handleBackendStart: (opts?: BackendStartOptions) => Promise<void>
  stopBackend: () => void
  pauseBackend: () => void
  resumeBackend: () => void
  listDevices: () => Promise<unknown>
  getSessionsRoot: () => string
  setSessionMetadata: (payload?: SessionMetadataInput) => Promise<ProcessResult>
  chooseSessionsRoot: () => Promise<string | null>
  processUploadedRecording: (metadata?: SessionMetadataInput) => Promise<ProcessResult>
  processUploadedTranscript: (metadata?: SessionMetadataInput) => Promise<ProcessResult>
  processTranscriptText: (text: string, metadata?: SessionMetadataInput) => Promise<ProcessResult>
  processInputPath: (inputPath: string, metadata?: SessionMetadataInput) => Promise<ProcessResult>
  generateFollowUpEmail: (payload?: {
    summary?: string
    studentName?: string
    instructions?: string
    temperature?: number
    maxTokens?: number
  }) => Promise<FollowUpResult>
  deleteSessionAudio: (sessionDir: string) => Promise<DeleteSessionAudioResult>
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
  const {
    ipcMain,
    handleBackendStart,
    stopBackend,
    pauseBackend,
    resumeBackend,
    listDevices,
    getSessionsRoot,
    setSessionMetadata,
    chooseSessionsRoot,
    processUploadedRecording,
    processUploadedTranscript,
    processTranscriptText,
    processInputPath,
    generateFollowUpEmail,
    deleteSessionAudio,
  } = options

  ipcMain.on('backend-start', (_evt, opts: BackendStartOptions = {}) => {
    void handleBackendStart(opts)
  })

  ipcMain.on('backend-stop', () => {
    stopBackend()
  })

  ipcMain.on('backend-pause', () => {
    pauseBackend()
  })

  ipcMain.on('backend-resume', () => {
    resumeBackend()
  })

  ipcMain.handle('list-devices', async () => listDevices())

  ipcMain.handle('get-sessions-root', () => getSessionsRoot())

  ipcMain.handle('set-session-metadata', async (_evt, payload: SessionMetadataInput = {}) => {
    return setSessionMetadata(payload)
  })

  ipcMain.handle('choose-sessions-root', async () => chooseSessionsRoot())

  ipcMain.handle('process-recording', async (_evt, payload: { metadata?: SessionMetadataInput } = {}) => {
    try {
      return await processUploadedRecording(payload.metadata)
    } catch (error) {
      console.error('[process-recording] failed', error)
      return { ok: false, error: error instanceof Error ? error.message : 'failed to process recording' }
    }
  })

  ipcMain.handle('process-transcript-file', async (_evt, payload: { metadata?: SessionMetadataInput } = {}) => {
    try {
      return await processUploadedTranscript(payload.metadata)
    } catch (error) {
      console.error('[process-transcript-file] failed', error)
      return { ok: false, error: error instanceof Error ? error.message : 'failed to process transcript file' }
    }
  })

  ipcMain.handle('summarize-transcript-text', async (_evt, payload: { text?: string; metadata?: SessionMetadataInput } = {}) => {
    try {
      return await processTranscriptText(typeof payload.text === 'string' ? payload.text : '', payload.metadata)
    } catch (error) {
      console.error('[summarize-transcript-text] failed', error)
      return { ok: false, error: error instanceof Error ? error.message : 'failed to summarize transcript text' }
    }
  })

  ipcMain.handle('process-input-path', async (_evt, payload: { inputPath?: string; metadata?: SessionMetadataInput } = {}) => {
    try {
      return await processInputPath(typeof payload.inputPath === 'string' ? payload.inputPath : '', payload.metadata)
    } catch (error) {
      console.error('[process-input-path] failed', error)
      return { ok: false, error: error instanceof Error ? error.message : 'failed to process input file' }
    }
  })

  ipcMain.handle(
    'generate-followup-email',
    async (
      _evt,
      payload: {
        summary?: string
        studentName?: string
        instructions?: string
        temperature?: number
        maxTokens?: number
      } = {},
    ) => generateFollowUpEmail(payload),
  )

  ipcMain.handle('delete-session-audio', async (_evt, sessionDir: string) => deleteSessionAudio(sessionDir))
}
