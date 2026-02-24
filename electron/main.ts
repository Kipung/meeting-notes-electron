import * as electron from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'

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

const DEFAULT_SUMMARY_MODEL_NAME = 'Llama-3.2-1B-Instruct-Q6_K.gguf'



let win: electron.BrowserWindow | null
let backendProcess: ReturnType<typeof spawn> | null = null
let currentSessionDir: string | null = null
let currentModelName: string = 'small.en'
let summarizerProcess: ReturnType<typeof spawn> | null = null
let summarizerStdoutBuf = ''
let currentSummaryModelPath: string | null = null
let recordStdoutBuf = ''
let setupState: 'idle' | 'running' | 'done' | 'error' = 'idle'
let setupPromise: Promise<boolean> | null = null
let downloadedSummaryModelPath: string | null = null
type FollowUpResult = { ok: boolean; text?: string; error?: string }
type SummarizerEvent = {
  event?: string
  text?: string
  msg?: string
}
const followUpRequests = new Map<string, { resolve: (value: FollowUpResult) => void; timeout: NodeJS.Timeout }>()
const CHUNK_WORD_THRESHOLD = 600
const AUDIO_FILE_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.aac', '.ogg', '.webm'])
const TRANSCRIPT_FILE_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.srt', '.vtt', '.log', '.json'])
type ChunkTask = { id: number; text: string; sessionDir: string | null }
type ProcessResult = { ok: boolean; error?: string }

let chunkQueue: ChunkTask[] = []
let chunkProcessing = false
let nextChunkId = 0
let chunkSummaries = new Map<number, string>()
let lastTranscriptOffset = 0
let transcriptBuffer = ''
let chunkSummariesEnabled = false
let finalSummaryPending: string | null = null
let finalSummaryRunning = false
let chunkSummariesSession: string | null = null
let pendingFinalSummarySession: string | null = null
let fileTranscribeProcess: ReturnType<typeof spawn> | null = null
let fileTranscribeStdoutBuf = ''

const { app, BrowserWindow, ipcMain, dialog } = electron

type AppSettings = {
  sessionsRoot?: string
}

function getUserDataRoot(): string {
  return app.getPath('userData')
}

function getSettingsPath(): string {
  return path.join(getUserDataRoot(), 'settings.json')
}

function readSettings(): AppSettings {
  const settingsPath = getSettingsPath()
  if (!fs.existsSync(settingsPath)) return {}
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as AppSettings
  } catch (e) {
    console.error('failed to read settings', e)
    return {}
  }
}

function writeSettings(next: AppSettings) {
  const settingsPath = getSettingsPath()
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2))
}

function getDefaultSessionsRoot(): string {
  return path.join(getUserDataRoot(), 'sessions')
}

function getSessionsRoot(): string {
  const settings = readSettings()
  const root = settings.sessionsRoot?.trim()
  return root && root.length > 0 ? root : getDefaultSessionsRoot()
}

function setSessionsRoot(root: string): string {
  const trimmed = root.trim()
  const settings = readSettings()
  if (trimmed) settings.sessionsRoot = trimmed
  else delete settings.sessionsRoot
  writeSettings(settings)
  return trimmed || getDefaultSessionsRoot()
}

function resolveSessionDir(sessionDir: string): string | null {
  if (!sessionDir || typeof sessionDir !== 'string') return null
  const resolved = path.resolve(sessionDir)
  const root = path.resolve(getSessionsRoot())
  if (resolved === root) return null
  if (!resolved.startsWith(root + path.sep)) return null
  return resolved
}

function listSessionAudioPaths(sessionDir: string): string[] {
  const paths: string[] = []
  try {
    const entries = fs.readdirSync(sessionDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (AUDIO_FILE_EXTENSIONS.has(ext)) {
        paths.push(path.join(sessionDir, entry.name))
      }
    }
  } catch (e) {
    console.error('failed to read session dir', e)
  }

  const chunksDir = path.join(sessionDir, 'chunks')
  if (fs.existsSync(chunksDir)) {
    try {
      const entries = fs.readdirSync(chunksDir)
      for (const entry of entries) {
        if (entry.toLowerCase().endsWith('.wav')) {
          paths.push(path.join(chunksDir, entry))
        }
      }
    } catch (e) {
      console.error('failed to read chunks dir', e)
    }
  }
  return paths
}

function getModelsRoot(): string {
  return path.join(getUserDataRoot(), 'models')
}

function getAppModelsRoot(): string {
  return path.join(process.env.APP_ROOT!, 'models')
}

function getPackagedModelsRoot(): string {
  return path.join(process.resourcesPath, 'models')
}

function getWhisperRoot(): string {
  const override = process.env['WHISPER_ROOT']
  if (override && override.trim()) return override
  const candidates = [
    path.join(getAppModelsRoot(), 'whisper'),
    path.join(getPackagedModelsRoot(), 'whisper'),
    path.join(getModelsRoot(), 'whisper'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(getAppModelsRoot(), 'whisper')
}

function getSileroVadModelPath(): string {
  const override = process.env['SILERO_VAD_MODEL']
  if (override && override.trim()) return override
  const candidates = [
    path.join(getAppModelsRoot(), 'silero_vad.onnx'),
    path.join(getPackagedModelsRoot(), 'silero_vad.onnx'),
    path.join(getModelsRoot(), 'silero_vad.onnx'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(getAppModelsRoot(), 'silero_vad.onnx')
}

function getPackagedFfmpegDir(): string {
  return path.join(process.resourcesPath, 'ffmpeg')
}

function getPackagedLibDir(): string {
  return path.join(process.resourcesPath, 'lib')
}

function getTorchCacheRoot(): string {
  return path.join(getUserDataRoot(), 'torch_cache')
}

function getPackagedTorchCacheRoot(): string {
  return path.join(process.resourcesPath, 'torch_cache')
}

function getFfmpegPathFromDir(dir: string): string {
  return process.platform === 'win32' ? path.join(dir, 'ffmpeg.exe') : path.join(dir, 'ffmpeg')
}

function resolveFfmpegPath(): string | null {
  const override = process.env['FFMPEG_PATH']
  if (override && override.trim() && fs.existsSync(override)) return override

  const packaged = getFfmpegPathFromDir(getPackagedFfmpegDir())
  if (fs.existsSync(packaged)) return packaged

  const devBundled = getFfmpegPathFromDir(path.join(process.env.APP_ROOT!, 'ffmpeg'))
  if (fs.existsSync(devBundled)) return devBundled

  return null
}

function ensureTorchCacheReady(): string {
  const userCache = getTorchCacheRoot()
  fs.mkdirSync(userCache, { recursive: true })

  const packagedCache = getPackagedTorchCacheRoot()
  if (!fs.existsSync(packagedCache)) return userCache

  const userEntries = fs.readdirSync(userCache)
  if (userEntries.length > 0) return userCache

  try {
    fs.cpSync(packagedCache, userCache, { recursive: true, force: true })
  } catch (e) {
    console.error('failed to seed torch cache', e)
  }
  return userCache
}

function getBackendRoot(): string {
  const override = process.env['BACKEND_ROOT']
  if (override && override.trim()) return override
  const userBackend = path.join(getUserDataRoot(), 'backend')
  if (fs.existsSync(userBackend)) return userBackend
  const packagedBackend = path.join(process.resourcesPath, 'backend')
  if (fs.existsSync(packagedBackend)) return packagedBackend
  return path.join(process.env.APP_ROOT!, 'backend')
}

function getBundledPythonPath(): string {
  return process.platform === 'win32'
    ? path.join(process.resourcesPath, 'python', 'python.exe')
    : path.join(process.resourcesPath, 'python', 'bin', 'python3')
}

function getUserPythonPath(): string {
  return process.platform === 'win32'
    ? path.join(getUserDataRoot(), 'python', 'python.exe')
    : path.join(getUserDataRoot(), 'python', 'bin', 'python3')
}

function getActiveEnvPythonPath(): string | null {
  const candidates: string[] = []
  const venv = process.env['VIRTUAL_ENV']?.trim()
  const conda = process.env['CONDA_PREFIX']?.trim()

  if (process.platform === 'win32') {
    if (venv) candidates.push(path.join(venv, 'Scripts', 'python.exe'))
    if (conda) candidates.push(path.join(conda, 'python.exe'))
  } else {
    if (venv) candidates.push(path.join(venv, 'bin', 'python'))
    if (conda) candidates.push(path.join(conda, 'bin', 'python'))
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function getPythonCommand(): string {
  const override = process.env['MEETING_NOTES_PYTHON']
  if (override && override.trim()) return override
  const bundled = getBundledPythonPath()
  if (fs.existsSync(bundled)) return bundled
  const userBundled = getUserPythonPath()
  if (fs.existsSync(userBundled)) return userBundled
  const activeEnvPython = getActiveEnvPythonPath()
  if (activeEnvPython) return activeEnvPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

function getPythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WHISPER_ROOT: getWhisperRoot() }
  env.TORCH_HOME = env.TORCH_HOME || ensureTorchCacheReady()
  const ffmpegPath = resolveFfmpegPath()
  if (ffmpegPath) {
    env.FFMPEG_PATH = env.FFMPEG_PATH || ffmpegPath
    const dir = path.dirname(ffmpegPath)
    env.PATH = [dir, env.PATH || ''].filter(Boolean).join(path.delimiter)
  }
  if (process.platform === 'darwin') {
    const libDir = getPackagedLibDir()
    if (fs.existsSync(libDir)) {
      env.DYLD_LIBRARY_PATH = [libDir, env.DYLD_LIBRARY_PATH || ''].filter(Boolean).join(path.delimiter)
    }
  }
  env.GGML_LOG_LEVEL = env.GGML_LOG_LEVEL || '0'
  env.LLAMA_CPP_LOG_LEVEL = env.LLAMA_CPP_LOG_LEVEL || '0'
  return env
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).filter(Boolean).length
}

function resetChunkSummariesState(): void {
  chunkQueue = []
  chunkProcessing = false
  nextChunkId = 0
  chunkSummaries = new Map()
  lastTranscriptOffset = 0
  transcriptBuffer = ''
  chunkSummariesEnabled = false
  chunkSummariesSession = null
  finalSummaryPending = null
  finalSummaryRunning = false
  pendingFinalSummarySession = null
}

function queueChunkSummarization(text: string): void {
  if (!chunkSummariesEnabled || !summarizerProcess) return
  const chunkText = text.trim()
  if (!chunkText) return
  chunkQueue.push({ id: nextChunkId++, text: chunkText, sessionDir: currentSessionDir })
  processChunkQueue()
}

function processChunkQueue(): void {
  if (chunkProcessing || !summarizerProcess || chunkQueue.length === 0) return
  const task = chunkQueue.shift()!
  chunkProcessing = true
  const payload = {
    cmd: 'summarize',
    text: task.text,
    out: null,
    chunk_words: CHUNK_WORD_THRESHOLD,
    context: { type: 'chunk', id: task.id, sessionDir: task.sessionDir },
  }
  const ok = sendProcessCommand(summarizerProcess, 'summarizer', JSON.stringify(payload) + '\n')
  if (!ok) {
    chunkProcessing = false
    chunkQueue.unshift(task)
    console.error('[summarizer chunk] failed to send chunk summarization command')
    maybeStartPendingFinalSummary()
  }
}

function processTranscriptPartialText(fullText: string): void {
  if (!chunkSummariesEnabled) return
  const text = fullText || ''
  transcriptBuffer = text
  const unprocessed = transcriptBuffer.slice(lastTranscriptOffset)
  if (!unprocessed.trim()) return
  if (countWords(unprocessed) >= CHUNK_WORD_THRESHOLD) {
    queueChunkSummarization(unprocessed)
    lastTranscriptOffset = transcriptBuffer.length
  }
}

function maybeStartPendingFinalSummary(): void {
  if (!finalSummaryPending) return
  if (chunkProcessing || chunkQueue.length > 0) return
  const text = finalSummaryPending
  finalSummaryPending = null
  startFinalSummary(text)
}

function requestFinalSummary(fullText: string): void {
  if (!currentSessionDir) {
    console.error('cannot request final summary without a session directory')
    return
  }
  finalSummaryPending = fullText
  chunkSummariesEnabled = false
  pendingFinalSummarySession = currentSessionDir
  maybeStartPendingFinalSummary()
}

function startFinalSummary(fullText: string): void {
  if (!summarizerProcess || finalSummaryRunning) return
  finalSummaryRunning = true
  const orderedSummaries = Array.from(chunkSummaries.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, summary]) => summary)
    .filter(Boolean)
  const leftoverStart = Math.min(lastTranscriptOffset, fullText.length)
  const leftover = fullText.slice(leftoverStart).trim()
  const segments: string[] = []
  if (orderedSummaries.length > 0) {
    segments.push(`Previous chunk summaries:\n${orderedSummaries.join('\n\n')}`)
  }
  if (leftover) {
    segments.push(`Remaining transcript:\n${leftover}`)
  }
  const inputText = segments.length > 0 ? segments.join('\n\n') : fullText
  const summarySessionDir = pendingFinalSummarySession || currentSessionDir
  if (!summarySessionDir) {
    console.error('final summary requested with no session directory')
    finalSummaryRunning = false
    return
  }
  const summaryOut = path.join(summarySessionDir, 'summary.txt')
  const payload = {
    cmd: 'summarize',
    text: inputText,
    out: summaryOut,
    chunk_words: CHUNK_WORD_THRESHOLD,
    context: { type: 'final', sessionDir: summarySessionDir },
  }
  const ok = sendProcessCommand(summarizerProcess, 'summarizer', JSON.stringify(payload) + '\n')
  if (!ok) {
    finalSummaryRunning = false
    console.error('[summarizer final] failed to send summary command')
  }
}

function handleChunkSummarizerEvent(
  obj: SummarizerEvent,
  context: { type?: string; id?: number; sessionDir?: string | null } | undefined,
): void {
  if (!context || context.type !== 'chunk') return
  if (!context.sessionDir || context.sessionDir !== chunkSummariesSession) return
  const chunkId = typeof context.id === 'number' ? context.id : null
  if (obj.event === 'progress') {
    return
  }
  if (obj.event === 'summary_delta') {
    return
  }
  if (obj.event === 'done' || obj.event === 'error') {
    chunkProcessing = false
    if (obj.event === 'done' && chunkId !== null) {
      const summaryText = (obj.text || '').trim()
      if (summaryText) chunkSummaries.set(chunkId, summaryText)
    }
    if (obj.event === 'error') {
      console.error(`[summarizer chunk ${chunkId}] error`, obj.msg)
    }
    processChunkQueue()
    maybeStartPendingFinalSummary()
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

function getHttpClient(url: string) {
  return url.startsWith('https:') ? https : http
}

function downloadFile(url: string, destPath: string, onProgress?: (progress: { downloaded: number; total?: number; percent?: number }) => void, redirects = 0): Promise<void> {
  if (redirects > 5) {
    return Promise.reject(new Error('too many redirects'))
  }
  return new Promise((resolve, reject) => {
    const client = getHttpClient(url)
    const request = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        resolve(downloadFile(res.headers.location, destPath, onProgress, redirects + 1))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`download failed with status ${res.statusCode}`))
        return
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const tmpPath = `${destPath}.partial`
      const file = fs.createWriteStream(tmpPath)
      let downloaded = 0
      const total = Number(res.headers['content-length'] || 0)
      res.on('data', (chunk) => {
        downloaded += chunk.length
        if (onProgress) {
          if (total > 0) {
            const percent = Math.min(100, Math.round((downloaded / total) * 100))
            onProgress({ downloaded, total, percent })
          } else {
            onProgress({ downloaded })
          }
        }
      })
      res.on('error', (err) => {
        file.close(() => undefined)
        try {
          fs.unlinkSync(tmpPath)
        } catch {
          // ignore cleanup errors
        }
        reject(err)
      })
      file.on('error', (err) => {
        res.destroy()
        try {
          fs.unlinkSync(tmpPath)
        } catch {
          // ignore cleanup errors
        }
        reject(err)
      })
      file.on('finish', () => {
        file.close(() => {
          fs.rename(tmpPath, destPath, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      })
      res.pipe(file)
    })
    request.on('error', reject)
  })
}

async function verifyPythonCommand(command: string) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.on('error', (err) => reject(err))
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`python exited with ${code}`))
    })
  })
}

async function verifyFfmpegAvailable(): Promise<void> {
  const ffmpegPath = resolveFfmpegPath()
  if (ffmpegPath) return

  if (app.isPackaged) {
    throw new Error('ffmpeg missing in installer')
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.on('error', (err) => reject(err))
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error('ffmpeg not available on PATH'))
    })
  })
}

async function ensurePythonRuntime(): Promise<void> {
  const override = process.env['MEETING_NOTES_PYTHON']
  if (override && override.trim()) {
    const hasPath = override.includes(path.sep) || override.includes('/')
    if (hasPath && !fs.existsSync(override)) {
      throw new Error(`MEETING_NOTES_PYTHON not found at ${override}`)
    }
    await verifyPythonCommand(override)
    return
  }

  if (fs.existsSync(getBundledPythonPath())) return
  if (fs.existsSync(getUserPythonPath())) return

  if (app.isPackaged) {
    throw new Error('bundled python runtime missing in installer')
  }

  await verifyPythonCommand(getPythonCommand())
}

async function runSetupScript(whisperModel: string, whisperDir: string): Promise<void> {
  const script = path.join(getBackendRoot(), 'setup.py')
  return new Promise((resolve, reject) => {
    const env = { ...getPythonEnv(), WHISPER_MODEL: whisperModel, WHISPER_DIR: whisperDir }
    const proc = spawn(getPythonCommand(), [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    let buf = ''
    proc.stdout?.on('data', (data) => {
      buf += data.toString()
      const parts = buf.split('\n')
      buf = parts.pop() || ''
      for (const raw of parts) {
        const line = raw.trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          if (obj.event === 'status') {
            sendBootstrapStatus('running', obj.message || 'running setup')
          } else if (obj.event === 'done') {
            sendBootstrapStatus('running', obj.message || 'setup complete')
          } else if (obj.event === 'error') {
            sendBootstrapStatus('error', obj.message || 'setup failed')
          }
        } catch {
          // Ignore non-JSON setup output lines.
        }
      }
    })
    proc.stderr?.on('data', (data) => console.error('[setup err]', data.toString().trim()))
    proc.on('error', (err) => reject(err))
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`setup failed with code ${code}`))
      }
    })
  })
}

async function ensureWhisperModel(): Promise<void> {
  const model = process.env['WHISPER_MODEL'] || 'small.en'
  const whisperDir = getWhisperRoot()
  const repoIdDir = `models--Systran--faster-whisper-${model}`
  const localCacheDir = path.join(whisperDir, repoIdDir)
  if (fs.existsSync(localCacheDir)) return

  fs.mkdirSync(whisperDir, { recursive: true })
  await runSetupScript(model, whisperDir)
}

function resolveSummaryModelPath(): string | null {
  const override = process.env['SUMMODEL']
  if (override && override.trim()) return override
  if (downloadedSummaryModelPath && fs.existsSync(downloadedSummaryModelPath)) return downloadedSummaryModelPath

  const bundledCandidates = [
    path.join(getModelsRoot(), DEFAULT_SUMMARY_MODEL_NAME),
    path.join(getPackagedModelsRoot(), DEFAULT_SUMMARY_MODEL_NAME),
    path.join(process.env.APP_ROOT!, 'models', DEFAULT_SUMMARY_MODEL_NAME),
  ]
  for (const candidate of bundledCandidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  const candidates = [getModelsRoot(), getPackagedModelsRoot(), path.join(process.env.APP_ROOT!, 'models')]
  for (const modelsDir of candidates) {
    if (!fs.existsSync(modelsDir)) continue
    const preferred = path.join(modelsDir, DEFAULT_SUMMARY_MODEL_NAME)
    if (fs.existsSync(preferred)) return preferred
    try {
      const entries = fs.readdirSync(modelsDir, { withFileTypes: true })
      const ggufs = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
        .map((entry) => path.join(modelsDir, entry.name))
        .sort()
      if (ggufs.length > 0) return ggufs[0]
    } catch (e) {
      console.error('failed to scan models directory', e)
    }

    const ggmlBin = path.join(modelsDir, 'ggml-model.bin')
    if (fs.existsSync(ggmlBin)) return ggmlBin
  }

  return null
}

async function ensureSummaryModel(): Promise<string | null> {
  const override = process.env['SUMMODEL']
  if (override && override.trim()) {
    if (!fs.existsSync(override)) {
      throw new Error(`summary model not found at ${override}`)
    }
    return override
  }

  const existing = resolveSummaryModelPath()
  if (existing && fs.existsSync(existing)) {
    downloadedSummaryModelPath = existing
    return existing
  }

  if (app.isPackaged) {
    throw new Error('summary model missing in installer')
  }

  const url = process.env['SUMMODEL_URL']
  if (!url) {
    throw new Error(
      `summary model missing; place ${DEFAULT_SUMMARY_MODEL_NAME} under ${path.join(process.env.APP_ROOT!, 'models')} or set SUMMODEL_URL to download it`,
    )
  }

  const modelsDir = getModelsRoot()
  let targetName = DEFAULT_SUMMARY_MODEL_NAME
  try {
    const parsed = new URL(url)
    const base = path.basename(parsed.pathname)
    if (base) targetName = base
  } catch {
    // keep default name if URL parsing fails
  }
  const targetPath = path.join(modelsDir, targetName)

  sendBootstrapStatus('running', 'downloading summary model', 0)
  await downloadFile(url, targetPath, (progress) => {
    if (typeof progress.percent === 'number') {
      sendBootstrapStatus('running', 'downloading summary model', progress.percent)
    }
  })
  downloadedSummaryModelPath = targetPath
  return targetPath
}

async function ensureDependencies(): Promise<boolean> {
  if (setupState === 'done') return true
  if (setupPromise) return setupPromise
  setupState = 'running'
  setupPromise = (async () => {
    try {
      ensureTorchCacheReady()
      await verifyFfmpegAvailable()
      await ensurePythonRuntime()
      await ensureWhisperModel()
      await ensureSummaryModel()
      setupState = 'done'
      sendBootstrapStatus('done', 'ready', 100)
      return true
    } catch (e) {
      setupState = 'error'
      const msg = e instanceof Error ? e.message : 'setup failed'
      sendBootstrapStatus('error', msg)
      return false
    } finally {
      setupPromise = null
    }
  })()
  return setupPromise
}

function startSummarizerIfNeeded(modelPath: string | null) {
  if (!modelPath) {
    console.error('summary model path not set')
    try {
      win?.webContents.send('summary-status', { state: 'error', sessionDir: currentSessionDir, message: 'summary model not found' })
    } catch (e) {
      console.error('failed to send summary-status error', e)
    }
    return
  }

  if (summarizerProcess) {
    if (currentSummaryModelPath && currentSummaryModelPath !== modelPath) {
      const ok = sendProcessCommand(summarizerProcess, 'summarizer', JSON.stringify({ cmd: 'load_model', model_path: modelPath }) + '\n')
      if (ok) currentSummaryModelPath = modelPath
    }
    return
  }

  const script = path.join(getBackendRoot(), 'summarizer_daemon.py')
  const env = { ...getPythonEnv(), SUMMODEL_PATH: modelPath }
  summarizerProcess = spawn(getPythonCommand(), [script], { stdio: ['pipe', 'pipe', 'pipe'], env })
  currentSummaryModelPath = modelPath

  if (summarizerProcess.stdout) summarizerProcess.stdout.on('data', (d) => {
    const s = d.toString()
    summarizerStdoutBuf += s
    const parts = summarizerStdoutBuf.split('\n')
    summarizerStdoutBuf = parts.pop() || ''
    for (const line of parts) {
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        const context = obj.context as { type?: string; id?: number; sessionDir?: string } | undefined
        const contextSessionDir = context?.sessionDir ?? null
        if (context?.type === 'chunk') {
          handleChunkSummarizerEvent(obj, context)
          continue
        }
        const isFinalContext = context?.type === 'final'
        if (isFinalContext && (!pendingFinalSummarySession || contextSessionDir !== pendingFinalSummarySession)) {
          continue
        }
        const summarySessionDir = contextSessionDir || pendingFinalSummarySession || currentSessionDir
        if (isFinalContext && (obj.event === 'done' || obj.event === 'error')) {
          finalSummaryRunning = false
        }
        if (obj.event === 'summary_start') {
          try {
            win?.webContents.send('summary-stream', { sessionDir: summarySessionDir, reset: true })
          } catch (e) {
            console.error('failed to send summary-stream reset', e)
          }
        } else if (obj.event === 'summary_delta') {
          const delta = obj.text || ''
          if (delta) {
            try {
              win?.webContents.send('summary-stream', { sessionDir: summarySessionDir, delta })
            } catch (e) {
              console.error('failed to send summary-stream delta', e)
            }
          }
        } else if (obj.event === 'done') {
          const summaryOut = obj.out
          const summaryText = obj.text || ''
          try {
            win?.webContents.send('summary-ready', { sessionDir: summarySessionDir, summaryPath: summaryOut, text: summaryText })
          } catch (e) {
            console.error('failed to send summary-ready', e)
          }
          try {
            win?.webContents.send('summary-status', { state: 'done', sessionDir: summarySessionDir, message: 'summary complete' })
          } catch (e) {
            console.error('failed to send summary-status done', e)
          }
          if (isFinalContext) {
            pendingFinalSummarySession = null
          }
        } else if (obj.event === 'followup_done') {
          const requestId = obj.id
          const request = requestId ? followUpRequests.get(requestId) : null
          if (request) {
            clearTimeout(request.timeout)
            request.resolve({ ok: true, text: obj.text || '' })
            followUpRequests.delete(requestId)
          } else {
            console.warn('[summarizer] follow-up done with no request id', obj.id)
          }
        } else if (obj.event === 'progress') {
          if (context?.type !== 'final') continue
          try {
            win?.webContents.send('summary-status', { state: 'running', sessionDir: summarySessionDir, message: obj.msg || 'summarizing' })
          } catch (e) {
            console.error('failed to send summary-status running', e)
          }
        } else if (obj.event === 'error') {
          console.error('[summarizer error]', obj.msg)
          try {
            win?.webContents.send('summary-status', { state: 'error', sessionDir: summarySessionDir, message: obj.msg || 'summary error' })
          } catch (e) {
            console.error('failed to send summary-status error', e)
          }
          if (isFinalContext) {
            pendingFinalSummarySession = null
          }
        } else if (obj.event === 'followup_error') {
          const requestId = obj.id
          const request = requestId ? followUpRequests.get(requestId) : null
          if (request) {
            clearTimeout(request.timeout)
            request.resolve({ ok: false, error: obj.msg || 'follow-up error' })
            followUpRequests.delete(requestId)
          } else {
            console.warn('[summarizer] follow-up error with no request id', obj.id, obj.msg)
          }
        }
      } catch {
        // ignore non-JSON metadata
      }
    }
  })
  else console.error('[summarizer] stdout not available')
  if (summarizerProcess.stderr) summarizerProcess.stderr.on('data', () => {})
  else console.error('[summarizer] stderr not available')
  summarizerProcess.on('error', (err) => {
    console.error('[summarizer spawn error]', err)
    try {
      win?.webContents.send('summary-status', { state: 'error', sessionDir: currentSessionDir, message: 'failed to start summarizer' })
    } catch (e) {
      console.error('failed to send summary-status spawn error', e)
    }
  })
  summarizerProcess.on('exit', (code) => {
    console.log('[summarizer] exited', code)
    summarizerProcess = null
    if (followUpRequests.size > 0) {
      for (const [id, request] of followUpRequests.entries()) {
        clearTimeout(request.timeout)
        request.resolve({ ok: false, error: 'summarizer exited before follow-up finished' })
        followUpRequests.delete(id)
      }
    }
  })
}

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
    const modelPath = resolveSummaryModelPath()
    if (!modelPath || !fs.existsSync(modelPath)) {
      throw new Error('summary model not found')
    }
    startSummarizerIfNeeded(modelPath)
    try {
      win?.webContents.send('summary-status', { state: 'starting', sessionDir: currentSessionDir, message: 'starting summarization' })
    } catch (e) {
      console.error('failed to send summary-status starting', e)
    }
    if (!summarizerProcess) throw new Error('summarizer not running')
    requestFinalSummary(text)
  } catch (e) {
    console.error('failed to start summarizer', e)
    try {
      win?.webContents.send('summary-status', { state: 'error', sessionDir: currentSessionDir, message: 'failed to start summarizer' })
    } catch (e2) {
      console.error('failed to send summary-status error', e2)
    }
  }
}

function handleRecordOutput(data: Buffer) {
  recordStdoutBuf += data.toString()
    const parts = recordStdoutBuf.split('\n')
    recordStdoutBuf = parts.pop() || ''
    for (const rawLine of parts) {
      const line = rawLine.trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj.event === 'partial') {
          try {
            win?.webContents.send('transcript-partial', {
              sessionDir: currentSessionDir,
              text: obj.text || '',
              fullText: obj.full_text || obj.fullText || '',
            })
          } catch (e) {
            console.error('failed to send transcript-partial', e)
          }
          const partialText = obj.full_text || obj.fullText || obj.text || ''
          processTranscriptPartialText(partialText)
          continue
        }
        if (obj.event === 'started') {
          const startedAt =
            typeof obj.started_at === 'number'
              ? obj.started_at
              : typeof obj.startedAt === 'number'
              ? obj.startedAt
              : null
          const startedAtMs = startedAt ? Math.round(startedAt * 1000) : Date.now()
          try {
            win?.webContents.send('recording-started', { sessionDir: currentSessionDir, startedAtMs })
          } catch (e) {
            console.error('failed to send recording-started', e)
          }
          continue
        }
        if (obj.event === 'ready') {
          try {
            win?.webContents.send('recording-ready', { ready: true })
          } catch (e) {
            console.error('failed to send recording-ready', e)
          }
          continue
        }
        if (obj.event === 'done' && obj.out) {
          const outPath = obj.out
          const text = obj.text || ''
          handleTranscriptReady(outPath, text)
          continue
        }
        if (obj.event === 'error') {
          const message = obj.msg || 'recording error'
          console.error('[backend recorder error]', message)
          try {
            win?.webContents.send('transcription-status', { state: 'error', sessionDir: currentSessionDir, message })
          } catch (e) {
            console.error('failed to send transcription-status recorder error', e)
          }
          continue
        }
      } catch {
        continue
      }
    }
}

function handleFileTranscribeEvent(obj: SummarizerEvent & { out?: string }) {
  const sessionDir = currentSessionDir
  if (!sessionDir) return
  if (obj.event === 'started') {
    try {
      win?.webContents.send('transcription-status', {
        state: 'running',
        sessionDir,
        message: 'transcribing uploaded recording',
      })
    } catch (e) {
      console.error('failed to send transcription-status running', e)
    }
    return
  }
  if (obj.event === 'done' && obj.out) {
    handleTranscriptReady(obj.out, obj.text || '')
    return
  }
  if (obj.event === 'error') {
    const message = obj.msg || 'transcription failed'
    try {
      win?.webContents.send('transcription-status', { state: 'error', sessionDir, message })
    } catch (e) {
      console.error('failed to send transcription-status error', e)
    }
  }
}



function makeSessionDir() {
  const sessionsRoot = getSessionsRoot()
  fs.mkdirSync(sessionsRoot, { recursive: true })

  const ts = new Date()
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\..+$/, '') // remove milliseconds + Z
  const sessionDir = path.join(sessionsRoot, ts)
  fs.mkdirSync(sessionDir, { recursive: true })
  return sessionDir
}

function classifyInputFile(filePath: string): 'audio' | 'transcript' | null {
  const ext = path.extname(filePath).toLowerCase()
  if (AUDIO_FILE_EXTENSIONS.has(ext)) return 'audio'
  if (TRANSCRIPT_FILE_EXTENSIONS.has(ext)) return 'transcript'
  return null
}

function readTranscriptTextFromFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8')
  if (path.extname(filePath).toLowerCase() !== '.json') return raw
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string') return parsed
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.text === 'string') return obj.text
      if (typeof obj.transcript === 'string') return obj.transcript
      if (Array.isArray(obj.segments)) {
        const lines = obj.segments
          .map((seg) => {
            if (!seg || typeof seg !== 'object') return ''
            const text = (seg as Record<string, unknown>).text
            return typeof text === 'string' ? text.trim() : ''
          })
          .filter(Boolean)
        if (lines.length > 0) return lines.join('\n')
      }
    }
  } catch {
    // Fall back to raw JSON text when shape is unknown.
  }
  return raw
}

function startImportedSession(): string {
  resetChunkSummariesState()
  const sessionDir = makeSessionDir()
  currentSessionDir = sessionDir
  chunkSummariesSession = sessionDir
  try {
    win?.webContents.send('session-started', { sessionDir, sessionsRoot: getSessionsRoot() })
  } catch (e) {
    console.error('failed to send session-started for imported input', e)
  }
  return sessionDir
}

async function ensureSummarizerRuntime(): Promise<ProcessResult> {
  try {
    await ensurePythonRuntime()
    const summaryModelPath = await ensureSummaryModel()
    if (!summaryModelPath) {
      return { ok: false, error: 'summary model not found' }
    }
    startSummarizerIfNeeded(summaryModelPath)
    if (!summarizerProcess) {
      return { ok: false, error: 'summarizer not running' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'failed to prepare summarizer' }
  }
}

async function processRecordingFromPath(audioPath: string): Promise<ProcessResult> {
  if (fileTranscribeProcess) {
    return { ok: false, error: 'Already processing a recording' }
  }
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

  const sessionDir = startImportedSession()
  const destAudio = path.join(sessionDir, path.basename(audioPath))
  try {
    fs.copyFileSync(audioPath, destAudio)
  } catch (e) {
    return { ok: false, error: `failed to copy recording: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    win?.webContents.send('transcription-status', { state: 'running', sessionDir, message: 'preparing transcription' })
  } catch (e) {
    console.error('failed to send transcription-status running for upload', e)
  }
  const transcriptPath = path.join(sessionDir, 'transcript.txt')
  const summaryModelPath = resolveSummaryModelPath()
  if (!summaryModelPath) {
    return { ok: false, error: 'summary model not found' }
  }
  startSummarizerIfNeeded(summaryModelPath)
  const script = path.join(getBackendRoot(), 'transcribe_file.py')
  const env = {
    ...getPythonEnv(),
    TRANSCRIBE_MODEL: currentModelName,
    TRANSCRIBE_AUDIO: destAudio,
    TRANSCRIPT_OUT: transcriptPath,
  }
  fileTranscribeStdoutBuf = ''
  fileTranscribeProcess = spawn(getPythonCommand(), [script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  fileTranscribeProcess.on('error', (err) => {
    console.error('[file-transcribe spawn error]', err)
    fileTranscribeProcess = null
    try {
      win?.webContents.send('transcription-status', {
        state: 'error',
        sessionDir,
        message: 'failed to start uploaded recording transcription',
      })
    } catch (sendErr) {
      console.error('failed to send transcription-status file-transcribe spawn error', sendErr)
    }
  })
  if (fileTranscribeProcess.stdout) {
    fileTranscribeProcess.stdout.on('data', (data) => {
      fileTranscribeStdoutBuf += data.toString()
      const parts = fileTranscribeStdoutBuf.split('\n')
      fileTranscribeStdoutBuf = parts.pop() || ''
      for (const rawLine of parts) {
        const line = rawLine.trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          handleFileTranscribeEvent(obj)
        } catch {
          continue
        }
      }
    })
  } else {
    console.error('[file-transcribe] stdout not available')
  }
  if (fileTranscribeProcess.stderr) {
    fileTranscribeProcess.stderr.on('data', (data) => {
      console.error('[file-transcribe err]', data.toString().trim())
    })
  } else {
    console.error('[file-transcribe] stderr not available')
  }
  fileTranscribeProcess.on('exit', () => {
    fileTranscribeProcess = null
  })
  return { ok: true }
}

async function processTranscriptText(text: string): Promise<ProcessResult> {
  if (!win) {
    return { ok: false, error: 'window not ready' }
  }
  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, error: 'transcript text is empty' }
  }
  const ready = await ensureSummarizerRuntime()
  if (!ready.ok) return ready

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

async function processTranscriptFromPath(transcriptPath: string): Promise<ProcessResult> {
  if (!fs.existsSync(transcriptPath)) {
    return { ok: false, error: `transcript file not found: ${transcriptPath}` }
  }
  let text = ''
  try {
    text = readTranscriptTextFromFile(transcriptPath)
  } catch (e) {
    return { ok: false, error: `failed to read transcript: ${e instanceof Error ? e.message : String(e)}` }
  }
  return processTranscriptText(text)
}

async function processInputPath(inputPath: string): Promise<ProcessResult> {
  if (!inputPath || typeof inputPath !== 'string') {
    return { ok: false, error: 'file path is required' }
  }
  const resolvedPath = path.resolve(inputPath)
  if (!fs.existsSync(resolvedPath)) {
    return { ok: false, error: `file not found: ${resolvedPath}` }
  }
  const kind = classifyInputFile(resolvedPath)
  if (kind === 'audio') return processRecordingFromPath(resolvedPath)
  if (kind === 'transcript') return processTranscriptFromPath(resolvedPath)
  return { ok: false, error: 'unsupported file type; use audio or text transcript files' }
}



async function startBackend() {
  if (backendProcess) {
    console.log('[backend] already running')
    return
  }

  const ready = await ensureDependencies()
  if (!ready) return

  recordStdoutBuf = ''
  try {
    win?.webContents.send('recording-ready', { ready: false })
  } catch (e) {
    console.error('failed to send recording-ready false', e)
  }

  const scriptPath = path.join(getBackendRoot(), 'record_and_transcribe.py')
  const env = { ...getPythonEnv(), WHISPER_MODEL: currentModelName }

  startSummarizerIfNeeded(resolveSummaryModelPath())

  backendProcess = spawn(getPythonCommand(), [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })

  if (backendProcess.stdout) backendProcess.stdout.on('data', (data) => {
    handleRecordOutput(data)
  })
  else console.error('[backend] stdout not available')

  if (backendProcess.stderr) backendProcess.stderr.on('data', (data) => {
    console.error('[backend err]', data.toString().trim())
  })
  else console.error('[backend] stderr not available')

  backendProcess.on('error', (err) => {
    console.error('[backend spawn error]', err)
    try {
      win?.webContents.send('transcription-status', { state: 'error', sessionDir: currentSessionDir, message: 'failed to start recorder' })
    } catch (e) {
      console.error('failed to send transcription-status spawn error', e)
    }
  })
  backendProcess.on('exit', (code) => {
    console.log('[backend] exited with code', code)
    backendProcess = null
    try {
      win?.webContents.send('recording-ready', { ready: false })
    } catch (e) {
      console.error('failed to send recording-ready false', e)
    }
  })
}

async function processUploadedRecording(): Promise<ProcessResult> {
  if (!win) return { ok: false, error: 'window not ready' }
  const dialogResult = await dialog.showOpenDialog(win!, {
    title: 'Select a recording',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg', 'webm'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { ok: false, error: 'no file selected' }
  }
  return processRecordingFromPath(dialogResult.filePaths[0])
}

async function processUploadedTranscript(): Promise<ProcessResult> {
  if (!win) return { ok: false, error: 'window not ready' }
  const dialogResult = await dialog.showOpenDialog(win!, {
    title: 'Select a transcript',
    properties: ['openFile'],
    filters: [
      { name: 'Transcript', extensions: ['txt', 'md', 'markdown', 'srt', 'vtt', 'log', 'json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { ok: false, error: 'no file selected' }
  }
  return processTranscriptFromPath(dialogResult.filePaths[0])
}

function stopBackend() {
  if (!backendProcess) {
    console.log('[backend] not running')
    return
  }

  if (sendProcessCommand(backendProcess, 'recorder', JSON.stringify({ cmd: 'stop' }) + '\n')) {
    console.log('[backend] stop command sent')
    return
  }
  console.error('[backend] failed to send stop command')
}

function pauseBackend() {
  if (!backendProcess) {
    console.log('[backend] not running')
    return
  }
  sendProcessCommand(backendProcess, 'recorder', JSON.stringify({ cmd: 'pause' }) + '\n')
}

function resumeBackend() {
  if (!backendProcess) {
    console.log('[backend] not running')
    return
  }
  sendProcessCommand(backendProcess, 'recorder', JSON.stringify({ cmd: 'resume' }) + '\n')
}


ipcMain.on('backend-start', (_evt, opts: { deviceIndex?: number; loopbackDeviceIndex?: number; model?: string } = {}) => {
  void (async () => {
    console.log('[ipc] backend-start', opts)
    resetChunkSummariesState()
    if (opts && opts.model) currentModelName = opts.model
    await startBackend()
    if (!backendProcess) return

    const sessionDir = makeSessionDir()
    currentSessionDir = sessionDir
    chunkSummariesSession = sessionDir
    const outWav = path.join(sessionDir, 'audio.wav')
    const outTranscript = path.join(sessionDir, 'transcript.txt')
    console.log('[backend] sessionDir=', sessionDir)
    try {
      win?.webContents.send('session-started', { sessionDir, sessionsRoot: getSessionsRoot() })
    } catch (e) {
      console.error('failed to send session-started', e)
    }
    const payload = {
      cmd: 'start',
      out: outWav,
      transcript_out: outTranscript,
      device_index: opts && typeof opts.deviceIndex === 'number' ? opts.deviceIndex : undefined,
      loopback_device_index: opts && typeof opts.loopbackDeviceIndex === 'number' ? opts.loopbackDeviceIndex : undefined,
    }
    if (!sendProcessCommand(backendProcess, 'recorder', JSON.stringify(payload) + '\n')) {
      console.error('[backend] failed to send start command')
    }
  })()
})

ipcMain.on('backend-stop', () => {
  console.log('[ipc] backend-stop')
  stopBackend()
})

ipcMain.on('backend-pause', () => {
  console.log('[ipc] backend-pause')
  pauseBackend()
})

ipcMain.on('backend-resume', () => {
  console.log('[ipc] backend-resume')
  resumeBackend()
})

ipcMain.handle('list-devices', async () => {
  const script = path.join(getBackendRoot(), 'devices.py')
  return new Promise((resolve) => {
    const p = spawn(getPythonCommand(), [script], { stdio: ['ignore', 'pipe', 'pipe'], env: getPythonEnv() })
    let out = ''
    let settled = false
    const finish = (value: unknown) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    p.stdout?.on('data', (d) => (out += d.toString()))
    p.stderr?.on('data', (d) => console.error('[devices err]', d.toString().trim()))
    p.on('error', (err) => {
      console.error('[devices spawn error]', err)
      finish({ error: `failed to run devices script: ${err.message}` })
    })
    p.on('exit', () => {
      try {
        const json = JSON.parse(out || '{}')
        finish(json)
      } catch (e) {
        finish({ error: 'failed to parse devices', raw: out })
      }
    })
  })
})

ipcMain.handle('get-sessions-root', () => {
  return getSessionsRoot()
})

ipcMain.handle('choose-sessions-root', async () => {
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
})

ipcMain.handle('process-recording', async () => {
  try {
    return await processUploadedRecording()
  } catch (e) {
    console.error('[process-recording] failed', e)
    return { ok: false, error: e instanceof Error ? e.message : 'failed to process recording' }
  }
})

ipcMain.handle('process-transcript-file', async () => {
  try {
    return await processUploadedTranscript()
  } catch (e) {
    console.error('[process-transcript-file] failed', e)
    return { ok: false, error: e instanceof Error ? e.message : 'failed to process transcript file' }
  }
})

ipcMain.handle('summarize-transcript-text', async (_evt, payload: { text?: string } = {}) => {
  try {
    return await processTranscriptText(typeof payload.text === 'string' ? payload.text : '')
  } catch (e) {
    console.error('[summarize-transcript-text] failed', e)
    return { ok: false, error: e instanceof Error ? e.message : 'failed to summarize transcript text' }
  }
})

ipcMain.handle('process-input-path', async (_evt, inputPath: string) => {
  try {
    return await processInputPath(inputPath)
  } catch (e) {
    console.error('[process-input-path] failed', e)
    return { ok: false, error: e instanceof Error ? e.message : 'failed to process input file' }
  }
})

ipcMain.handle('generate-followup-email', async (_evt, payload: { summary?: string; studentName?: string; instructions?: string; temperature?: number; maxTokens?: number } = {}) => {
  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
  if (!summary) return { ok: false, error: 'summary is required' }
  const studentName = typeof payload.studentName === 'string' ? payload.studentName.trim() : ''
  const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : ''
  const temperature = typeof payload.temperature === 'number' ? payload.temperature : undefined
  const maxTokens = typeof payload.maxTokens === 'number' ? payload.maxTokens : undefined

  let modelPath: string | null = null
  try {
    modelPath = await ensureSummaryModel()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'failed to prepare summary model' }
  }
  if (!modelPath) return { ok: false, error: 'summary model not found' }
  startSummarizerIfNeeded(modelPath)
  if (!summarizerProcess) return { ok: false, error: 'summarizer not running' }

  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      followUpRequests.delete(requestId)
      resolve({ ok: false, error: 'follow-up generation timed out' })
    }, 90000)
    followUpRequests.set(requestId, { resolve, timeout })

    const cmd: Record<string, unknown> = {
      cmd: 'followup_email',
      id: requestId,
      summary,
      instructions,
    }
    if (studentName) cmd.student_name = studentName
    if (typeof temperature === 'number') cmd.temperature = temperature
    if (typeof maxTokens === 'number') cmd.max_tokens = maxTokens

    const ok = sendProcessCommand(summarizerProcess, 'summarizer', JSON.stringify(cmd) + '\n')
    if (!ok) {
      clearTimeout(timeout)
      followUpRequests.delete(requestId)
      resolve({ ok: false, error: 'failed to start follow-up generation' })
    }
  })
})

ipcMain.handle('delete-session-audio', async (_evt, sessionDir: string) => {
  const resolved = resolveSessionDir(sessionDir)
  if (!resolved) return { ok: false, error: 'invalid session directory' }
  if (backendProcess && currentSessionDir && path.resolve(currentSessionDir) === resolved) {
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
})


function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
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
  createWindow()
})

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
    void startBackend()
  }
})


app.on('before-quit', () => {
  if (backendProcess) {
    sendProcessCommand(backendProcess, 'recorder', JSON.stringify({ cmd: 'shutdown' }) + '\n')
    setTimeout(() => {
      if (!backendProcess) return
      try {
        backendProcess.kill('SIGTERM')
      } catch (e) {
        console.error('failed to kill backend', e)
      }
      backendProcess = null
    }, 3000)
  }
  if (summarizerProcess) {
    try {
      summarizerProcess.kill('SIGTERM')
    } catch (e) {
      console.error('failed to kill summarizer', e)
    }
    summarizerProcess = null
  }
})
