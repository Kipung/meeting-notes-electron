/// <reference types="vite/client" />

interface Window {
  backend: {
    start: (opts?: { deviceIndex?: number; model?: string }) => void
    stop: () => void
    listDevices: () => Promise<any>
    onSession: (cb: (ev: any, data: any) => void) => void
    onRecordingStatus: (cb: (ev: any, data: any) => void) => void
    onTranscript: (cb: (ev: any, data: any) => void) => void
    onTranscriptionStatus: (cb: (ev: any, data: any) => void) => void
    onSummary: (cb: (ev: any, data: any) => void) => void
    onSummaryStatus: (cb: (ev: any, data: any) => void) => void
    onBootstrapStatus: (cb: (ev: any, data: any) => void) => void
  }
}
