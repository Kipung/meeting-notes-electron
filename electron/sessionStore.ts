import fs from 'node:fs'
import path from 'node:path'

import type { App } from 'electron'

export type AppSettings = {
  sessionsRoot?: string
}

export type InputFileKind = 'audio' | 'transcript'

export const AUDIO_FILE_FILTER_EXTENSIONS = ['wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg', 'webm']
export const TRANSCRIPT_FILE_FILTER_EXTENSIONS = ['txt', 'md', 'markdown', 'srt', 'vtt', 'log', 'json']

const AUDIO_FILE_EXTENSIONS = new Set(AUDIO_FILE_FILTER_EXTENSIONS.map((ext) => `.${ext}`))
const TRANSCRIPT_FILE_EXTENSIONS = new Set(TRANSCRIPT_FILE_FILTER_EXTENSIONS.map((ext) => `.${ext}`))

type SessionStoreOptions = {
  app: App
  onReadSettingsError?: (error: unknown) => void
  onListSessionAudioError?: (sessionDir: string, error: unknown) => void
}

export function createSessionStore(options: SessionStoreOptions) {
  const { app, onReadSettingsError, onListSessionAudioError } = options

  function getUserDataRoot(): string {
    return app.getPath('userData')
  }

  function getSettingsPath(): string {
    return path.join(getUserDataRoot(), 'settings.json')
  }

  function readSettings(): AppSettings {
    const settingsPath = getSettingsPath()
    if (!fs.existsSync(settingsPath)) return {}
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return {}
      return parsed as AppSettings
    } catch (error) {
      onReadSettingsError?.(error)
      return {}
    }
  }

  function writeSettings(next: AppSettings): void {
    const settingsPath = getSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf-8')
  }

  function getDefaultSessionsRoot(): string {
    return path.join(getUserDataRoot(), 'sessions')
  }

  function getSessionsRoot(): string {
    const settings = readSettings()
    const root = settings.sessionsRoot?.trim()
    return root && root.length > 0 ? root : getDefaultSessionsRoot()
  }

  function setSessionsRoot(root: string): string {
    const trimmed = root.trim()
    const settings = readSettings()
    if (trimmed) settings.sessionsRoot = trimmed
    else delete settings.sessionsRoot
    writeSettings(settings)
    return trimmed || getDefaultSessionsRoot()
  }

  function resolveSessionDir(sessionDir: string): string | null {
    if (!sessionDir || typeof sessionDir !== 'string') return null
    const resolved = path.resolve(sessionDir)
    const root = path.resolve(getSessionsRoot())
    if (resolved === root) return null
    if (!resolved.startsWith(root + path.sep)) return null
    return resolved
  }

  function makeSessionDir(): string {
    const sessionsRoot = getSessionsRoot()
    fs.mkdirSync(sessionsRoot, { recursive: true })

    const ts = new Date()
      .toISOString()
      .replace(/[:]/g, '-')
      .replace(/\..+$/, '')
    const sessionDir = path.join(sessionsRoot, ts)
    fs.mkdirSync(sessionDir, { recursive: true })
    return sessionDir
  }

  function listSessionAudioPaths(sessionDir: string): string[] {
    const paths: string[] = []
    try {
      const entries = fs.readdirSync(sessionDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const ext = path.extname(entry.name).toLowerCase()
        if (AUDIO_FILE_EXTENSIONS.has(ext)) {
          paths.push(path.join(sessionDir, entry.name))
        }
      }
    } catch (error) {
      onListSessionAudioError?.(sessionDir, error)
    }

    const chunksDir = path.join(sessionDir, 'chunks')
    if (fs.existsSync(chunksDir)) {
      try {
        const entries = fs.readdirSync(chunksDir)
        for (const entry of entries) {
          if (entry.toLowerCase().endsWith('.wav')) {
            paths.push(path.join(chunksDir, entry))
          }
        }
      } catch (error) {
        onListSessionAudioError?.(chunksDir, error)
      }
    }
    return paths
  }

  function classifyInputFile(filePath: string): InputFileKind | null {
    const ext = path.extname(filePath).toLowerCase()
    if (AUDIO_FILE_EXTENSIONS.has(ext)) return 'audio'
    if (TRANSCRIPT_FILE_EXTENSIONS.has(ext)) return 'transcript'
    return null
  }

  function readTranscriptTextFromFile(filePath: string): string {
    const raw = fs.readFileSync(filePath, 'utf-8')
    if (path.extname(filePath).toLowerCase() !== '.json') return raw
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        if (typeof obj.text === 'string') return obj.text
        if (typeof obj.transcript === 'string') return obj.transcript
        if (Array.isArray(obj.segments)) {
          const lines = obj.segments
            .map((seg) => {
              if (!seg || typeof seg !== 'object') return ''
              const text = (seg as Record<string, unknown>).text
              return typeof text === 'string' ? text.trim() : ''
            })
            .filter(Boolean)
          if (lines.length > 0) return lines.join('\n')
        }
      }
    } catch {
      // Fall back to raw JSON text when shape is unknown.
    }
    return raw
  }

  return {
    getUserDataRoot,
    getSettingsPath,
    readSettings,
    writeSettings,
    getDefaultSessionsRoot,
    getSessionsRoot,
    setSessionsRoot,
    resolveSessionDir,
    makeSessionDir,
    listSessionAudioPaths,
    classifyInputFile,
    readTranscriptTextFromFile,
  }
}
