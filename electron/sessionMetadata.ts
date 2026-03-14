import fs from 'node:fs'
import path from 'node:path'

export type SessionMetadataInput = {
  modality?: string
  subject?: string
  studentId?: string
  studentName?: string
  coachInitials?: string
}

export type SessionMetadata = {
  modality: string
  subject: string
  student_id: string
  student_name: string
  coach_initials: string
}

export type SummarizerContextMetadata = {
  modality?: string
  subject?: string
  student_id?: string
  student_name?: string
  coach?: string
}

const EMPTY_SESSION_METADATA: SessionMetadata = {
  modality: '',
  subject: '',
  student_id: '',
  student_name: '',
  coach_initials: '',
}

function normalizeMetadataValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeSessionMetadata(input?: SessionMetadataInput | null): SessionMetadata {
  return {
    modality: normalizeMetadataValue(input?.modality),
    subject: normalizeMetadataValue(input?.subject),
    student_id: normalizeMetadataValue(input?.studentId),
    student_name: normalizeMetadataValue(input?.studentName),
    coach_initials: normalizeMetadataValue(input?.coachInitials),
  }
}

export function getSessionMetadataPath(sessionDir: string): string {
  return path.join(sessionDir, 'session_metadata.json')
}

function normalizePersistedSessionMetadata(input: unknown): SessionMetadata {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    modality: normalizeMetadataValue(obj.modality),
    subject: normalizeMetadataValue(obj.subject),
    student_id: normalizeMetadataValue(obj.student_id ?? obj.studentId),
    student_name: normalizeMetadataValue(obj.student_name ?? obj.studentName),
    coach_initials: normalizeMetadataValue(obj.coach_initials ?? obj.coachInitials),
  }
}

export function writeSessionMetadata(sessionDir: string, metadata: SessionMetadata): void {
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(getSessionMetadataPath(sessionDir), JSON.stringify(metadata, null, 2), 'utf-8')
}

export function readSessionMetadata(sessionDir: string): SessionMetadata | null {
  const metadataPath = getSessionMetadataPath(sessionDir)
  if (!fs.existsSync(metadataPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
    return normalizePersistedSessionMetadata(raw)
  } catch {
    return null
  }
}

export function getSummaryContextMetadata(metadata: SessionMetadata): SummarizerContextMetadata {
  const context: SummarizerContextMetadata = {}
  if (metadata.modality) context.modality = metadata.modality
  if (metadata.subject) context.subject = metadata.subject
  if (metadata.student_id) context.student_id = metadata.student_id
  if (metadata.student_name) context.student_name = metadata.student_name
  if (metadata.coach_initials) context.coach = metadata.coach_initials
  return context
}

export function createSessionMetadataStore(onPersistError?: (error: unknown) => void) {
  let currentSessionMetadata: SessionMetadata = { ...EMPTY_SESSION_METADATA }

  return {
    get(): SessionMetadata {
      return { ...currentSessionMetadata }
    },
    apply(input?: SessionMetadataInput | null, sessionDir: string | null = null): SessionMetadata {
      if (input) {
        currentSessionMetadata = normalizeSessionMetadata(input)
      }
      const snapshot = { ...currentSessionMetadata }
      if (sessionDir) {
        try {
          writeSessionMetadata(sessionDir, snapshot)
        } catch (error) {
          onPersistError?.(error)
        }
      }
      return snapshot
    },
  }
}
