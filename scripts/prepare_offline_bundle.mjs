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

const runPython = (code) => {
  const result = spawnSync(pythonBin, ['-c', code], { encoding: 'utf-8' })
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

const whisperDir = path.join(root, 'whisper')
const whisperDest = path.join(whisperDir, `${whisperModel}.pt`)
fs.mkdirSync(whisperDir, { recursive: true })

if (!fs.existsSync(whisperDest)) {
  const cacheCandidates = [
    process.env.WHISPER_ROOT,
    path.join(os.homedir(), 'Library', 'Caches', 'whisper'),
    path.join(os.homedir(), '.cache', 'whisper'),
  ].filter(Boolean)

  let copied = false
  for (const dir of cacheCandidates) {
    const candidate = path.join(dir, `${whisperModel}.pt`)
    if (fs.existsSync(candidate)) {
      fs.copyFileSync(candidate, whisperDest)
      copied = true
      break
    }
  }

  if (!copied) {
    runPython(
      `import whisper; whisper.load_model("${whisperModel}", download_root=r"${whisperDir.replace(/\\/g, '\\\\')}"); print("ok")`
    )
  }
}

if (!fs.existsSync(whisperDest)) {
  throw new Error(`whisper model not found after preparation: ${whisperDest}`)
}

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
console.log(`- whisper: ${whisperDest}`)
console.log(`- ffmpeg: ${ffmpegDest}`)
if (libDest) {
  console.log(`- ffmpeg libs: ${libDest}`)
}
