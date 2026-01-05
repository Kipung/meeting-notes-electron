#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

if (process.env.SKIP_BUNDLE_CHECK === '1') {
  process.exit(0)
}

const expectedVersionRaw = process.env.EXPECTED_PYTHON_VERSION || '3.10,3.11'
const whisperModel = process.env.WHISPER_MODEL || 'small.en'

const pythonPath =
  process.platform === 'win32'
    ? path.join(root, 'python', 'python.exe')
    : path.join(root, 'python', 'bin', 'python3')

const errors = []

const parseMajorMinor = (value) => {
  const parts = value.split('.').map((v) => Number(v))
  if (parts.length < 2 || parts.some((v) => Number.isNaN(v))) return null
  return parts[0] * 100 + parts[1]
}

const isAllowedVersion = (majorMinor) => {
  const target = parseMajorMinor(majorMinor)
  if (target === null) return false
  const tokens = expectedVersionRaw.split(',').map((t) => t.trim()).filter(Boolean)
  if (tokens.length === 0) return true
  for (const token of tokens) {
    if (token.includes('-')) {
      const [start, end] = token.split('-').map((t) => t.trim())
      const startVal = parseMajorMinor(start)
      const endVal = parseMajorMinor(end)
      if (startVal !== null && endVal !== null && target >= startVal && target <= endVal) {
        return true
      }
      continue
    }
    if (token === majorMinor) return true
  }
  return false
}

if (!fs.existsSync(pythonPath)) {
  errors.push(`missing python runtime: ${pythonPath}`)
} else {
  const result = spawnSync(pythonPath, ['--version'], { encoding: 'utf-8' })
  const out = (result.stdout || result.stderr || '').trim()
  const match = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i)
  if (!match) {
    errors.push(`failed to read python version from: ${out || 'unknown output'}`)
  } else {
    const majorMinor = `${match[1]}.${match[2]}`
    if (!isAllowedVersion(majorMinor)) {
      errors.push(`python version ${majorMinor} does not match expected ${expectedVersionRaw}`)
    }
  }
}

const modelsDir = path.join(root, 'models')
if (!fs.existsSync(modelsDir)) {
  errors.push(`missing models directory: ${modelsDir}`)
} else {
  const ggufs = fs.readdirSync(modelsDir).filter((f) => f.toLowerCase().endsWith('.gguf'))
  if (ggufs.length === 0) {
    errors.push(`no .gguf model files found in ${modelsDir}`)
  }
}

const whisperDir = path.join(root, 'whisper')
const whisperFile = path.join(whisperDir, `${whisperModel}.pt`)
if (!fs.existsSync(whisperFile)) {
  errors.push(`missing whisper model file: ${whisperFile}`)
}

const ffmpegDir = path.join(root, 'ffmpeg')
const ffmpegBin =
  process.platform === 'win32'
    ? path.join(ffmpegDir, 'ffmpeg.exe')
    : path.join(ffmpegDir, 'ffmpeg')
if (!fs.existsSync(ffmpegBin)) {
  errors.push(`missing ffmpeg binary: ${ffmpegBin}`)
}

const libDir = path.join(root, 'lib')
if (!fs.existsSync(libDir)) {
  errors.push(`missing ffmpeg lib directory: ${libDir}`)
} else {
  const libEntries = fs.readdirSync(libDir)
  const hasAvDevice = libEntries.some((f) => f.startsWith('libavdevice') && (f.endsWith('.dylib') || f.endsWith('.so')))
  if (!hasAvDevice) {
    errors.push(`missing ffmpeg libs in ${libDir} (expected libavdevice*.dylib)`)
  }
}

if (errors.length > 0) {
  console.error('Offline bundle check failed:')
  for (const err of errors) {
    console.error(`- ${err}`)
  }
  process.exit(1)
}

console.log('Offline bundle check passed.')
