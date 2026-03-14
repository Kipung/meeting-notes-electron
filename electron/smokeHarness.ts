import fs from 'node:fs'
import path from 'node:path'

import type { App, BrowserWindow } from 'electron'

import type { SessionMetadataInput, SummarizerContextMetadata } from './sessionMetadata'
import type { SummaryCommandPayload } from './summaryOrchestrator'
import { SummaryOrchestrator } from './summaryOrchestrator'

type ProcessResult = { ok: boolean; error?: string }

type SmokeCheck = {
  name: string
  ok: boolean
  detail?: string
}

type SmokeScenarioResult = {
  name: string
  sessionDir?: string
  summaryPath?: string
  metadataPath?: string
  summaryExcerpt?: string
  checks: SmokeCheck[]
}

export type SmokeHarnessResult = {
  ok: boolean
  startedAt: string
  finishedAt?: string
  sessionsRoot?: string
  scenarios: SmokeScenarioResult[]
  errors: string[]
}

type SmokeHarnessDeps = {
  app: App
  win: BrowserWindow
  getSessionsRoot: () => string
  makeSessionDir: () => string
  getCurrentSessionDir: () => string | null
  setCurrentSessionDir: (sessionDir: string | null) => void
  applySessionMetadata: (input?: SessionMetadataInput | null, sessionDir?: string | null) => unknown
  ensureSummarizerRuntime: () => Promise<ProcessResult>
  summaryOrchestrator: SummaryOrchestrator
  buildSummaryContextForSession: (sessionDir: string) => SummarizerContextMetadata
  sendSummarizerCommand: (payload: SummaryCommandPayload) => boolean
}

const SMOKE_RESULTS_PATH = process.env['MEETING_NOTES_SMOKE_RESULTS']?.trim() || ''
const SMOKE_OUTPUT_ROOT = process.env['MEETING_NOTES_SMOKE_DIR']?.trim() || ''

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
  label: string,
  getter: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 120000,
  intervalMs = 250,
): Promise<T> {
  const started = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await getter()
    if (value) return value
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for ${label}`)
    }
    await sleep(intervalMs)
  }
}

function ensureSmokeDir(): string {
  const root = SMOKE_OUTPUT_ROOT || path.join(process.cwd(), '.tmp-smoke')
  fs.mkdirSync(root, { recursive: true })
  return root
}

function writeSmokeResult(result: SmokeHarnessResult): void {
  if (!SMOKE_RESULTS_PATH) return
  fs.mkdirSync(path.dirname(SMOKE_RESULTS_PATH), { recursive: true })
  fs.writeFileSync(SMOKE_RESULTS_PATH, JSON.stringify(result, null, 2), 'utf-8')
}

function excerpt(text: string, maxChars = 260): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 1)}...`
}

function buildManualTranscript(): string {
  const sections: string[] = []
  for (let i = 1; i <= 12; i += 1) {
    sections.push(
      `Coach: We reviewed the missing quizzes, unfinished labs, and tutoring times that still fit the class schedule before the next progress review ${i}.`,
    )
    sections.push(
      `Student: I agreed to attend two tutoring sessions this week, finish the correction packet before the next meeting, and send a short progress update after each checkpoint ${i}.`,
    )
  }
  return sections.join('\n')
}

function buildImportTranscript(): string {
  const sections: string[] = []
  for (let i = 1; i <= 8; i += 1) {
    sections.push(
      `Coach: We reviewed the missing appeal documents and the order they should be finished before the advising deadline ${i}.`,
    )
    sections.push(
      `Student: I said I can gather the remaining documents this week, email the office with a concise explanation, and check back after submission ${i}.`,
    )
  }
  return sections.join('\n')
}

function buildImportAudioTranscript(): string {
  const sections: string[] = []
  for (let i = 1; i <= 6; i += 1) {
    sections.push(
      `Coach: We reviewed the incomplete scholarship checklist, the remaining verification forms, and the follow-up email that needs to be sent before the office deadline ${i}.`,
    )
    sections.push(
      `Student: I agreed to finish the verification forms tonight, send the follow-up email tomorrow morning, and bring the remaining documents to the next advising appointment ${i}.`,
    )
  }
  return sections.join('\n')
}

function buildChunkTranscript(): string {
  const sections: string[] = []
  for (let i = 1; i <= 34; i += 1) {
    sections.push(
      `Coach: We reviewed the financial aid probation timeline, the remaining appeal paperwork, and the committee checkpoints that must be completed before the next review ${i}.`,
    )
    sections.push(
      `Student: I agreed to finish the appeal draft, gather supporting documents, and attend the scheduled check-in so the case stays on track before the committee review ${i}.`,
    )
  }
  return sections.join('\n')
}

async function runInRenderer<T>(win: BrowserWindow, source: string): Promise<T> {
  return (await win.webContents.executeJavaScript(source, true)) as T
}

async function waitForRendererReady(win: BrowserWindow): Promise<void> {
  await waitFor(
    'renderer form',
    () =>
      runInRenderer<boolean>(
        win,
        `(() => Boolean(window.backend && document.querySelector('.field--subject input') && document.querySelector('.output-panel__textarea')))()`,
      ),
    30000,
  )
}

async function setFieldValue(win: BrowserWindow, selector: string, value: string): Promise<void> {
  await runInRenderer(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing element for selector ${selector}');
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!desc || !desc.set) throw new Error('missing native value setter for ${selector}');
      desc.set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  )
}

async function setSessionMetadataFields(
  win: BrowserWindow,
  metadata: {
    modality: string
    subject: string
    studentId: string
    studentName: string
    coachInitials: string
  },
): Promise<void> {
  await setFieldValue(win, '.field--modality select', metadata.modality)
  await setFieldValue(win, '.field--subject input', metadata.subject)
  await setFieldValue(win, '.field--student-id input', metadata.studentId)
  await setFieldValue(win, '.field--student-name input', metadata.studentName)
  await setFieldValue(win, '.field--coach input', metadata.coachInitials)
}

async function clickButtonByText(win: BrowserWindow, label: string): Promise<void> {
  await runInRenderer(
    win,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent && el.textContent.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error('missing button ${label}');
      button.click();
      return true;
    })()`,
  )
}

function writeSilentWaveFile(filePath: string, durationMs = 400): void {
  const sampleRate = 16000
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = channels * (bitsPerSample / 8)
  const byteRate = sampleRate * blockAlign
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000))
  const dataSize = sampleCount * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  fs.writeFileSync(filePath, buffer)
}

async function setTranscriptTextarea(win: BrowserWindow, value: string): Promise<void> {
  await runInRenderer(
    win,
    `(() => {
      const el = document.querySelector('.output-panel__textarea');
      if (!(el instanceof HTMLTextAreaElement)) throw new Error('missing transcript textarea');
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (!desc || !desc.set) throw new Error('missing textarea setter');
      desc.set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value.length;
    })()`,
  )
}

async function isSummaryProgressVisible(win: BrowserWindow): Promise<boolean> {
  return runInRenderer<boolean>(win, `(() => Boolean(document.querySelector('.summary-progress')))()`)
}

async function getSummaryHeader(win: BrowserWindow): Promise<string> {
  return runInRenderer<string>(
    win,
    `(() => document.querySelector('.summary-display__meta-line')?.textContent?.trim() || '')()`,
  )
}

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
}

function addCheck(scenario: SmokeScenarioResult, name: string, ok: boolean, detail?: string): void {
  scenario.checks.push({ name, ok, detail })
}

function scenarioOk(scenario: SmokeScenarioResult): boolean {
  return scenario.checks.every((check) => check.ok)
}

async function runManualTranscriptScenario(deps: SmokeHarnessDeps): Promise<SmokeScenarioResult> {
  const scenario: SmokeScenarioResult = { name: 'manual-transcript', checks: [] }
  const manualSubject = 'CHEM 120 recovery plan'
  const initialMetadata = {
    modality: 'Virtual Appointment',
    subject: manualSubject,
    studentId: 'S123456',
    studentName: 'Alex Rivera',
    coachInitials: 'KL',
  }
  const updatedStudentId = 'S998877'
  const updatedCoach = 'KM'
  const transcript = buildManualTranscript()

  await setSessionMetadataFields(deps.win, initialMetadata)
  await setTranscriptTextarea(deps.win, transcript)
  await sleep(150)
  await clickButtonByText(deps.win, 'Summarize transcript text')

  const sessionDir = await waitFor('manual session dir', () => deps.getCurrentSessionDir(), 30000)
  const metadataPath = path.join(sessionDir, 'session_metadata.json')
  const summaryPath = path.join(sessionDir, 'summary.txt')
  scenario.sessionDir = sessionDir
  scenario.metadataPath = metadataPath
  scenario.summaryPath = summaryPath

  await waitFor('manual metadata file', () => (fs.existsSync(metadataPath) ? metadataPath : null), 15000)
  const initialMetadataJson = readJsonFile(metadataPath)
  addCheck(
    scenario,
    'initial metadata written',
    initialMetadataJson.subject === initialMetadata.subject && initialMetadataJson.student_name === initialMetadata.studentName,
    JSON.stringify(initialMetadataJson),
  )

  await waitFor('manual summary progress', () => isSummaryProgressVisible(deps.win).then((visible) => (visible ? true : null)), 45000)
  await setFieldValue(deps.win, '.field--student-id input', updatedStudentId)
  await setFieldValue(deps.win, '.field--coach input', updatedCoach)

  await waitFor(
    'updated manual metadata file',
    () => {
      if (!fs.existsSync(metadataPath)) return null
      const metadataJson = readJsonFile(metadataPath)
      return metadataJson.student_id === updatedStudentId && metadataJson.coach_initials === updatedCoach ? metadataJson : null
    },
    30000,
  )
  addCheck(scenario, 'metadata updates while summarizing', true, `coach=${updatedCoach}, student_id=${updatedStudentId}`)

  await waitFor(
    'manual summary file',
    () => {
      if (!fs.existsSync(summaryPath)) return null
      const text = fs.readFileSync(summaryPath, 'utf-8').trim()
      return text ? text : null
    },
    240000,
  )

  const summaryText = fs.readFileSync(summaryPath, 'utf-8')
  scenario.summaryExcerpt = excerpt(summaryText)
  addCheck(
    scenario,
    'summary uses metadata context',
    /chem 120|alex rivera/i.test(summaryText),
    excerpt(summaryText),
  )
  addCheck(
    scenario,
    'summary does not leak student id',
    !summaryText.includes(updatedStudentId) && !summaryText.includes(initialMetadata.studentId),
    excerpt(summaryText),
  )

  const summaryHeader = await getSummaryHeader(deps.win)
  addCheck(
    scenario,
    'renderer header reflects latest metadata',
    summaryHeader.includes(manualSubject) && summaryHeader.includes(updatedCoach),
    summaryHeader,
  )

  return scenario
}

async function runImportTranscriptScenario(deps: SmokeHarnessDeps, smokeDir: string): Promise<SmokeScenarioResult> {
  const scenario: SmokeScenarioResult = { name: 'import-transcript', checks: [] }
  const transcriptPath = path.join(smokeDir, 'import-transcript.txt')
  const transcript = buildImportTranscript()
  fs.writeFileSync(transcriptPath, transcript, 'utf-8')

  const metadata = {
    modality: 'Phone Appointment',
    subject: 'SAP appeal follow-up',
    studentId: 'B112233',
    studentName: 'Jordan Lee',
    coachInitials: 'TR',
  }
  await setSessionMetadataFields(deps.win, metadata)
  const previousSessionDir = deps.getCurrentSessionDir()
  const result = await runInRenderer<{ ok?: boolean; error?: string }>(
    deps.win,
    `window.backend.processInputPath({
      inputPath: ${JSON.stringify(transcriptPath)},
      metadata: ${JSON.stringify(metadata)}
    })`,
  )
  if (!result?.ok) {
    throw new Error(result?.error || 'processInputPath failed in smoke harness')
  }

  const sessionDir = await waitFor(
    'import session dir',
    () => {
      const current = deps.getCurrentSessionDir()
      return current && current !== previousSessionDir ? current : null
    },
    30000,
  )
  const metadataPath = path.join(sessionDir, 'session_metadata.json')
  const summaryPath = path.join(sessionDir, 'summary.txt')
  scenario.sessionDir = sessionDir
  scenario.metadataPath = metadataPath
  scenario.summaryPath = summaryPath

  await waitFor('import metadata file', () => (fs.existsSync(metadataPath) ? metadataPath : null), 15000)
  const metadataJson = readJsonFile(metadataPath)
  addCheck(
    scenario,
    'import metadata persisted',
    metadataJson.subject === metadata.subject && metadataJson.student_name === metadata.studentName,
    JSON.stringify(metadataJson),
  )

  await waitFor(
    'import summary file',
    () => {
      if (!fs.existsSync(summaryPath)) return null
      const text = fs.readFileSync(summaryPath, 'utf-8').trim()
      return text ? text : null
    },
    240000,
  )
  const summaryText = fs.readFileSync(summaryPath, 'utf-8')
  scenario.summaryExcerpt = excerpt(summaryText)
  addCheck(scenario, 'import summary generated', summaryText.length > 0, excerpt(summaryText))

  return scenario
}

async function runImportAudioScenario(deps: SmokeHarnessDeps, smokeDir: string): Promise<SmokeScenarioResult> {
  const scenario: SmokeScenarioResult = { name: 'import-audio', checks: [] }
  const audioPath = path.join(smokeDir, 'import-audio.wav')
  const smokeTranscript = buildImportAudioTranscript()
  process.env.MEETING_NOTES_SMOKE_TRANSCRIPT_TEXT = smokeTranscript
  writeSilentWaveFile(audioPath)

  const metadata = {
    modality: 'Virtual Appointment',
    subject: 'Scholarship verification follow-up',
    studentId: 'D778899',
    studentName: 'Taylor Brooks',
    coachInitials: 'AV',
  }
  await setSessionMetadataFields(deps.win, metadata)
  const previousSessionDir = deps.getCurrentSessionDir()
  const result = await runInRenderer<{ ok?: boolean; error?: string }>(
    deps.win,
    `window.backend.processInputPath({
      inputPath: ${JSON.stringify(audioPath)},
      metadata: ${JSON.stringify(metadata)}
    })`,
  )
  if (!result?.ok) {
    throw new Error(result?.error || 'processInputPath for audio failed in smoke harness')
  }

  const sessionDir = await waitFor(
    'import audio session dir',
    () => {
      const current = deps.getCurrentSessionDir()
      return current && current !== previousSessionDir ? current : null
    },
    30000,
  )
  const metadataPath = path.join(sessionDir, 'session_metadata.json')
  const transcriptPath = path.join(sessionDir, 'transcript.txt')
  const summaryPath = path.join(sessionDir, 'summary.txt')
  const copiedAudioPath = path.join(sessionDir, path.basename(audioPath))
  scenario.sessionDir = sessionDir
  scenario.metadataPath = metadataPath
  scenario.summaryPath = summaryPath

  await waitFor('import audio metadata file', () => (fs.existsSync(metadataPath) ? metadataPath : null), 15000)
  const metadataJson = readJsonFile(metadataPath)
  addCheck(
    scenario,
    'audio import metadata persisted',
    metadataJson.modality === metadata.modality &&
      metadataJson.subject === metadata.subject &&
      metadataJson.student_name === metadata.studentName,
    JSON.stringify(metadataJson),
  )

  await waitFor(
    'import audio transcript file',
    () => {
      if (!fs.existsSync(transcriptPath)) return null
      const text = fs.readFileSync(transcriptPath, 'utf-8').trim()
      return text ? text : null
    },
    60000,
  )
  const transcriptText = fs.readFileSync(transcriptPath, 'utf-8').trim()
  addCheck(
    scenario,
    'audio import transcript written from smoke path',
    transcriptText === smokeTranscript,
    excerpt(transcriptText),
  )
  addCheck(scenario, 'audio file copied into session', fs.existsSync(copiedAudioPath), copiedAudioPath)

  await waitFor(
    'import audio summary file',
    () => {
      if (!fs.existsSync(summaryPath)) return null
      const text = fs.readFileSync(summaryPath, 'utf-8').trim()
      return text ? text : null
    },
    240000,
  )
  const summaryText = fs.readFileSync(summaryPath, 'utf-8')
  scenario.summaryExcerpt = excerpt(summaryText)
  addCheck(scenario, 'audio import summary generated', summaryText.length > 0, excerpt(summaryText))
  addCheck(
    scenario,
    'audio import summary does not leak student id',
    !summaryText.includes(metadata.studentId) && !/student id\b/i.test(summaryText),
    excerpt(summaryText),
  )

  return scenario
}

async function runChunkPipelineScenario(deps: SmokeHarnessDeps): Promise<SmokeScenarioResult> {
  const scenario: SmokeScenarioResult = { name: 'chunk-pipeline', checks: [] }
  const ready = await deps.ensureSummarizerRuntime()
  if (!ready.ok) {
    throw new Error(ready.error || 'failed to prepare summarizer runtime')
  }

  const metadata = {
    modality: 'Virtual Office Hour',
    subject: 'Financial aid probation review',
    studentId: 'C445566',
    studentName: 'Morgan Patel',
    coachInitials: 'RS',
  }
  await setSessionMetadataFields(deps.win, metadata)
  await sleep(150)

  const sessionDir = deps.makeSessionDir()
  deps.setCurrentSessionDir(sessionDir)
  deps.summaryOrchestrator.startSession(sessionDir)
  deps.applySessionMetadata(metadata, sessionDir)

  const transcript = buildChunkTranscript()
  const words = transcript.split(/\s+/)
  const first = words.slice(0, 980).join(' ')
  const second = words.slice(0, 1960).join(' ')
  const full = words.join(' ')
  scenario.sessionDir = sessionDir
  scenario.metadataPath = path.join(sessionDir, 'session_metadata.json')
  scenario.summaryPath = path.join(sessionDir, 'summary.txt')

  const chunkMetadata = await waitFor(
    'chunk metadata file',
    () => {
      if (!scenario.metadataPath || !fs.existsSync(scenario.metadataPath)) return null
      const metadataJson = readJsonFile(scenario.metadataPath)
      return metadataJson.subject === metadata.subject && metadataJson.student_name === metadata.studentName ? metadataJson : null
    },
    15000,
  )
  addCheck(scenario, 'chunk metadata persisted', true, JSON.stringify(chunkMetadata))

  const args = {
    currentSessionDir: sessionDir,
    buildSummaryContext: deps.buildSummaryContextForSession,
    sendCommand: deps.sendSummarizerCommand,
    logError: console.error,
  }

  deps.summaryOrchestrator.processTranscriptPartialText(first, args)
  deps.summaryOrchestrator.processTranscriptPartialText(second, args)

  try {
    await waitFor(
      'chunk summaries to accumulate',
      () => {
        const snapshot = deps.summaryOrchestrator.getDebugSnapshot()
        return snapshot.chunkSummaryCount >= 1 ? snapshot : null
      },
      180000,
    )
  } catch (error) {
    throw new Error(
      `chunk summaries did not accumulate: ${
        error instanceof Error ? error.message : String(error)
      }; snapshot=${JSON.stringify(deps.summaryOrchestrator.getDebugSnapshot())}`,
    )
  }
  addCheck(
    scenario,
    'chunk summaries were collected',
    deps.summaryOrchestrator.getDebugSnapshot().chunkSummaryCount >= 1,
    JSON.stringify(deps.summaryOrchestrator.getDebugSnapshot()),
  )

  deps.summaryOrchestrator.requestFinalSummary(full, args)
  try {
    await waitFor(
      'chunk final summary file',
      () => {
        if (!scenario.summaryPath || !fs.existsSync(scenario.summaryPath)) return null
        const text = fs.readFileSync(scenario.summaryPath, 'utf-8').trim()
        return text ? text : null
      },
      240000,
    )
  } catch (error) {
    throw new Error(
      `chunk final summary did not complete: ${
        error instanceof Error ? error.message : String(error)
      }; snapshot=${JSON.stringify(deps.summaryOrchestrator.getDebugSnapshot())}`,
    )
  }
  const summaryText = fs.readFileSync(scenario.summaryPath, 'utf-8')
  scenario.summaryExcerpt = excerpt(summaryText)
  addCheck(scenario, 'chunk pipeline produced final summary', summaryText.length > 0, excerpt(summaryText))

  return scenario
}

export async function runSmokeHarness(deps: SmokeHarnessDeps): Promise<SmokeHarnessResult> {
  const result: SmokeHarnessResult = {
    ok: false,
    startedAt: new Date().toISOString(),
    sessionsRoot: deps.getSessionsRoot(),
    scenarios: [],
    errors: [],
  }

  try {
    ensureSmokeDir()
    await waitForRendererReady(deps.win)

    const manual = await runManualTranscriptScenario(deps)
    result.scenarios.push(manual)
    writeSmokeResult(result)

    const imported = await runImportTranscriptScenario(deps, ensureSmokeDir())
    result.scenarios.push(imported)
    writeSmokeResult(result)

    const importedAudio = await runImportAudioScenario(deps, ensureSmokeDir())
    result.scenarios.push(importedAudio)
    writeSmokeResult(result)

    const chunk = await runChunkPipelineScenario(deps)
    result.scenarios.push(chunk)
    writeSmokeResult(result)

    result.ok = result.scenarios.every(scenarioOk)
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    result.errors.push(message)
    result.ok = false
  } finally {
    result.finishedAt = new Date().toISOString()
    writeSmokeResult(result)
    // Give the results file a moment to flush before the app exits.
    await sleep(300)
    deps.app.exit(result.ok ? 0 : 1)
  }

  return result
}
