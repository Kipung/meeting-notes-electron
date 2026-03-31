import { useEffect, useMemo, useState } from 'react'

type StepState = 'idle' | 'running' | 'paused' | 'done' | 'error'

const backend = window.backend

type UseSessionMetadataOptions = {
  sessionDir: string | null
  running: boolean
  recordingState: StepState
  transcriptionState: StepState
  summarizationState: StepState
}

export function useSessionMetadata({
  sessionDir,
  running,
  recordingState,
  transcriptionState,
  summarizationState,
}: UseSessionMetadataOptions) {
  const [sessionModality, setSessionModality] = useState('')
  const [sessionSubject, setSessionSubject] = useState('')
  const [coachInitials, setCoachInitials] = useState('')
  const [studentId, setStudentId] = useState('')
  const [studentName, setStudentName] = useState('')

  const sessionMetadataPayload = useMemo<BackendSessionMetadataPayload>(
    () => ({
      modality: sessionModality.trim(),
      subject: sessionSubject.trim(),
      studentId: studentId.trim(),
      studentName: studentName.trim(),
      coachInitials: coachInitials.trim(),
    }),
    [sessionModality, sessionSubject, studentId, studentName, coachInitials],
  )

  const syncActive =
    Boolean(sessionDir) &&
    (running || recordingState === 'paused' || transcriptionState === 'running' || summarizationState === 'running')

  useEffect(() => {
    if (!syncActive) return
    void backend.setSessionMetadata(sessionMetadataPayload).catch((e) => {
      console.error('setSessionMetadata failed', e)
    })
  }, [syncActive, sessionMetadataPayload])

  return {
    sessionModality,
    setSessionModality,
    sessionSubject,
    setSessionSubject,
    coachInitials,
    setCoachInitials,
    studentId,
    setStudentId,
    studentName,
    setStudentName,
    sessionMetadataPayload,
  }
}
