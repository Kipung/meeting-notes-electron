import * as electron from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import {
  createSessionMetadataStore,
  readSessionMetadata,
  getSummaryContextMetadata,
  type SessionMetadataInput,
  type SummarizerContextMetadata,
} from './sessionMetadata'
import {
  AUDIO_FILE_FILTER_EXTENSIONS,
  TRANSCRIPT_FILE_FILTER_EXTENSIONS,
  createSessionStore,
} from './sessionStore'
import {
  SummaryOrchestrator,
  type SummaryCommandPayload,
} from './summaryOrchestrator'
import { registerIpcHandlers } from './registerIpcHandlers'
import { createRuntimeSupport } from './runtimeSupport'
import { createSummarizerService } from './summarizerService'
import { createSetupWindow, isQwenModelPresent } from './setupWindow'
import { runSmokeHarness } from './smokeHarness'
import { createTranscriptionService } from './transcriptionService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

const PREFERRED_SUMMARY_MODEL_NAMES = [
  'qwen2.5-3b-instruct-q4_k_m.gguf',
  'Llama-3.2-1B-Instruct-Q6_K.gguf',
]
const DEFAULT_SUMMARY_MODEL_NAME = PREFERRED_SUMMARY_MODEL_NAMES[0]
const DEFAULT_SILERO_VAD_URL = 'https://github.com/snakers4/silero-vad/raw/master/files/silero_vad.onnx'



let win: electron.BrowserWindow | null
let currentSessionDir: string | null = null
let currentModelName: string = 'small.en'
type BackendStartOptions = {
  deviceIndex?: number
  loopbackDeviceIndex?: number
  model?: string
  metadata?: SessionMetadataInput
}
type ProcessResult = { ok: boolean; error?: string }
let smokeHarnessStarted = false
const sessionMetadataStore = createSessionMetadataStore((error) => {
  console.error('failed to write session metadata', error)
})
const summaryOrchestrator = new SummaryOrchestrator()

const { app, BrowserWindow, ipcMain, dialog } = electron
const SMOKE_MODE = process.env['MEETING_NOTES_SMOKE_MODE'] === '1'
const SMOKE_USER_DATA = process.env['MEETING_NOTES_SMOKE_USER_DATA']?.trim()

if (SMOKE_MODE && SMOKE_USER_DATA) {
  fs.mkdirSync(SMOKE_USER_DATA, { recursive: true })
  app.setPath('userData', SMOKE_USER_DATA)
}

const sessionStore = createSessionStore({
  app,
  onReadSettingsError: (error) => {
    console.error('failed to read settings', error)
  },
  onListSessionAudioError: (sessionDir, error) => {
    console.error('failed to read session dir', sessionDir, error)
  },
})

const {
  getSessionsRoot,
  setSessionsRoot,
  resolveSessionDir,
  makeSessionDir,
  listSessionAudioPaths,
  classifyInputFile,
  readTranscriptTextFromFile,
  getUserDataRoot,
} = sessionStore

function applySessionMetadata(input?: SessionMetadataInput | null, sessionDir: string | null = currentSessionDir) {
  return sessionMetadataStore.apply(input, sessionDir)
}

function buildSummaryContextForSession(sessionDir: string): SummarizerContextMetadata {
  const metadata = readSessionMetadata(sessionDir) || sessionMetadataStore.get()
  return getSummaryContextMetadata(metadata)
}

function sendSummarizerCommand(payload: SummaryCommandPayload): boolean {
  return summarizerService.sendCommand(payload)
}

function sendToRenderer(channel: string, payload: unknown, errorLabel: string): void {
  try {
    win?.webContents.send(channel, payload)
  } catch (e) {
    console.error(errorLabel, e)
  }
}

function sendBootstrapStatus(state: 'running' | 'done' | 'error', message: string, percent?: number) {
  try {
    win?.webContents.send('bootstrap-status', { state, message, percent })
  } catch (e) {
    console.error('failed to send bootstrap-status', e)
  }
}

function sendProcessCommand(proc: ReturnType<typeof spawn> | null, label: string, payload: string) {
  if (!proc?.stdin) {
    console.error(`[${label}] stdin not available`)
    return false
  }
  try {
    proc.stdin.write(payload)
    return true
  } catch (e) {
    console.error(`[${label}] failed to write`, e)
    return false
  }
}

const runtimeSupport = createRuntimeSupport({
  app,
  getUserDataRoot,
  sendBootstrapStatus,
  preferredSummaryModelNames: PREFERRED_SUMMARY_MODEL_NAMES,
  defaultSummaryModelName: DEFAULT_SUMMARY_MODEL_NAME,
  defaultSileroVadUrl: DEFAULT_SILERO_VAD_URL,
})

const {
  getBackendRoot,
  getPythonCommand,
  getPythonEnv,
  getSileroVadModelPath,
  ensureDependencies,
  ensurePythonRuntime,
  ensureSummaryModel,
  resolveSummaryModelPath,
} = runtimeSupport

const summarizerService = createSummarizerService({
  getBackendRoot,
  getPythonCommand,
  getPythonEnv,
  ensurePythonRuntime,
  ensureSummaryModel,
  resolveSummaryModelPath,
  summaryOrchestrator,
  buildSummaryContextForSession,
  getCurrentSessionDir: () => currentSessionDir,
  sendToRenderer,
  sendProcessCommand,
  log: console,
})

const transcriptionService = createTranscriptionService({
  getBackendRoot,
  getPythonCommand,
  getPythonEnv,
  getCurrentSessionDir: () => currentSessionDir,
  onTranscriptReady: (outPath, text) => {
    handleTranscriptReady(outPath, text)
  },
  onTranscriptPartial: (partialText) => {
    summaryOrchestrator.processTranscriptPartialText(partialText, {
      currentSessionDir,
      buildSummaryContext: buildSummaryContextForSession,
      sendCommand: sendSummarizerCommand,
      logError: console.error,
    })
  },
  sendToRenderer,
  log: console,
})

function handleTranscriptReady(outPath: string, text: string) {
  try {
    win?.webContents.send('transcript-ready', { sessionDir: currentSessionDir, transcriptPath: outPath, text })
  } catch (e) {
    console.error('failed to send transcript-ready', e)
  }
  try {
    win?.webContents.send('transcription-status', { state: 'done', sessionDir: currentSessionDir, message: 'transcription complete' })
  } catch (e) {
    console.error('failed to send transcription-status done', e)
  }
  try {
    summarizerService.requestTranscriptSummary(text)
  } catch (e) {
    console.error('failed to start summarizer', e)
    try {
      win?.webContents.send('summary-status', { state: 'error', sessionDir: currentSessionDir, message: 'failed to start summarizer' })
    } catch (e2) {
      console.error('failed to send summary-status error', e2)
    }
  }
}

function startImportedSession(): string {
  const sessionDir = makeSessionDir()
  currentSessionDir = sessionDir
  summaryOrchestrator.startSession(sessionDir)
  applySessionMetadata(undefined, sessionDir)
  try {
    win?.webContents.send('session-started', { sessionDir, sessionsRoot: getSessionsRoot() })
  } catch (e) {
    console.error('failed to send session-started for imported input', e)
  }
  return sessionDir
}

async function ensureSummarizerRuntime(): Promise<ProcessResult> {
  return summarizerService.ensureRuntime()
}

async function processRecordingFromPath(audioPath: string, metadata?: SessionMetadataInput): Promise<ProcessResult> {
  if (!win) {
    return { ok: false, error: 'window not ready' }
  }
  if (!fs.existsSync(audioPath)) {
    return { ok: false, error: `audio file not found: ${audioPath}` }
  }
  const ready = await ensureDependencies()
  if (!ready) {
    return { ok: false, error: 'setup not ready' }
  }
  const summaryModelPath = resolveSummaryModelPath()
  if (!summaryModelPath) {
    return { ok: false, error: 'summary model not found' }
  }

  if (metadata) applySessionMetadata(metadata, null)
  const sessionDir = startImportedSession()
  summarizerService.startIfNeeded(summaryModelPath)
  return transcriptionService.startFileTranscription({
    audioPath,
    sessionDir,
    modelName: currentModelName,
  })
}

async function processTranscriptText(text: string, metadata?: SessionMetadataInput): Promise<ProcessResult> {
  if (!win) {
    return { ok: false, error: 'window not ready' }
  }
  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, error: 'transcript text is empty' }
  }
  const ready = await ensureSummarizerRuntime()
  if (!ready.ok) return ready

  if (metadata) applySessionMetadata(metadata, null)
  const sessionDir = startImportedSession()
  const transcriptPath = path.join(sessionDir, 'transcript.txt')
  try {
    fs.writeFileSync(transcriptPath, trimmed, 'utf-8')
  } catch (e) {
    return { ok: false, error: `failed to write transcript: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    win?.webContents.send('transcription-status', { state: 'running', sessionDir, message: 'processing transcript text' })
  } catch (e) {
    console.error('failed to send transcription-status running for transcript text', e)
  }
  handleTranscriptReady(transcriptPath, trimmed)
  return { ok: true }
}

async function processTranscriptFromPath(transcriptPath: string, metadata?: SessionMetadataInput): Promise<ProcessResult> {
  if (!fs.existsSync(transcriptPath)) {
    return { ok: false, error: `transcript file not found: ${transcriptPath}` }
  }
  let text = ''
  try {
    text = readTranscriptTextFromFile(transcriptPath)
  } catch (e) {
    return { ok: false, error: `failed to read transcript: ${e instanceof Error ? e.message : String(e)}` }
  }
  return processTranscriptText(text, metadata)
}

async function processInputPath(inputPath: string, metadata?: SessionMetadataInput): Promise<ProcessResult> {
  if (!inputPath || typeof inputPath !== 'string') {
    return { ok: false, error: 'file path is required' }
  }
  const resolvedPath = path.resolve(inputPath)
  if (!fs.existsSync(resolvedPath)) {
    return { ok: false, error: `file not found: ${resolvedPath}` }
  }
  const kind = classifyInputFile(resolvedPath)
  if (kind === 'audio') return processRecordingFromPath(resolvedPath, metadata)
  if (kind === 'transcript') return processTranscriptFromPath(resolvedPath, metadata)
  return { ok: false, error: 'unsupported file type; use audio or text transcript files' }
}



async function startBackend(): Promise<ProcessResult> {
  const ready = await ensureDependencies()
  if (!ready) return { ok: false, error: 'setup not ready' }

  summarizerService.startIfNeeded(resolveSummaryModelPath())
  return transcriptionService.startRecorder({
    modelName: currentModelName,
    vadModelPath: runtimeSupport.getResolvedVadModelPath() || getSileroVadModelPath(),
  })
}

async function processUploadedRecording(metadata?: SessionMetadataInput): Promise<ProcessResult> {
  if (!win) return { ok: false, error: 'window not ready' }
  const dialogResult = await dialog.showOpenDialog(win!, {
    title: 'Select a recording',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: AUDIO_FILE_FILTER_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { ok: false, error: 'no file selected' }
  }
  return processRecordingFromPath(dialogResult.filePaths[0], metadata)
}

async function processUploadedTranscript(metadata?: SessionMetadataInput): Promise<ProcessResult> {
  if (!win) return { ok: false, error: 'window not ready' }
  const dialogResult = await dialog.showOpenDialog(win!, {
    title: 'Select a transcript',
    properties: ['openFile'],
    filters: [
      { name: 'Transcript', extensions: TRANSCRIPT_FILE_FILTER_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { ok: false, error: 'no file selected' }
  }
  return processTranscriptFromPath(dialogResult.filePaths[0], metadata)
}

async function handleBackendStart(opts: BackendStartOptions = {}): Promise<void> {
  summaryOrchestrator.reset()
  if (opts.model) currentModelName = opts.model
  if (opts.metadata) applySessionMetadata(opts.metadata, null)
  const started = await startBackend()
  if (!started.ok) return

  const sessionDir = makeSessionDir()
  currentSessionDir = sessionDir
  summaryOrchestrator.startSession(sessionDir)
  applySessionMetadata(undefined, sessionDir)
  try {
    win?.webContents.send('session-started', { sessionDir, sessionsRoot: getSessionsRoot() })
  } catch (e) {
    console.error('failed to send session-started', e)
  }
  const result = transcriptionService.startRecordingSession({
    sessionDir,
    deviceIndex: opts.deviceIndex,
    loopbackDeviceIndex: opts.loopbackDeviceIndex,
  })
  if (!result.ok) {
    console.error('[backend] failed to send start command', result.error)
  }
}

async function handleSetSessionMetadata(payload: SessionMetadataInput = {}): Promise<ProcessResult> {
  try {
    applySessionMetadata(payload)
    return { ok: true }
  } catch (e) {
    console.error('failed to set session metadata', e)
    return { ok: false, error: e instanceof Error ? e.message : 'failed to set session metadata' }
  }
}

async function handleChooseSessionsRoot(): Promise<string | null> {
  try {
    const options = {
      title: 'Choose session save location',
      defaultPath: getSessionsRoot(),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    fs.mkdirSync(root, { recursive: true })
    return setSessionsRoot(root)
  } catch (e) {
    console.error('failed to choose sessions root', e)
    return null
  }
}

async function handleGenerateFollowUpEmail(
  payload: { summary?: string; studentName?: string; instructions?: string; temperature?: number; maxTokens?: number } = {},
): Promise<{ ok: boolean; text?: string; error?: string }> {
  return summarizerService.generateFollowUpEmail(payload)
}

async function handleDeleteSessionAudio(sessionDir: string): Promise<{ ok: boolean; deleted?: string[]; error?: string }> {
  const resolved = resolveSessionDir(sessionDir)
  if (!resolved) return { ok: false, error: 'invalid session directory' }
  if (transcriptionService.isRecordingSession(resolved)) {
    return { ok: false, error: 'cannot delete audio while recording' }
  }

  const audioPaths = listSessionAudioPaths(resolved)
  if (audioPaths.length === 0) return { ok: true, deleted: [] }

  const deleted: string[] = []
  for (const filePath of audioPaths) {
    try {
      fs.unlinkSync(filePath)
      deleted.push(filePath)
    } catch (e) {
      console.error('failed to delete audio file', filePath, e)
    }
  }

  const ok = deleted.length === audioPaths.length
  return { ok, deleted, error: ok ? undefined : 'failed to delete some audio files' }
}

registerIpcHandlers({
  ipcMain,
  handleBackendStart,
  stopBackend: () => transcriptionService.stopRecorder(),
  pauseBackend: () => transcriptionService.pauseRecorder(),
  resumeBackend: () => transcriptionService.resumeRecorder(),
  listDevices: () => transcriptionService.listDevices(),
  getSessionsRoot,
  setSessionMetadata: handleSetSessionMetadata,
  chooseSessionsRoot: handleChooseSessionsRoot,
  processUploadedRecording,
  processUploadedTranscript,
  processTranscriptText,
  processInputPath,
  generateFollowUpEmail: handleGenerateFollowUpEmail,
  deleteSessionAudio: handleDeleteSessionAudio,
})


function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: !SMOKE_MODE,
    icon: path.join(process.env.VITE_PUBLIC!, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = win?.webContents.getURL()
    if (!currentUrl) return
    if (targetUrl !== currentUrl) {
      event.preventDefault()
    }
  })

  win.webContents.on('did-finish-load', () => {
    void startBackend()
    if (SMOKE_MODE && win && !smokeHarnessStarted) {
      smokeHarnessStarted = true
      void runSmokeHarness({
        app,
        win,
        getSessionsRoot,
        makeSessionDir,
        getCurrentSessionDir: () => currentSessionDir,
        setCurrentSessionDir: (sessionDir) => {
          currentSessionDir = sessionDir
        },
        applySessionMetadata,
        ensureSummarizerRuntime,
        summaryOrchestrator,
        buildSummaryContextForSession,
        sendSummarizerCommand,
      })
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.whenReady().then(() => {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
  })

  if (!isQwenModelPresent()) {
    createSetupWindow({
      mainDist: MAIN_DIST,
      rendererDist: RENDERER_DIST,
      viteDevServerUrl: VITE_DEV_SERVER_URL,
      onComplete: () => {
        createWindow()
      },
    })
  } else {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (isQwenModelPresent()) {
      createWindow()
      void startBackend()
    }
  }
})


app.on('before-quit', () => {
  transcriptionService.shutdown()
  summarizerService.shutdown()
})
