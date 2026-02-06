/// <reference types="vite/client" />

interface Window {
  backend: {
    start: (opts?: { deviceIndex?: number; model?: string }) => void
    stop: () => void
    pause: () => void
    resume: () => void
    listDevices: () => Promise<any>
    getSessionsRoot: () => Promise<string | null>
    chooseSessionsRoot: () => Promise<string | null>
    deleteSessionAudio: (sessionDir: string) => Promise<{ ok: boolean; deleted?: string[]; error?: string }>
    generateFollowUpEmail: (payload: {
      summary: string
      studentName?: string
      instructions?: string
      temperature?: number
      maxTokens?: number
    }) => Promise<{ ok: boolean; text?: string; error?: string }>
    processRecording: () => Promise<{ ok: boolean; error?: string }>
    onSession: (cb: (ev: any, data: any) => void) => () => void
    onTranscript: (cb: (ev: any, data: any) => void) => () => void
    onTranscriptionStatus: (cb: (ev: any, data: any) => void) => () => void
    onRecordingReady: (cb: (ev: any, data: any) => void) => () => void
    onRecordingStarted: (cb: (ev: any, data: any) => void) => () => void
    onSummary: (cb: (ev: any, data: any) => void) => () => void
    onSummaryStatus: (cb: (ev: any, data: any) => void) => () => void
    onSummaryStream: (cb: (ev: any, data: any) => void) => () => void
    onBootstrapStatus: (cb: (ev: any, data: any) => void) => () => void
  }
}
