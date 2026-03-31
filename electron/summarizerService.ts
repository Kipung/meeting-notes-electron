import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { makeJsonLineParser } from './utils/lineParser'

import type { SummarizerContextMetadata } from './sessionMetadata'
import type { SummaryCommandPayload, SummarizerContext } from './summaryOrchestrator'
import { SummaryOrchestrator } from './summaryOrchestrator'

export type ProcessResult = {
  ok: boolean
  error?: string
}

export type FollowUpResult = {
  ok: boolean
  text?: string
  error?: string
}

type RendererEventSender = (channel: string, payload: unknown, errorLabel: string) => void

type SummarizerEvent = {
  event?: string
  text?: string
  msg?: string
  out?: string | null
  id?: string
  context?: SummarizerContext
}

type FollowUpRequest = {
  resolve: (value: FollowUpResult) => void
  timeout: NodeJS.Timeout
}

type CreateSummarizerServiceOptions = {
  getBackendRoot: () => string
  getPythonCommand: () => string
  getPythonEnv: () => NodeJS.ProcessEnv
  ensurePythonRuntime: () => Promise<void>
  ensureSummaryModel: () => Promise<string | null>
  resolveSummaryModelPath: () => string | null
  summaryOrchestrator: SummaryOrchestrator
  buildSummaryContextForSession: (sessionDir: string) => SummarizerContextMetadata
  getCurrentSessionDir: () => string | null
  sendToRenderer: RendererEventSender
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export function createSummarizerService(options: CreateSummarizerServiceOptions) {
  const log = options.log || console

  let summarizerProcess: ReturnType<typeof spawn> | null = null
  let currentSummaryModelPath: string | null = null
  const followUpRequests = new Map<string, FollowUpRequest>()

  function writeToProcess(payload: string): boolean {
    if (!summarizerProcess?.stdin) {
      log.error('[summarizer] stdin not available')
      return false
    }
    try {
      summarizerProcess.stdin.write(payload)
      return true
    } catch (error) {
      log.error('[summarizer] failed to write to stdin', error)
      return false
    }
  }

  function buildSummaryArgs() {
    return {
      currentSessionDir: options.getCurrentSessionDir(),
      buildSummaryContext: options.buildSummaryContextForSession,
      sendCommand,
      logError: log.error,
    }
  }

  function sendCommand(payload: SummaryCommandPayload): boolean {
    return writeToProcess(JSON.stringify(payload) + '\n')
  }

  function failPendingFollowUps(error: string): void {
    for (const [id, request] of followUpRequests.entries()) {
      clearTimeout(request.timeout)
      request.resolve({ ok: false, error })
      followUpRequests.delete(id)
    }
  }

  function handleParsedEvent(obj: SummarizerEvent): void {
    const context = obj.context
    const contextSessionDir = context?.sessionDir ?? null

    if (context?.type === 'chunk') {
      options.summaryOrchestrator.handleChunkSummarizerEvent(obj, context, buildSummaryArgs())
      return
    }

    const isFinalContext = context?.type === 'final'
    if (isFinalContext && !options.summaryOrchestrator.shouldHandleFinalEvent(contextSessionDir)) {
      return
    }

    const summarySessionDir = options.summaryOrchestrator.resolveFinalEventSession(
      contextSessionDir,
      options.getCurrentSessionDir(),
    )

    if (isFinalContext && (obj.event === 'done' || obj.event === 'error')) {
      options.summaryOrchestrator.markFinalSummaryFinished()
    }

    if (obj.event === 'summary_start') {
      options.sendToRenderer(
        'summary-stream',
        { sessionDir: summarySessionDir, reset: true },
        'failed to send summary-stream reset',
      )
      return
    }

    if (obj.event === 'summary_delta') {
      const delta = obj.text || ''
      if (!delta) return
      options.sendToRenderer(
        'summary-stream',
        { sessionDir: summarySessionDir, delta },
        'failed to send summary-stream delta',
      )
      return
    }

    if (obj.event === 'done') {
      options.sendToRenderer(
        'summary-ready',
        { sessionDir: summarySessionDir, summaryPath: obj.out, text: obj.text || '' },
        'failed to send summary-ready',
      )
      options.sendToRenderer(
        'summary-status',
        { state: 'done', sessionDir: summarySessionDir, message: 'summary complete' },
        'failed to send summary-status done',
      )
      if (isFinalContext) {
        options.summaryOrchestrator.clearPendingFinalSummarySession()
      }
      return
    }

    if (obj.event === 'progress') {
      if (context?.type !== 'final') return
      options.sendToRenderer(
        'summary-status',
        { state: 'running', sessionDir: summarySessionDir, message: obj.msg || 'summarizing' },
        'failed to send summary-status running',
      )
      return
    }

    if (obj.event === 'error') {
      log.error('[summarizer error]', obj.msg)
      options.sendToRenderer(
        'summary-status',
        { state: 'error', sessionDir: summarySessionDir, message: obj.msg || 'summary error' },
        'failed to send summary-status error',
      )
      if (isFinalContext) {
        options.summaryOrchestrator.clearPendingFinalSummarySession()
      }
      return
    }

    if (obj.event === 'followup_done') {
      const request = obj.id ? followUpRequests.get(obj.id) : null
      if (!request) {
        log.warn('[summarizer] follow-up done with no request id', obj.id)
        return
      }
      clearTimeout(request.timeout)
      request.resolve({ ok: true, text: obj.text || '' })
      followUpRequests.delete(obj.id!)
      return
    }

    if (obj.event === 'followup_error') {
      const request = obj.id ? followUpRequests.get(obj.id) : null
      if (!request) {
        log.warn('[summarizer] follow-up error with no request id', obj.id, obj.msg)
        return
      }
      clearTimeout(request.timeout)
      request.resolve({ ok: false, error: obj.msg || 'follow-up error' })
      followUpRequests.delete(obj.id!)
    }
  }

  function startIfNeeded(modelPath: string | null): void {
    if (!modelPath) {
      log.error('summary model path not set')
      options.sendToRenderer(
        'summary-status',
        {
          state: 'error',
          sessionDir: options.getCurrentSessionDir(),
          message: 'summary model not found',
        },
        'failed to send summary-status error',
      )
      return
    }

    if (summarizerProcess) {
      if (currentSummaryModelPath !== modelPath) {
        const ok = writeToProcess(JSON.stringify({ cmd: 'load_model', model_path: modelPath }) + '\n')
        if (ok) currentSummaryModelPath = modelPath
      }
      return
    }

    const script = path.join(options.getBackendRoot(), 'summarizer_daemon.py')
    const env = { ...options.getPythonEnv(), SUMMODEL_PATH: modelPath }
    summarizerProcess = spawn(options.getPythonCommand(), [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    currentSummaryModelPath = modelPath

    if (summarizerProcess.stdout) {
      summarizerProcess.stdout.on('data', makeJsonLineParser<SummarizerEvent>(handleParsedEvent))
    } else {
      log.error('[summarizer] stdout not available')
    }

    if (summarizerProcess.stderr) {
      summarizerProcess.stderr.on('data', (data) => {
        log.error('[summarizer stderr]', (data as Buffer).toString().trim())
      })
    } else {
      log.error('[summarizer] stderr not available')
    }

    summarizerProcess.on('error', (error) => {
      log.error('[summarizer spawn error]', error)
      options.sendToRenderer(
        'summary-status',
        {
          state: 'error',
          sessionDir: options.getCurrentSessionDir(),
          message: 'failed to start summarizer',
        },
        'failed to send summary-status spawn error',
      )
    })

    summarizerProcess.on('exit', (code) => {
      log.log('[summarizer] exited', code)
      summarizerProcess = null
      currentSummaryModelPath = null
      options.summaryOrchestrator.handleSummarizerExit()
      failPendingFollowUps('summarizer exited before follow-up finished')
    })
  }

  async function ensureRuntime(): Promise<ProcessResult> {
    try {
      await options.ensurePythonRuntime()
      const summaryModelPath = await options.ensureSummaryModel()
      if (!summaryModelPath) {
        return { ok: false, error: 'summary model not found' }
      }
      startIfNeeded(summaryModelPath)
      if (!summarizerProcess) {
        return { ok: false, error: 'summarizer not running' }
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'failed to prepare summarizer',
      }
    }
  }

  function requestTranscriptSummary(text: string): void {
    const modelPath = options.resolveSummaryModelPath()
    if (!modelPath || !fs.existsSync(modelPath)) {
      throw new Error('summary model not found')
    }
    startIfNeeded(modelPath)
    options.sendToRenderer(
      'summary-status',
      {
        state: 'starting',
        sessionDir: options.getCurrentSessionDir(),
        message: 'starting summarization',
      },
      'failed to send summary-status starting',
    )
    if (!summarizerProcess) {
      throw new Error('summarizer not running')
    }
    options.summaryOrchestrator.requestFinalSummary(text, buildSummaryArgs())
  }

  async function generateFollowUpEmail(payload: {
    summary?: string
    studentName?: string
    instructions?: string
    temperature?: number
    maxTokens?: number
  } = {}): Promise<FollowUpResult> {
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
    if (!summary) return { ok: false, error: 'summary is required' }
    const studentName = typeof payload.studentName === 'string' ? payload.studentName.trim() : ''
    const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : ''
    const temperature = typeof payload.temperature === 'number' ? payload.temperature : undefined
    const maxTokens = typeof payload.maxTokens === 'number' ? payload.maxTokens : undefined

    let modelPath: string | null = null
    try {
      modelPath = await options.ensureSummaryModel()
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'failed to prepare summary model',
      }
    }
    if (!modelPath) return { ok: false, error: 'summary model not found' }

    startIfNeeded(modelPath)
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

      const ok = writeToProcess(JSON.stringify(cmd) + '\n')
      if (!ok) {
        clearTimeout(timeout)
        followUpRequests.delete(requestId)
        resolve({ ok: false, error: 'failed to start follow-up generation' })
      }
    })
  }

  function shutdown(): void {
    const proc = summarizerProcess
    summarizerProcess = null
    currentSummaryModelPath = null
    options.summaryOrchestrator.handleSummarizerExit()
    failPendingFollowUps('summarizer shut down')
    if (!proc) return
    try {
      proc.kill('SIGTERM')
    } catch (error) {
      log.error('failed to kill summarizer', error)
    }
  }

  return {
    sendCommand,
    startIfNeeded,
    ensureRuntime,
    requestTranscriptSummary,
    generateFollowUpEmail,
    shutdown,
  }
}
