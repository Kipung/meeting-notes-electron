import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

const DEFAULT_SUMMARY_MODEL_URL = 'https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf'

let win: BrowserWindow | null
let backendProcess: ReturnType<typeof spawn> | null = null
let currentSessionDir: string | null = null
let currentModelName: string = 'small.en'
let transcriberProcess: ReturnType<typeof spawn> | null = null
let transcriberStdoutBuf = ''
let summarizerProcess: ReturnType<typeof spawn> | null = null
let summarizerStdoutBuf = ''
let currentSummaryModelPath: string | null = null
let recordStdoutBuf = ''
let pendingChunkTranscriptions = 0
let recordingStopped = false
let setupState: 'idle' | 'running' | 'done' | 'error' = 'idle'
let setupPromise: Promise<boolean> | null = null
let downloadedSummaryModelPath: string | null = null

const DEFAULT_RECORD_CHUNK_SECS = 0

function getUserDataRoot(): string {
  return app.getPath('userData')
}

function getSessionsRoot(): string {
  return path.join(getUserDataRoot(), 'sessions')
}

function getModelsRoot(): string {
  return path.join(getUserDataRoot(), 'models')
}

function getPackagedModelsRoot(): string {
  return path.join(process.resourcesPath, 'models')
}

function getWhisperRoot(): string {
  return path.join(getUserDataRoot(), 'whisper')
}

function getPackagedWhisperRoot(): string {
  return path.join(process.resourcesPath, 'whisper')
}

function getPackagedFfmpegDir(): string {
  return path.join(process.resourcesPath, 'ffmpeg')
}

function getPackagedLibDir(): string {
  return path.join(process.resourcesPath, 'lib')
}

function getFfmpegPathFromDir(dir: string): string {
  return process.platform === 'win32' ? path.join(dir, 'ffmpeg.exe') : path.join(dir, 'ffmpeg')
}

function resolveFfmpegPath(): string | null {
  const override = process.env['FFMPEG_PATH']
  if (override && override.trim() && fs.existsSync(override)) return override

  const packaged = getFfmpegPathFromDir(getPackagedFfmpegDir())
  if (fs.existsSync(packaged)) return packaged

  return null
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

function getPythonCommand(): string {
  const override = process.env['MEETING_NOTES_PYTHON']
  if (override && override.trim()) return override
  const bundled = getBundledPythonPath()
  if (fs.existsSync(bundled)) return bundled
  const userBundled = getUserPythonPath()
  if (fs.existsSync(userBundled)) return userBundled
  return process.platform === 'win32' ? 'python' : 'python3'
}

function getPythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WHISPER_ROOT: getWhisperRoot() }
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
  return env
}


function getRecordChunkSecs(): number {
  const raw = process.env['RECORD_CHUNK_SECS']
  if (!raw) return DEFAULT_RECORD_CHUNK_SECS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.floor(parsed)
}

function isChunkTranscriptPath(outPath: string): boolean {
  return outPath.includes(`${path.sep}chunks${path.sep}`) && outPath.endsWith('.txt')
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
    const proc = spawn(getPythonCommand(), [script, '--whisper-model', whisperModel, '--whisper-dir', whisperDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getPythonEnv(),
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
          console.log('[setup]', line)
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
  const modelPath = path.join(whisperDir, `${model}.pt`)
  if (fs.existsSync(modelPath)) return

  const packagedModelPath = path.join(getPackagedWhisperRoot(), `${model}.pt`)
  if (fs.existsSync(packagedModelPath)) {
    fs.mkdirSync(whisperDir, { recursive: true })
    fs.copyFileSync(packagedModelPath, modelPath)
    return
  }

  if (app.isPackaged) {
    throw new Error(`whisper model missing in installer: ${model}.pt`)
  }

  await runSetupScript(model, whisperDir)
}

function resolveSummaryModelPath(): string | null {
  const override = process.env['SUMMODEL']
  if (override && override.trim()) return override
  if (downloadedSummaryModelPath && fs.existsSync(downloadedSummaryModelPath)) return downloadedSummaryModelPath

  const candidates = [getModelsRoot(), getPackagedModelsRoot(), path.join(process.env.APP_ROOT!, 'models')]
  for (const modelsDir of candidates) {
    if (!fs.existsSync(modelsDir)) continue
    const preferred = path.join(modelsDir, 'Llama-3.2-3B-Instruct-Q4_K_M.gguf')
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

  const url = process.env['SUMMODEL_URL'] || DEFAULT_SUMMARY_MODEL_URL
  if (!url) return null

  const modelsDir = getModelsRoot()
  let targetName = 'Llama-3.2-3B-Instruct-Q4_K_M.gguf'
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

function finalizeTranscriptFromChunks(sessionDir: string) {
  const chunksDir = path.join(sessionDir, 'chunks')
  const outPath = path.join(sessionDir, 'transcript.txt')
  let combined = ''
  try {
    const files = fs
      .readdirSync(chunksDir)
      .filter((f) => f.endsWith('.txt'))
      .sort()
    for (const file of files) {
      const part = fs.readFileSync(path.join(chunksDir, file), 'utf-8').trim()
      if (part) combined += (combined ? '\n' : '') + part
    }
  } catch (e) {
    console.error('failed to assemble chunk transcripts', e)
  }
  try {
    fs.writeFileSync(outPath, combined)
  } catch (e) {
    console.error('failed to write combined transcript', e)
  }
  handleTranscriptReady(outPath, combined)
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
  summarizerProcess = spawn(getPythonCommand(), [script, '--model-path', modelPath], { stdio: ['pipe', 'pipe', 'pipe'], env: getPythonEnv() })
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
        if (obj.event === 'done') {
          const summaryOut = obj.out
          const summaryText = obj.text || ''
          try {
            win?.webContents.send('summary-ready', { sessionDir: currentSessionDir, summaryPath: summaryOut, text: summaryText })
          } catch (e) {
            console.error('failed to send summary-ready', e)
          }
          try {
            win?.webContents.send('summary-status', { state: 'done', sessionDir: currentSessionDir, message: 'summary complete' })
          } catch (e) {
            console.error('failed to send summary-status done', e)
          }
        } else if (obj.event === 'loaded') {
          console.log('[summarizer] loaded', obj.model)
        } else if (obj.event === 'progress') {
          console.log('[summarizer]', obj.msg)
          try {
            win?.webContents.send('summary-status', { state: 'running', sessionDir: currentSessionDir, message: obj.msg || 'summarizing' })
          } catch (e) {
            console.error('failed to send summary-status running', e)
          }
        } else if (obj.event === 'error') {
          console.error('[summarizer error]', obj.msg)
          try {
            win?.webContents.send('summary-status', { state: 'error', sessionDir: currentSessionDir, message: obj.msg || 'summary error' })
          } catch (e) {
            console.error('failed to send summary-status error', e)
          }
        }
      } catch (e) {
        console.error('failed to parse summarizer stdout line', e, line)
      }
    }
  })
  else console.error('[summarizer] stdout not available')
  if (summarizerProcess.stderr) summarizerProcess.stderr.on('data', (d) => console.error('[summarizer err]', d.toString().trim()))
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
    const summaryOut = path.join(currentSessionDir || '', 'summary.txt')
    try {
      win?.webContents.send('summary-status', { state: 'starting', sessionDir: currentSessionDir, message: 'starting summarization' })
    } catch (e) {
      console.error('failed to send summary-status starting', e)
    }
    if (!summarizerProcess) throw new Error('summarizer not running')
    if (!sendProcessCommand(summarizerProcess, 'summarizer', JSON.stringify({ cmd: 'summarize', file: outPath, out: summaryOut }) + '\n')) {
      throw new Error('summarizer stdin not available')
    }
  } catch (e) {
    console.error('failed to start summarizer', e)
    try {
      win?.webContents.send('summary-status', { state: 'error', sessionDir: currentSessionDir, message: 'failed to start summarizer' })
    } catch (e2) {
      console.error('failed to send summary-status error', e2)
    }
  }
}

function queueChunkTranscription(chunkPath: string) {
  if (!transcriberProcess) {
    console.error('transcriber not running for chunk', chunkPath)
    return
  }
  const chunkDir = path.dirname(chunkPath)
  const base = path.basename(chunkPath, path.extname(chunkPath))
  const outPath = path.join(chunkDir, `${base}.txt`)
  if (pendingChunkTranscriptions === 0) {
    try {
      win?.webContents.send('transcription-status', { state: 'starting', sessionDir: currentSessionDir, message: 'starting transcription' })
    } catch (e) {
      console.error('failed to send transcription-status starting', e)
    }
  }
  pendingChunkTranscriptions += 1
  const ok = sendProcessCommand(transcriberProcess, 'transcriber', JSON.stringify({ cmd: 'transcribe', wav: chunkPath, out: outPath }) + '\n')
  if (!ok) {
    pendingChunkTranscriptions = Math.max(pendingChunkTranscriptions - 1, 0)
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
      if (obj.event === 'chunk' && obj.path) {
        queueChunkTranscription(obj.path)
        continue
      }
    } catch {
      // not json
    }
    console.log('[backend]', line)
  }
}

function startTranscriberIfNeeded(modelName: string) {
  if (transcriberProcess) {
    // If model differs, request reload
    if (modelName && modelName !== currentModelName) {
      const ok = sendProcessCommand(transcriberProcess, 'transcriber', JSON.stringify({ cmd: 'load_model', model: modelName }) + '\n')
      if (ok) currentModelName = modelName
    }
    return
  }

  const script = path.join(getBackendRoot(), 'transcriber_daemon.py')
  transcriberProcess = spawn(getPythonCommand(), [script, '--model', modelName], { stdio: ['pipe', 'pipe', 'pipe'], env: getPythonEnv() })
  currentModelName = modelName

  if (transcriberProcess.stdout) transcriberProcess.stdout.on('data', (d) => {
    const s = d.toString()
    transcriberStdoutBuf += s
    // split lines
    const parts = transcriberStdoutBuf.split('\n')
    transcriberStdoutBuf = parts.pop() || ''
    for (const line of parts) {
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj.event === 'done') {
          const outPath = obj.out
          const text = obj.text || ''
          if (outPath && isChunkTranscriptPath(outPath)) {
            pendingChunkTranscriptions = Math.max(pendingChunkTranscriptions - 1, 0)
            if (recordingStopped && pendingChunkTranscriptions === 0 && currentSessionDir) {
              finalizeTranscriptFromChunks(currentSessionDir)
            }
            continue
          }
          handleTranscriptReady(outPath, text)
        } else if (obj.event === 'loaded') {
          console.log('[transcriber] loaded', obj.model)
        } else if (obj.event === 'progress') {
          console.log('[transcriber]', obj.msg)
          try {
            win?.webContents.send('transcription-status', { state: 'running', sessionDir: currentSessionDir, message: obj.msg || 'transcribing' })
          } catch (e) {
            console.error('failed to send transcription-status running', e)
          }
        } else if (obj.event === 'error') {
          console.error('[transcriber error]', obj.msg)
          try {
            win?.webContents.send('transcription-status', { state: 'error', sessionDir: currentSessionDir, message: obj.msg || 'transcription error' })
          } catch (e) {
            console.error('failed to send transcription-status error', e)
          }
        }
      } catch (e) {
        console.error('failed to parse transcriber stdout line', e, line)
      }
    }
  })
  else console.error('[transcriber] stdout not available')
  if (transcriberProcess.stderr) transcriberProcess.stderr.on('data', (d) => console.error('[transcriber err]', d.toString().trim()))
  else console.error('[transcriber] stderr not available')
  transcriberProcess.on('error', (err) => {
    console.error('[transcriber spawn error]', err)
    try {
      win?.webContents.send('transcription-status', { state: 'error', sessionDir: currentSessionDir, message: 'failed to start transcriber' })
    } catch (e) {
      console.error('failed to send transcription-status spawn error', e)
    }
  })
  transcriberProcess.on('exit', (code) => {
    console.log('[transcriber] exited', code)
    transcriberProcess = null
  })
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



async function startBackend() {
  if (backendProcess) {
    console.log('[backend] already running')
    return
  }

  const ready = await ensureDependencies()
  if (!ready) return

  recordStdoutBuf = ''
  pendingChunkTranscriptions = 0
  recordingStopped = false

  const sessionDir = makeSessionDir()
  currentSessionDir = sessionDir
  const outWav = path.join(sessionDir, 'audio.wav')
  console.log('[backend] sessionDir=', sessionDir)
  try {
    win?.webContents.send('session-started', { sessionDir })
  } catch (e) {
    console.error('failed to send session-started', e)
  }
  startSummarizerIfNeeded(resolveSummaryModelPath())

  const scriptPath = path.join(getBackendRoot(), 'record.py')

  const args: string[] = [scriptPath, '--out', outWav]
  const chunkSecs = getRecordChunkSecs()
  if (chunkSecs > 0) {
    args.push('--chunk-secs', String(chunkSecs))
  }

  startTranscriberIfNeeded(currentModelName)
  startSummarizerIfNeeded(resolveSummaryModelPath())

  backendProcess = spawn(getPythonCommand(), args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: getPythonEnv(),
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
  })
}

function stopBackend() {
  if (!backendProcess) {
    console.log('[backend] not running')
    return
  }

  backendProcess.kill('SIGTERM')
  backendProcess = null
  console.log('[backend] stop signal sent')
  // After stopping recording, kick off transcription for the session
  if (currentSessionDir) {
    const wavPath = path.join(currentSessionDir, 'audio.wav')
    const outPath = path.join(currentSessionDir, 'transcript.txt')

    recordingStopped = true
    const chunkSecs = getRecordChunkSecs()
    if (chunkSecs > 0 && transcriberProcess) {
      return
    }

    if (transcriberProcess) {
      try {
        try {
          win?.webContents.send('transcription-status', { state: 'starting', sessionDir: currentSessionDir, message: 'starting transcription' })
        } catch (e) {
          console.error('failed to send transcription-status starting', e)
        }
        sendProcessCommand(transcriberProcess, 'transcriber', JSON.stringify({ cmd: 'transcribe', wav: wavPath, out: outPath }) + '\n')
      } catch (e) {
        console.error('failed to send transcribe command to daemon', e)
      }
    } else {
      // Fallback: spawn a one-off transcribe if daemon isn't running
      const transScript = path.join(getBackendRoot(), 'transcribe.py')
      const model = currentModelName || 'small.en'
      try {
        win?.webContents.send('transcription-status', { state: 'starting', sessionDir: currentSessionDir, message: 'starting transcription' })
      } catch (e) {
        console.error('failed to send transcription-status starting', e)
      }
      const tproc = spawn(getPythonCommand(), [transScript, '--wav', wavPath, '--model', model, '--out', outPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getPythonEnv(),
      })
      let buf = ''
      tproc.stdout.on('data', (data) => {
        buf += data.toString()
        console.log('[transcribe]', data.toString().trim())
      })
      tproc.stderr.on('data', (data) => {
        console.error('[transcribe err]', data.toString().trim())
      })
      tproc.on('exit', (code) => {
        console.log('[transcribe] exited', code)
        let text = ''
        try {
          text = fs.readFileSync(outPath, 'utf-8')
        } catch (e) {
          text = buf
        }
        try {
          win?.webContents.send('transcript-ready', { sessionDir: currentSessionDir, transcriptPath: outPath, text })
        } catch (e) {
          console.error('failed to send transcript-ready', e)
        }
        try {
          const state = code === 0 ? 'done' : 'error'
          win?.webContents.send('transcription-status', { state, sessionDir: currentSessionDir, message: code === 0 ? 'transcription complete' : 'transcription failed' })
        } catch (e) {
          console.error('failed to send transcription-status exit', e)
        }
        currentSessionDir = null
      })
    }
  }
}

function pauseBackend() {
  if (!backendProcess) {
    console.log('[backend] not running')
    return
  }
  sendProcessCommand(backendProcess, 'recorder', 'pause\n')
}

function resumeBackend() {
  if (!backendProcess) {
    console.log('[backend] not running')
    return
  }
  sendProcessCommand(backendProcess, 'recorder', 'resume\n')
}


ipcMain.on('backend-start', (_evt, opts: { deviceIndex?: number; model?: string } = {}) => {
  void (async () => {
    console.log('[ipc] backend-start', opts)
    if (opts && opts.model) currentModelName = opts.model
    if (backendProcess) {
      console.log('[backend] already running')
      return
    }

    const ready = await ensureDependencies()
    if (!ready) return

    recordStdoutBuf = ''
    pendingChunkTranscriptions = 0
    recordingStopped = false

    const sessionDir = makeSessionDir()
    currentSessionDir = sessionDir
    const outWav = path.join(sessionDir, 'audio.wav')
    console.log('[backend] sessionDir=', sessionDir)
    try {
      win?.webContents.send('session-started', { sessionDir })
    } catch (e) {
      console.error('failed to send session-started', e)
    }

    const scriptPath = path.join(getBackendRoot(), 'record.py')

    const args: string[] = [scriptPath, '--out', outWav]
    if (opts && typeof opts.deviceIndex === 'number') {
      args.push('--device-index', String(opts.deviceIndex))
    }
    const chunkSecs = getRecordChunkSecs()
    if (chunkSecs > 0) {
      args.push('--chunk-secs', String(chunkSecs))
    }

    // Ensure transcriber is running and preloaded with the chosen model
    startTranscriberIfNeeded(currentModelName)
    startSummarizerIfNeeded(resolveSummaryModelPath())

    backendProcess = spawn(getPythonCommand(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getPythonEnv(),
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
    })
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
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => console.error('[devices err]', d.toString().trim()))
    p.on('exit', () => {
      try {
        const json = JSON.parse(out || '{}')
        resolve(json)
      } catch (e) {
        resolve({ error: 'failed to parse devices', raw: out })
      }
    })
  })
})


function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(process.env.VITE_PUBLIC!, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
    void ensureDependencies()
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.whenReady().then(() => {
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
  stopBackend()
  if (transcriberProcess) {
    try {
      transcriberProcess.kill('SIGTERM')
    } catch (e) {
      console.error('failed to kill transcriber', e)
    }
    transcriberProcess = null
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
