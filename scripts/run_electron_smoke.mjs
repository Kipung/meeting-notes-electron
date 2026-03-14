import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const cwd = process.cwd()
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-notes-smoke-'))
const resultsPath = path.join(smokeRoot, 'smoke-results.json')
const userDataPath = path.join(smokeRoot, 'user-data')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const bundledPythonPath =
  process.platform === 'win32'
    ? path.join(cwd, 'python', 'python.exe')
    : path.join(cwd, 'python', 'bin', 'python3')
const bundledFfmpegPath =
  process.platform === 'win32'
    ? path.join(cwd, 'ffmpeg', 'ffmpeg.exe')
    : path.join(cwd, 'ffmpeg', 'ffmpeg')
const bundledLibPath = path.join(cwd, 'lib')

function pickExistingPath(...candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return undefined
}

const env = {
  ...process.env,
  MEETING_NOTES_SMOKE_MODE: '1',
  MEETING_NOTES_SMOKE_RESULTS: resultsPath,
  MEETING_NOTES_SMOKE_DIR: smokeRoot,
  MEETING_NOTES_SMOKE_USER_DATA: userDataPath,
}

const pythonPath = pickExistingPath(process.env.MEETING_NOTES_PYTHON, bundledPythonPath)
if (pythonPath) {
  env.MEETING_NOTES_PYTHON = pythonPath
}

const ffmpegPath = pickExistingPath(process.env.FFMPEG_PATH, bundledFfmpegPath)
if (ffmpegPath) {
  env.FFMPEG_PATH = ffmpegPath
}

if (process.platform === 'darwin') {
  const dyldLibraryPath = process.env.DYLD_LIBRARY_PATH || pickExistingPath(bundledLibPath)
  if (dyldLibraryPath) {
    env.DYLD_LIBRARY_PATH = dyldLibraryPath
  }
}

if (process.platform === 'linux') {
  const ldLibraryPath = process.env.LD_LIBRARY_PATH || pickExistingPath(bundledLibPath)
  if (ldLibraryPath) {
    env.LD_LIBRARY_PATH = ldLibraryPath
  }
}

const child = spawn(pnpmCommand, ['dev'], {
  cwd,
  env,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdoutTail = ''
let stderrTail = ''

const appendTail = (prev, chunk) => {
  const next = `${prev}${chunk}`
  return next.slice(-12000)
}

child.stdout?.on('data', (chunk) => {
  stdoutTail = appendTail(stdoutTail, chunk.toString())
})

child.stderr?.on('data', (chunk) => {
  stderrTail = appendTail(stderrTail, chunk.toString())
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForResults(timeoutMs = 360000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(resultsPath)) {
      const result = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'))
      if (result && result.finishedAt) {
        return result
      }
    }
    if (child.exitCode !== null) {
      break
    }
    await sleep(500)
  }
  if (fs.existsSync(resultsPath)) {
    return JSON.parse(fs.readFileSync(resultsPath, 'utf-8'))
  }
  throw new Error('Timed out waiting for Electron smoke results.')
}

function killGroup() {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // ignore cleanup failures
    }
  }
}

try {
  const result = await waitForResults()
  console.log(`Smoke root: ${smokeRoot}`)
  console.log(`Smoke result: ${result.ok ? 'PASS' : 'FAIL'}`)
  for (const scenario of result.scenarios || []) {
    console.log(`Scenario: ${scenario.name}`)
    for (const check of scenario.checks || []) {
      console.log(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` :: ${check.detail}` : ''}`)
    }
    if (scenario.sessionDir) console.log(`  sessionDir: ${scenario.sessionDir}`)
    if (scenario.summaryExcerpt) console.log(`  summary: ${scenario.summaryExcerpt}`)
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    console.log('Errors:')
    for (const error of result.errors) console.log(error)
  }
  if (!result.ok) {
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  if (stdoutTail.trim()) {
    console.error('\nSTDOUT tail:\n' + stdoutTail.trim())
  }
  if (stderrTail.trim()) {
    console.error('\nSTDERR tail:\n' + stderrTail.trim())
  }
  process.exitCode = 1
} finally {
  killGroup()
}
