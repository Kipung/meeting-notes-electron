import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { App } from 'electron'

import { downloadFile, verifyFileSha256 } from './utils/fileDownloader'
import { makeJsonLineParser } from './utils/lineParser'

type BootstrapStatusState = 'running' | 'done' | 'error'

type RuntimeSupportOptions = {
  app: App
  getUserDataRoot: () => string
  sendBootstrapStatus: (state: BootstrapStatusState, message: string, percent?: number) => void
  preferredSummaryModelNames: string[]
  defaultSummaryModelName: string
  defaultSileroVadUrl: string
}

export function createRuntimeSupport(options: RuntimeSupportOptions) {
  const {
    app,
    getUserDataRoot,
    sendBootstrapStatus,
    preferredSummaryModelNames,
    defaultSummaryModelName,
    defaultSileroVadUrl,
  } = options

  // SHA256 for the pinned silero_vad.onnx v6.2.1
  const SILERO_VAD_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'

  let setupState: 'idle' | 'running' | 'done' | 'error' = 'idle'
  let setupPromise: Promise<boolean> | null = null
  let downloadedSummaryModelPath: string | null = null
  let resolvedVadModelPath: string | null = null

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

  function getDevBundledLibDir(): string {
    return path.join(process.env.APP_ROOT!, 'lib')
  }

  function getTorchCacheRoot(): string {
    return path.join(getUserDataRoot(), 'torch_cache')
  }

  function getPackagedTorchCacheRoot(): string {
    return path.join(process.resourcesPath, 'torch_cache')
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

  function dedupePaths(paths: Array<string | undefined | null>): string[] {
    const seen = new Set<string>()
    const unique: string[] = []
    for (const maybePath of paths) {
      if (!maybePath) continue
      const value = maybePath.trim()
      if (!value) continue
      const resolved = path.resolve(value)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      unique.push(resolved)
    }
    return unique
  }

  function findFileRecursive(rootDir: string, targetName: string, maxDepth = 8): string | null {
    if (!fs.existsSync(rootDir)) return null
    const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]
    while (stack.length > 0) {
      const next = stack.pop()
      if (!next) break
      const { dir, depth } = next
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isFile() && entry.name === targetName) return fullPath
        if (entry.isDirectory() && depth < maxDepth) {
          stack.push({ dir: fullPath, depth: depth + 1 })
        }
      }
    }
    return null
  }

  function materializeSileroVadFromCache(targetPath: string): boolean {
    const cacheRoots = dedupePaths([
      process.env['TORCH_HOME'],
      getTorchCacheRoot(),
      getPackagedTorchCacheRoot(),
      path.join(process.env.APP_ROOT!, 'torch_cache'),
    ])
    for (const root of cacheRoots) {
      const found = findFileRecursive(root, 'silero_vad.onnx')
      if (!found) continue
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        fs.copyFileSync(found, targetPath)
        return true
      } catch (error) {
        console.error('failed to copy silero_vad.onnx from torch cache', found, error)
      }
    }
    return false
  }

  function getFfmpegPathFromDir(dir: string): string {
    return process.platform === 'win32' ? path.join(dir, 'ffmpeg.exe') : path.join(dir, 'ffmpeg')
  }

  function isExecutableFile(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false
      if (process.platform === 'win32') return true
      fs.accessSync(filePath, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  function getPathDirectories(): string[] {
    const rawPath = process.env['PATH'] || ''
    return rawPath
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  function getLikelyFfmpegDirectories(): string[] {
    const venv = process.env['VIRTUAL_ENV']?.trim()
    const conda = process.env['CONDA_PREFIX']?.trim()
    const envDirs =
      process.platform === 'win32'
        ? [venv ? path.join(venv, 'Scripts') : null, conda || null]
        : [venv ? path.join(venv, 'bin') : null, conda ? path.join(conda, 'bin') : null]

    const platformDirs =
      process.platform === 'darwin'
        ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']
        : process.platform === 'linux'
          ? ['/usr/local/bin', '/usr/bin', '/snap/bin']
          : []

    return dedupePaths([...envDirs, ...getPathDirectories(), ...platformDirs])
  }

  function resolveFfmpegLibDir(): string | null {
    const override = process.env['FFMPEG_LIB_DIR']
    if (override && override.trim() && fs.existsSync(override)) return override

    const packaged = getPackagedLibDir()
    if (fs.existsSync(packaged)) return packaged

    const devBundled = getDevBundledLibDir()
    if (fs.existsSync(devBundled)) return devBundled

    return null
  }

  function resolveFfmpegPath(): string | null {
    const override = process.env['FFMPEG_PATH']
    if (override && override.trim() && isExecutableFile(override)) return override

    const packaged = getFfmpegPathFromDir(getPackagedFfmpegDir())
    if (isExecutableFile(packaged)) return packaged

    const devBundled = getFfmpegPathFromDir(path.join(process.env.APP_ROOT!, 'ffmpeg'))
    if (isExecutableFile(devBundled)) return devBundled

    for (const dir of getLikelyFfmpegDirectories()) {
      const candidate = getFfmpegPathFromDir(dir)
      if (isExecutableFile(candidate)) return candidate
    }

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
    } catch (error) {
      console.error('failed to seed torch cache', error)
    }
    return userCache
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
      const libDir = resolveFfmpegLibDir()
      if (libDir && fs.existsSync(libDir)) {
        env.DYLD_LIBRARY_PATH = [libDir, env.DYLD_LIBRARY_PATH || ''].filter(Boolean).join(path.delimiter)
      }
    }
    if (process.platform === 'linux') {
      const libDir = resolveFfmpegLibDir()
      if (libDir && fs.existsSync(libDir)) {
        env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH || ''].filter(Boolean).join(path.delimiter)
      }
    }
    env.GGML_LOG_LEVEL = env.GGML_LOG_LEVEL || '0'
    env.LLAMA_CPP_LOG_LEVEL = env.LLAMA_CPP_LOG_LEVEL || '0'
    // Prevent HuggingFace/transformers from making unexpected network calls at runtime.
    // These are deleted in runSetupScript so the initial download can still happen.
    env.HF_HUB_OFFLINE = '1'
    env.TRANSFORMERS_OFFLINE = '1'
    return env
  }

  async function verifyPythonCommand(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`python exited with ${code}`))
      })
    })
  }

  async function verifyFfmpegAvailable(): Promise<void> {
    const ffmpegPath = resolveFfmpegPath()
    if (ffmpegPath) return
    const installHint =
      process.platform === 'darwin'
        ? 'Install ffmpeg with `brew install ffmpeg` or set FFMPEG_PATH.'
        : process.platform === 'win32'
          ? 'Install ffmpeg with `winget install Gyan.FFmpeg` or set FFMPEG_PATH.'
          : 'Install ffmpeg with your package manager or set FFMPEG_PATH.'

    if (app.isPackaged) {
      throw new Error(`ffmpeg missing in installer. ${installHint}`)
    }

    throw new Error(`ffmpeg not found. ${installHint}`)
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
      const env: NodeJS.ProcessEnv = {
        ...getPythonEnv(),
        WHISPER_MODEL: whisperModel,
        WHISPER_DIR: whisperDir,
      }
      // Allow network access during setup so HuggingFace downloads can proceed
      delete env.HF_HUB_OFFLINE
      delete env.TRANSFORMERS_OFFLINE
      if (resolvedVadModelPath) env.SILERO_VAD_MODEL = resolvedVadModelPath
      const proc = spawn(getPythonCommand(), [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
      proc.stdout?.on('data', makeJsonLineParser<{ event?: string; message?: string }>((obj) => {
        if (obj.event === 'status') {
          sendBootstrapStatus('running', obj.message || 'running setup')
        } else if (obj.event === 'done') {
          sendBootstrapStatus('running', obj.message || 'setup complete')
        } else if (obj.event === 'error') {
          sendBootstrapStatus('error', obj.message || 'setup failed')
        }
      }))
      proc.stderr?.on('data', (data) => console.error('[setup err]', data.toString().trim()))
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`setup failed with code ${code}`))
      })
    })
  }

  async function ensureWhisperModel(): Promise<void> {
    const model = process.env['WHISPER_MODEL'] || 'medium.en'
    const whisperDir = getWhisperRoot()
    const repoIdDir = `models--Systran--faster-whisper-${model}`
    const localCacheDir = path.join(whisperDir, repoIdDir)
    if (fs.existsSync(localCacheDir)) return

    fs.mkdirSync(whisperDir, { recursive: true })
    await runSetupScript(model, whisperDir)
  }

  async function ensureVadModel(): Promise<string> {
    const override = process.env['SILERO_VAD_MODEL']?.trim()
    if (override) {
      if (!fs.existsSync(override)) {
        throw new Error(`SILERO_VAD_MODEL not found at ${override}`)
      }
      return override
    }

    const existingPath = getSileroVadModelPath()
    if (fs.existsSync(existingPath)) {
      return existingPath
    }

    const targetPath = path.join(getModelsRoot(), 'silero_vad.onnx')
    if (materializeSileroVadFromCache(targetPath)) {
      return targetPath
    }

    if (app.isPackaged) {
      throw new Error(`silero VAD model missing in installer: ${targetPath}`)
    }

    const url = process.env['SILERO_VAD_URL']?.trim() || defaultSileroVadUrl
    sendBootstrapStatus('running', 'downloading VAD model', 0)
    await downloadFile(url, targetPath, (progress) => {
      if (typeof progress.percent === 'number') {
        sendBootstrapStatus('running', 'downloading VAD model', progress.percent)
      }
    })
    // Only verify if using the default pinned URL (custom overrides may have different hashes)
    if (!process.env['SILERO_VAD_URL']?.trim()) {
      await verifyFileSha256(targetPath, SILERO_VAD_SHA256)
    }
    return targetPath
  }

  function resolveSummaryModelPath(): string | null {
    const override = process.env['SUMMODEL']
    if (override && override.trim()) return override
    if (downloadedSummaryModelPath && fs.existsSync(downloadedSummaryModelPath)) return downloadedSummaryModelPath

    const bundledCandidates = [
      getModelsRoot(),
      getPackagedModelsRoot(),
      path.join(process.env.APP_ROOT!, 'models'),
    ].flatMap((modelsDir) => preferredSummaryModelNames.map((modelName) => path.join(modelsDir, modelName)))
    for (const candidate of bundledCandidates) {
      if (fs.existsSync(candidate)) return candidate
    }

    const candidates = [getModelsRoot(), getPackagedModelsRoot(), path.join(process.env.APP_ROOT!, 'models')]
    for (const modelsDir of candidates) {
      if (!fs.existsSync(modelsDir)) continue
      for (const modelName of preferredSummaryModelNames) {
        const preferred = path.join(modelsDir, modelName)
        if (fs.existsSync(preferred)) return preferred
      }
      try {
        const entries = fs.readdirSync(modelsDir, { withFileTypes: true })
        const ggufs = entries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
          .map((entry) => path.join(modelsDir, entry.name))
          .sort()
        if (ggufs.length > 0) return ggufs[0]
      } catch (error) {
        console.error('failed to scan models directory', error)
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
        `summary model missing; place ${defaultSummaryModelName} under ${path.join(process.env.APP_ROOT!, 'models')} or set SUMMODEL_URL to download it`,
      )
    }

    const modelsDir = getModelsRoot()
    let targetName = defaultSummaryModelName
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
        resolvedVadModelPath = await ensureVadModel()
        await ensureWhisperModel()
        await ensureSummaryModel()
        setupState = 'done'
        sendBootstrapStatus('done', 'ready', 100)
        return true
      } catch (error) {
        resolvedVadModelPath = null
        setupState = 'error'
        const msg = error instanceof Error ? error.message : 'setup failed'
        sendBootstrapStatus('error', msg)
        return false
      } finally {
        setupPromise = null
      }
    })()
    return setupPromise
  }

  return {
    getBackendRoot,
    getModelsRoot,
    getPythonCommand,
    getPythonEnv,
    getResolvedVadModelPath: () => resolvedVadModelPath,
    getSileroVadModelPath,
    getUserPythonPath,
    getWhisperRoot,
    ensureDependencies,
    ensurePythonRuntime,
    ensureSummaryModel,
    resolveSummaryModelPath,
  }
}
