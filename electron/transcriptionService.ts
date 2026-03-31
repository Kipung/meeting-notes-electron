import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { makeJsonLineParser } from './utils/lineParser'

type ProcessResult = { ok: boolean; error?: string }

type RecorderEvent = {
  event?: string
  text?: string
  full_text?: string
  fullText?: string
  msg?: string
  out?: string
  started_at?: number
  startedAt?: number
}

type StartRecorderOptions = {
  modelName: string
  vadModelPath?: string | null
}

type StartRecordingSessionOptions = {
  sessionDir: string
  deviceIndex?: number
  loopbackDeviceIndex?: number
}

type StartFileTranscriptionOptions = {
  audioPath: string
  sessionDir: string
  modelName: string
}

type CreateTranscriptionServiceOptions = {
  getBackendRoot: () => string
  getPythonCommand: () => string
  getPythonEnv: () => NodeJS.ProcessEnv
  getCurrentSessionDir: () => string | null
  onTranscriptReady: (outPath: string, text: string) => void
  onTranscriptPartial: (text: string) => void
  sendToRenderer: (channel: string, payload: unknown, errorLabel: string) => void
  log: Pick<Console, 'log' | 'error'>
}

export function createTranscriptionService(options: CreateTranscriptionServiceOptions) {
  let backendProcess: ReturnType<typeof spawn> | null = null
  let fileTranscribeProcess: ReturnType<typeof spawn> | null = null

  function sendProcessCommand(proc: ReturnType<typeof spawn> | null, label: string, payload: string): boolean {
    if (!proc?.stdin) {
      options.log.error(`[${label}] stdin not available`)
      return false
    }
    try {
      proc.stdin.write(payload)
      return true
    } catch (error) {
      options.log.error(`[${label}] failed to write`, error)
      return false
    }
  }

  const handleRecorderOutput = makeJsonLineParser<RecorderEvent>((obj) => {
    if (obj.event === 'partial') {
      const partialText = obj.full_text || obj.fullText || obj.text || ''
      options.sendToRenderer(
        'transcript-partial',
        {
          sessionDir: options.getCurrentSessionDir(),
          text: obj.text || '',
          fullText: partialText,
        },
        'failed to send transcript-partial',
      )
      try {
        options.onTranscriptPartial(partialText)
      } catch (error) {
        options.log.error('failed to process transcript partial text', error)
      }
      return
    }

    if (obj.event === 'started') {
      const startedAt =
        typeof obj.started_at === 'number'
          ? obj.started_at
          : typeof obj.startedAt === 'number'
            ? obj.startedAt
            : null
      options.sendToRenderer(
        'recording-started',
        {
          sessionDir: options.getCurrentSessionDir(),
          startedAtMs: startedAt ? Math.round(startedAt * 1000) : Date.now(),
        },
        'failed to send recording-started',
      )
      return
    }

    if (obj.event === 'ready') {
      options.sendToRenderer('recording-ready', { ready: true }, 'failed to send recording-ready')
      return
    }

    if (obj.event === 'done' && obj.out) {
      options.onTranscriptReady(obj.out, obj.text || '')
      return
    }

    if (obj.event === 'error') {
      const message = obj.msg || 'recording error'
      options.log.error('[backend recorder error]', message)
      options.sendToRenderer(
        'transcription-status',
        {
          state: 'error',
          sessionDir: options.getCurrentSessionDir(),
          message,
        },
        'failed to send transcription-status recorder error',
      )
    }
  })

  function handleFileTranscribeEvent(obj: RecorderEvent): void {
    const sessionDir = options.getCurrentSessionDir()
    if (!sessionDir) return

    if (obj.event === 'started') {
      options.sendToRenderer(
        'transcription-status',
        {
          state: 'running',
          sessionDir,
          message: 'transcribing uploaded recording',
        },
        'failed to send transcription-status running',
      )
      return
    }

    if (obj.event === 'done' && obj.out) {
      options.onTranscriptReady(obj.out, obj.text || '')
      return
    }

    if (obj.event === 'error') {
      options.sendToRenderer(
        'transcription-status',
        {
          state: 'error',
          sessionDir,
          message: obj.msg || 'transcription failed',
        },
        'failed to send transcription-status error',
      )
    }
  }

  function startRecorder({ modelName, vadModelPath }: StartRecorderOptions): ProcessResult {
    if (backendProcess) {
      options.log.log('[backend] already running')
      return { ok: true }
    }

    options.sendToRenderer('recording-ready', { ready: false }, 'failed to send recording-ready false')

    const scriptPath = path.join(options.getBackendRoot(), 'record_and_transcribe.py')
    const env: NodeJS.ProcessEnv = { ...options.getPythonEnv(), WHISPER_MODEL: modelName }
    if (vadModelPath) env.SILERO_VAD_MODEL = vadModelPath

    backendProcess = spawn(options.getPythonCommand(), [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    if (backendProcess.stdout) {
      backendProcess.stdout.on('data', (data) => {
        handleRecorderOutput(data)
      })
    } else {
      options.log.error('[backend] stdout not available')
    }

    if (backendProcess.stderr) {
      backendProcess.stderr.on('data', (data) => {
        options.log.error('[backend err]', data.toString().trim())
      })
    } else {
      options.log.error('[backend] stderr not available')
    }

    backendProcess.on('error', (error) => {
      options.log.error('[backend spawn error]', error)
      backendProcess = null
      options.sendToRenderer(
        'transcription-status',
        {
          state: 'error',
          sessionDir: options.getCurrentSessionDir(),
          message: 'failed to start recorder',
        },
        'failed to send transcription-status spawn error',
      )
    })

    backendProcess.on('exit', (code) => {
      options.log.log('[backend] exited with code', code)
      backendProcess = null
      options.sendToRenderer('recording-ready', { ready: false }, 'failed to send recording-ready false')
    })

    return { ok: true }
  }

  function startRecordingSession(optionsForSession: StartRecordingSessionOptions): ProcessResult {
    if (!backendProcess) {
      return { ok: false, error: 'recorder not running' }
    }

    const payload = {
      cmd: 'start',
      out: path.join(optionsForSession.sessionDir, 'audio.wav'),
      transcript_out: path.join(optionsForSession.sessionDir, 'transcript.txt'),
      device_index: typeof optionsForSession.deviceIndex === 'number' ? optionsForSession.deviceIndex : undefined,
      loopback_device_index:
        typeof optionsForSession.loopbackDeviceIndex === 'number' ? optionsForSession.loopbackDeviceIndex : undefined,
    }

    if (!sendProcessCommand(backendProcess, 'recorder', JSON.stringify(payload) + '\n')) {
      return { ok: false, error: 'failed to send start command' }
    }

    return { ok: true }
  }

  function startFileTranscription({
    audioPath,
    sessionDir,
    modelName,
  }: StartFileTranscriptionOptions): ProcessResult {
    if (fileTranscribeProcess) {
      return { ok: false, error: 'Already processing a recording' }
    }
    if (!fs.existsSync(audioPath)) {
      return { ok: false, error: `audio file not found: ${audioPath}` }
    }

    const destAudio = path.join(sessionDir, path.basename(audioPath))
    try {
      fs.copyFileSync(audioPath, destAudio)
    } catch (error) {
      return {
        ok: false,
        error: `failed to copy recording: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    options.sendToRenderer(
      'transcription-status',
      {
        state: 'running',
        sessionDir,
        message: 'preparing transcription',
      },
      'failed to send transcription-status running for upload',
    )

    const transcriptPath = path.join(sessionDir, 'transcript.txt')
    const script = path.join(options.getBackendRoot(), 'transcribe_file.py')
    const env = {
      ...options.getPythonEnv(),
      TRANSCRIBE_MODEL: modelName,
      TRANSCRIBE_AUDIO: destAudio,
      TRANSCRIPT_OUT: transcriptPath,
    }

    fileTranscribeProcess = spawn(options.getPythonCommand(), [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })

    fileTranscribeProcess.on('error', (error) => {
      options.log.error('[file-transcribe spawn error]', error)
      fileTranscribeProcess = null
      options.sendToRenderer(
        'transcription-status',
        {
          state: 'error',
          sessionDir,
          message: 'failed to start uploaded recording transcription',
        },
        'failed to send transcription-status file-transcribe spawn error',
      )
    })

    if (fileTranscribeProcess.stdout) {
      fileTranscribeProcess.stdout.on('data', makeJsonLineParser<RecorderEvent>(handleFileTranscribeEvent))
    } else {
      options.log.error('[file-transcribe] stdout not available')
    }

    if (fileTranscribeProcess.stderr) {
      fileTranscribeProcess.stderr.on('data', (data) => {
        options.log.error('[file-transcribe err]', data.toString().trim())
      })
    } else {
      options.log.error('[file-transcribe] stderr not available')
    }

    fileTranscribeProcess.on('exit', () => {
      fileTranscribeProcess = null
    })

    return { ok: true }
  }

  function stopRecorder(): void {
    if (!backendProcess) {
      options.log.log('[backend] not running')
      return
    }

    if (sendProcessCommand(backendProcess, 'recorder', JSON.stringify({ cmd: 'stop' }) + '\n')) {
      options.log.log('[backend] stop command sent')
      return
    }

    options.log.error('[backend] failed to send stop command')
  }

  function pauseRecorder(): void {
    if (!backendProcess) {
      options.log.log('[backend] not running')
      return
    }
    sendProcessCommand(backendProcess, 'recorder', JSON.stringify({ cmd: 'pause' }) + '\n')
  }

  function resumeRecorder(): void {
    if (!backendProcess) {
      options.log.log('[backend] not running')
      return
    }
    sendProcessCommand(backendProcess, 'recorder', JSON.stringify({ cmd: 'resume' }) + '\n')
  }

  function listDevices(): Promise<unknown> {
    const script = path.join(options.getBackendRoot(), 'devices.py')
    return new Promise((resolve) => {
      const proc = spawn(options.getPythonCommand(), [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.getPythonEnv(),
      })
      let out = ''
      let settled = false
      const finish = (value: unknown) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      proc.stdout?.on('data', (data) => {
        out += data.toString()
      })
      proc.stderr?.on('data', (data) => options.log.error('[devices err]', data.toString().trim()))
      proc.on('error', (error) => {
        options.log.error('[devices spawn error]', error)
        finish({ error: `failed to run devices script: ${error.message}` })
      })
      proc.on('exit', () => {
        try {
          finish(JSON.parse(out || '{}'))
        } catch {
          finish({ error: 'failed to parse devices', raw: out })
        }
      })
    })
  }

  function isRecordingSession(sessionDir: string): boolean {
    const currentSessionDir = options.getCurrentSessionDir()
    return Boolean(
      backendProcess &&
        currentSessionDir &&
        path.resolve(currentSessionDir) === path.resolve(sessionDir),
    )
  }

  function stopFileTranscribeProcess(): void {
    if (!fileTranscribeProcess) return
    try {
      fileTranscribeProcess.kill('SIGTERM')
    } catch (error) {
      options.log.error('failed to kill file transcribe process', error)
    }
    fileTranscribeProcess = null
  }

  function shutdown(): void {
    if (backendProcess) {
      const proc = backendProcess
      sendProcessCommand(proc, 'recorder', JSON.stringify({ cmd: 'shutdown' }) + '\n')
      setTimeout(() => {
        if (backendProcess !== proc) return
        try {
          proc.kill('SIGTERM')
        } catch (error) {
          options.log.error('failed to kill backend', error)
        }
        backendProcess = null
      }, 3000)
    }

    stopFileTranscribeProcess()
  }

  return {
    startRecorder,
    startRecordingSession,
    startFileTranscription,
    stopRecorder,
    pauseRecorder,
    resumeRecorder,
    listDevices,
    isRecordingSession,
    shutdown,
  }
}
