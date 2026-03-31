import { useEffect, useRef, useState } from 'react'

type StepState = 'idle' | 'running' | 'paused' | 'done' | 'error'

export function useRecordingTimer(recordingState: StepState) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [blinkOn, setBlinkOn] = useState(false)
  const recordingStartRef = useRef<number | null>(null)
  const pauseStartRef = useRef<number | null>(null)
  const pausedMsRef = useRef(0)

  function getElapsedSeconds(): number {
    if (!recordingStartRef.current) return 0
    const now = Date.now()
    const pausedMs = pausedMsRef.current + (pauseStartRef.current ? now - pauseStartRef.current : 0)
    return Math.max(0, Math.floor((now - recordingStartRef.current - pausedMs) / 1000))
  }

  function formatElapsed(secs: number): string {
    const hours = Math.floor(secs / 3600)
    const minutes = Math.floor((secs % 3600) / 60)
    const seconds = secs % 60
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  function startTimer(startedAtMs: number): void {
    recordingStartRef.current = startedAtMs
    pauseStartRef.current = null
    pausedMsRef.current = 0
    setElapsedSeconds(0)
  }

  function pauseTimer(): void {
    pauseStartRef.current = Date.now()
    setElapsedSeconds(getElapsedSeconds())
  }

  function resumeTimer(): void {
    if (pauseStartRef.current) {
      pausedMsRef.current += Date.now() - pauseStartRef.current
      pauseStartRef.current = null
    }
    setElapsedSeconds(getElapsedSeconds())
  }

  function stopTimer(): void {
    if (pauseStartRef.current) {
      pausedMsRef.current += Date.now() - pauseStartRef.current
      pauseStartRef.current = null
    }
  }

  function resetTimer(): void {
    recordingStartRef.current = null
    pauseStartRef.current = null
    pausedMsRef.current = 0
    setElapsedSeconds(0)
  }

  useEffect(() => {
    if (recordingState !== 'running') {
      setBlinkOn(false)
      return
    }
    const interval = setInterval(() => {
      setBlinkOn((prev) => !prev)
      setElapsedSeconds(getElapsedSeconds())
    }, 500)
    return () => clearInterval(interval)
  }, [recordingState])

  return {
    elapsedSeconds,
    blinkOn,
    formatElapsed,
    startTimer,
    pauseTimer,
    resumeTimer,
    stopTimer,
    resetTimer,
  }
}
