import path from 'node:path'

import type { SummarizerContextMetadata } from './sessionMetadata'

const CHUNK_WORD_THRESHOLD = 900
const FINAL_SUMMARY_DIRECT_TRANSCRIPT_WORD_THRESHOLD = 1400

export type SummarizerContext = {
  type?: 'chunk' | 'final'
  id?: number
  sessionDir?: string | null
  sourceTranscript?: string
} & SummarizerContextMetadata

export type SummaryCommandPayload = {
  cmd: 'summarize'
  text: string
  out: string | null
  chunk_words: number
  context: SummarizerContext
}

type ChunkTask = {
  id: number
  text: string
  sessionDir: string | null
}

type SummaryEventLike = {
  event?: string
  text?: string
  msg?: string
}

type BuildSummaryContext = (sessionDir: string) => SummarizerContextMetadata
type SendSummaryCommand = (payload: SummaryCommandPayload) => boolean
type LogMessage = (...args: unknown[]) => void

type SummaryOperationArgs = {
  currentSessionDir: string | null
  buildSummaryContext: BuildSummaryContext
  sendCommand: SendSummaryCommand
  logError: LogMessage
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).filter(Boolean).length
}

export class SummaryOrchestrator {
  private chunkQueue: ChunkTask[] = []
  private chunkProcessing = false
  private nextChunkId = 0
  private chunkSummaries = new Map<number, string>()
  private lastTranscriptOffset = 0
  private transcriptBuffer = ''
  private chunkSummariesEnabled = false
  private finalSummaryPending: string | null = null
  private finalSummaryRunning = false
  private chunkSummariesSession: string | null = null
  private pendingFinalSummarySession: string | null = null

  reset(): void {
    this.chunkQueue = []
    this.chunkProcessing = false
    this.nextChunkId = 0
    this.chunkSummaries = new Map()
    this.lastTranscriptOffset = 0
    this.transcriptBuffer = ''
    this.chunkSummariesEnabled = false
    this.chunkSummariesSession = null
    this.finalSummaryPending = null
    this.finalSummaryRunning = false
    this.pendingFinalSummarySession = null
  }

  startSession(sessionDir: string): void {
    this.reset()
    this.chunkSummariesSession = sessionDir
    this.chunkSummariesEnabled = true
  }

  processTranscriptPartialText(
    fullText: string,
    args: SummaryOperationArgs,
  ): void {
    if (!this.chunkSummariesEnabled) return
    const text = fullText || ''
    this.transcriptBuffer = text
    const unprocessed = this.transcriptBuffer.slice(this.lastTranscriptOffset)
    if (!unprocessed.trim()) return
    if (countWords(unprocessed) < CHUNK_WORD_THRESHOLD) return
    this.queueChunkSummarization(unprocessed, args)
    this.lastTranscriptOffset = this.transcriptBuffer.length
  }

  requestFinalSummary(fullText: string, args: SummaryOperationArgs): boolean {
    if (!args.currentSessionDir) {
      args.logError('cannot request final summary without a session directory')
      return false
    }
    this.finalSummaryPending = fullText
    this.chunkSummariesEnabled = false
    this.pendingFinalSummarySession = args.currentSessionDir
    this.maybeStartPendingFinalSummary(args)
    return true
  }

  handleChunkSummarizerEvent(
    obj: SummaryEventLike,
    context: SummarizerContext | undefined,
    args: SummaryOperationArgs,
  ): void {
    if (!context || context.type !== 'chunk') return
    if (!context.sessionDir || context.sessionDir !== this.chunkSummariesSession) return

    const chunkId = typeof context.id === 'number' ? context.id : null
    if (obj.event === 'progress' || obj.event === 'summary_delta') return

    if (obj.event === 'done' || obj.event === 'error') {
      this.chunkProcessing = false
      if (obj.event === 'done' && chunkId !== null) {
        const summaryText = (obj.text || '').trim()
        if (summaryText) this.chunkSummaries.set(chunkId, summaryText)
      }
      if (obj.event === 'error') {
        args.logError(`[summarizer chunk ${chunkId}] error`, obj.msg)
      }
      this.processChunkQueue(args)
      this.maybeStartPendingFinalSummary(args)
    }
  }

  shouldHandleFinalEvent(contextSessionDir: string | null): boolean {
    return !this.pendingFinalSummarySession || contextSessionDir === this.pendingFinalSummarySession
  }

  resolveFinalEventSession(contextSessionDir: string | null, currentSessionDir: string | null): string | null {
    return contextSessionDir || this.pendingFinalSummarySession || currentSessionDir
  }

  markFinalSummaryFinished(): void {
    this.finalSummaryRunning = false
  }

  clearPendingFinalSummarySession(): void {
    this.pendingFinalSummarySession = null
  }

  handleSummarizerExit(): void {
    this.chunkProcessing = false
    this.finalSummaryRunning = false
  }

  getDebugSnapshot() {
    return {
      chunkQueueLength: this.chunkQueue.length,
      chunkProcessing: this.chunkProcessing,
      chunkSummaryCount: this.chunkSummaries.size,
      transcriptOffset: this.lastTranscriptOffset,
      chunkSummariesEnabled: this.chunkSummariesEnabled,
      finalSummaryPending: Boolean(this.finalSummaryPending),
      finalSummaryRunning: this.finalSummaryRunning,
      chunkSummariesSession: this.chunkSummariesSession,
      pendingFinalSummarySession: this.pendingFinalSummarySession,
    }
  }

  private queueChunkSummarization(
    text: string,
    args: SummaryOperationArgs,
  ): void {
    if (!this.chunkSummariesEnabled) return
    const chunkText = text.trim()
    if (!chunkText) return
    this.chunkQueue.push({ id: this.nextChunkId++, text: chunkText, sessionDir: args.currentSessionDir })
    this.processChunkQueue(args)
  }

  private processChunkQueue(args: SummaryOperationArgs): void {
    if (this.chunkProcessing || this.chunkQueue.length === 0) return

    const task = this.chunkQueue.shift()
    if (!task) return
    this.chunkProcessing = true
    const payload: SummaryCommandPayload = {
      cmd: 'summarize',
      text: task.text,
      out: null,
      chunk_words: CHUNK_WORD_THRESHOLD,
      context: { type: 'chunk', id: task.id, sessionDir: task.sessionDir },
    }
    const ok = args.sendCommand(payload)
    if (!ok) {
      this.chunkProcessing = false
      this.chunkQueue.unshift(task)
      args.logError('[summarizer chunk] failed to send chunk summarization command')
      this.maybeStartPendingFinalSummary(args)
    }
  }

  private maybeStartPendingFinalSummary(args: SummaryOperationArgs): void {
    if (this.finalSummaryPending === null || this.finalSummaryPending === undefined) return
    if (this.chunkProcessing || this.chunkQueue.length > 0) return
    const text = this.finalSummaryPending
    this.finalSummaryPending = null
    this.startFinalSummary(text, args)
  }

  private startFinalSummary(fullText: string, args: SummaryOperationArgs): void {
    if (this.finalSummaryRunning) return

    this.finalSummaryRunning = true
    const orderedSummaries = Array.from(this.chunkSummaries.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, summary]) => summary)
      .filter(Boolean)
    const leftoverStart = Math.min(this.lastTranscriptOffset, fullText.length)
    const leftover = fullText.slice(leftoverStart).trim()
    const transcriptWordCount = countWords(fullText)
    let inputText = fullText
    let finalChunkWords = CHUNK_WORD_THRESHOLD
    const summarySessionDir = this.pendingFinalSummarySession || args.currentSessionDir

    if (!summarySessionDir) {
      args.logError('final summary requested with no session directory')
      this.finalSummaryRunning = false
      return
    }

    const context: SummarizerContext = {
      type: 'final',
      sessionDir: summarySessionDir,
      ...args.buildSummaryContext(summarySessionDir),
    }

    if (transcriptWordCount <= FINAL_SUMMARY_DIRECT_TRANSCRIPT_WORD_THRESHOLD) {
      finalChunkWords = Math.max(transcriptWordCount + 1, FINAL_SUMMARY_DIRECT_TRANSCRIPT_WORD_THRESHOLD)
    } else if (orderedSummaries.length > 0) {
      const segments: string[] = [`Previous chunk summaries:\n${orderedSummaries.join('\n\n')}`]
      if (leftover) {
        segments.push(`Remaining transcript:\n${leftover}`)
      }
      inputText = segments.join('\n\n')
      finalChunkWords = Math.max(countWords(inputText) + 1, FINAL_SUMMARY_DIRECT_TRANSCRIPT_WORD_THRESHOLD)
      context.sourceTranscript = fullText
    }

    const payload: SummaryCommandPayload = {
      cmd: 'summarize',
      text: inputText,
      out: path.join(summarySessionDir, 'summary.txt'),
      chunk_words: finalChunkWords,
      context,
    }

    const ok = args.sendCommand(payload)
    if (!ok) {
      this.finalSummaryRunning = false
      args.logError('[summarizer final] failed to send summary command')
    }
  }
}
