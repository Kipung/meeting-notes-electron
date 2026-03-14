#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const root = process.cwd()

const getArg = (name) => {
  const idx = args.indexOf(name)
  if (idx === -1) return null
  return args[idx + 1] || null
}

const force = args.includes('--force')
const whisperModel = getArg('--whisper-model') || process.env.WHISPER_MODEL || 'small.en'
const pythonBinArg = getArg('--python-bin') || process.env.MEETING_NOTES_PYTHON || null
const pythonHomeArg = getArg('--python-home') || null
const ffmpegArg = getArg('--ffmpeg') || process.env.FFMPEG_PATH || null
const ffmpegLibArg = getArg('--ffmpeg-lib') || process.env.FFMPEG_LIB_DIR || null

const defaultPythonBin = process.platform === 'win32' ? 'python' : 'python3'
const pythonBin = pythonBinArg || defaultPythonBin

const runPython = (code, env = undefined) => {
  const result = spawnSync(pythonBin, ['-c', code], {
    encoding: 'utf-8',
    env: env ? { ...process.env, ...env } : process.env,
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim()
    throw new Error(msg || `python exited with ${result.status}`)
  }
  return (result.stdout || '').trim()
}

const copyDir = (src, dest) => {
  fs.cpSync(src, dest, { recursive: true, dereference: true })
}

const dedupePaths = (paths) => {
  const seen = new Set()
  const unique = []
  for (const value of paths) {
    if (!value) continue
    const resolved = path.resolve(value)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    unique.push(resolved)
  }
  return unique
}

const findFileRecursive = (rootDir, targetName, maxDepth = 8) => {
  if (!fs.existsSync(rootDir)) return null
  const stack = [{ dir: rootDir, depth: 0 }]
  while (stack.length > 0) {
    const next = stack.pop()
    if (!next) break
    const { dir, depth } = next
    let entries = []
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

const ensureCleanDir = (dest) => {
  if (fs.existsSync(dest)) {
    if (!force) {
      throw new Error(`destination exists: ${dest} (use --force to overwrite)`)
    }
    fs.rmSync(dest, { recursive: true, force: true })
  }
}

const pythonInfoRaw = runPython('import sys, json; print(json.dumps({"prefix": sys.prefix, "version": sys.version.split()[0]}))')
const pythonInfo = JSON.parse(pythonInfoRaw)
const pythonHome = pythonHomeArg || pythonInfo.prefix

if (!pythonHome || !fs.existsSync(pythonHome)) {
  throw new Error(`python home not found: ${pythonHome || '(empty)'} (use --python-home)`)
}

const destPython = path.join(root, 'python')
ensureCleanDir(destPython)
copyDir(pythonHome, destPython)

const destPythonBin =
  process.platform === 'win32'
    ? path.join(destPython, 'python.exe')
    : path.join(destPython, 'bin', 'python3')

if (!fs.existsSync(destPythonBin)) {
  throw new Error(`python binary missing after copy: ${destPythonBin}`)
}

const whisperDir = path.join(root, 'models', 'whisper')
const whisperRepoIdDir = `models--Systran--faster-whisper-${whisperModel}`
const whisperCacheDir = path.join(whisperDir, whisperRepoIdDir)
fs.mkdirSync(whisperDir, { recursive: true })

if (!fs.existsSync(whisperCacheDir)) {
  const cacheCandidates = dedupePaths([
    process.env.WHISPER_ROOT,
    process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : null,
    process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, 'huggingface', 'hub') : null,
    path.join(os.homedir(), '.cache', 'huggingface', 'hub'),
    path.join(os.homedir(), 'Library', 'Caches', 'huggingface', 'hub'),
  ])

  let copied = false
  for (const dir of cacheCandidates) {
    const candidate = path.join(dir, whisperRepoIdDir)
    if (fs.existsSync(candidate)) {
      copyDir(candidate, whisperCacheDir)
      copied = true
      break
    }
  }

  if (!copied) {
    runPython(
      `
from faster_whisper import WhisperModel
import numpy as np

last_error = None
for compute_type in ("int8", "float32"):
    try:
        model = WhisperModel(${JSON.stringify(whisperModel)}, device="cpu", compute_type=compute_type, download_root=${JSON.stringify(whisperDir)})
        segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language="en", task="transcribe")
        for _ in segments:
            pass
        print("ok")
        break
    except Exception as exc:
        last_error = exc
else:
    raise SystemExit(str(last_error) if last_error else "failed to prepare faster-whisper model")
`
    )
  }
}

if (!fs.existsSync(whisperCacheDir)) {
  throw new Error(`faster-whisper model cache not found after preparation: ${whisperCacheDir}`)
}

const torchCacheDir = path.join(root, 'torch_cache')
fs.mkdirSync(torchCacheDir, { recursive: true })
runPython(
  `import torch; torch.hub.load("snakers4/silero-vad", "silero_vad", trust_repo=True, force_reload=False); print("ok")`,
  { TORCH_HOME: torchCacheDir }
)
const vadSource = findFileRecursive(torchCacheDir, 'silero_vad.onnx')
if (!vadSource) {
  throw new Error(`silero_vad.onnx not found under torch cache: ${torchCacheDir}`)
}
const modelsDir = path.join(root, 'models')
fs.mkdirSync(modelsDir, { recursive: true })
const vadDest = path.join(modelsDir, 'silero_vad.onnx')
fs.copyFileSync(vadSource, vadDest)

const resolveFfmpegPath = () => {
  if (ffmpegArg) return ffmpegArg
  if (process.platform === 'win32') {
    const result = spawnSync('where', ['ffmpeg'], { encoding: 'utf-8' })
    if (result.status === 0) {
      const first = (result.stdout || '').split(/\r?\n/).find(Boolean)
      if (first) return first.trim()
    }
    return null
  }
  const result = spawnSync('which', ['ffmpeg'], { encoding: 'utf-8' })
  if (result.status === 0) {
    const first = (result.stdout || '').split(/\r?\n/).find(Boolean)
    if (first) return first.trim()
  }
  return null
}

const ffmpegPath = resolveFfmpegPath()
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  throw new Error('ffmpeg not found on PATH; install it or pass --ffmpeg /path/to/ffmpeg')
}

const ffmpegDir = path.join(root, 'ffmpeg')
fs.mkdirSync(ffmpegDir, { recursive: true })
const ffmpegDest = process.platform === 'win32' ? path.join(ffmpegDir, 'ffmpeg.exe') : path.join(ffmpegDir, 'ffmpeg')
fs.copyFileSync(ffmpegPath, ffmpegDest)

const resolveFfmpegLibDir = () => {
  if (ffmpegLibArg) return ffmpegLibArg
  const binDir = path.dirname(ffmpegPath)
  const candidate = path.resolve(binDir, '..', 'lib')
  if (fs.existsSync(candidate)) return candidate
  return null
}

let libDest = null
if (process.platform === 'darwin' || process.platform === 'linux') {
  const ffmpegLibDir = resolveFfmpegLibDir()
  if (!ffmpegLibDir || !fs.existsSync(ffmpegLibDir)) {
    throw new Error('ffmpeg lib directory not found; pass --ffmpeg-lib /path/to/lib')
  }

  libDest = path.join(root, 'lib')
  fs.mkdirSync(libDest, { recursive: true })
  const libEntries = fs.readdirSync(ffmpegLibDir)
  for (const entry of libEntries) {
    if (!entry.endsWith('.dylib') && !entry.endsWith('.so')) continue
    const src = path.join(ffmpegLibDir, entry)
    const dest = path.join(libDest, entry)
    fs.copyFileSync(src, dest)
  }
} else if (process.platform === 'win32') {
  const binDir = path.dirname(ffmpegPath)
  const dlls = fs.readdirSync(binDir).filter((f) => f.toLowerCase().endsWith('.dll'))
  for (const entry of dlls) {
    const src = path.join(binDir, entry)
    const dest = path.join(ffmpegDir, entry)
    fs.copyFileSync(src, dest)
  }
}

console.log('Offline bundle prepared:')
console.log(`- python: ${destPython}`)
console.log(`- whisper root: ${whisperDir}`)
console.log(`- whisper cache: ${whisperCacheDir}`)
console.log(`- torch cache: ${torchCacheDir}`)
console.log(`- silero vad: ${vadDest}`)
console.log(`- ffmpeg: ${ffmpegDest}`)
if (libDest) {
  console.log(`- ffmpeg libs: ${libDest}`)
}
