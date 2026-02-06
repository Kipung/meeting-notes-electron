import { contextBridge, ipcRenderer } from 'electron'

const onChannel = (channel: string, cb: (ev: any, data: any) => void) => {
  ipcRenderer.on(channel, cb)
  return () => ipcRenderer.removeListener(channel, cb)
}

contextBridge.exposeInMainWorld('backend', {
  start: (opts?: { deviceIndex?: number; loopbackDeviceIndex?: number; model?: string }) => ipcRenderer.send('backend-start', opts || {}),
  stop: () => ipcRenderer.send('backend-stop'),
  pause: () => ipcRenderer.send('backend-pause'),
  resume: () => ipcRenderer.send('backend-resume'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  getSessionsRoot: () => ipcRenderer.invoke('get-sessions-root'),
  chooseSessionsRoot: () => ipcRenderer.invoke('choose-sessions-root'),
  deleteSessionAudio: (sessionDir: string) => ipcRenderer.invoke('delete-session-audio', sessionDir),
  generateFollowUpEmail: (payload: { summary: string; studentName?: string; instructions?: string; temperature?: number; maxTokens?: number }) =>
    ipcRenderer.invoke('generate-followup-email', payload),
  onSession: (cb: (ev: any, data: any) => void) => onChannel('session-started', cb),
  onTranscript: (cb: (ev: any, data: any) => void) => onChannel('transcript-ready', cb),
  onTranscriptPartial: (cb: (ev: any, data: any) => void) => onChannel('transcript-partial', cb),
  onTranscriptionStatus: (cb: (ev: any, data: any) => void) => onChannel('transcription-status', cb),
  onRecordingReady: (cb: (ev: any, data: any) => void) => onChannel('recording-ready', cb),
  onRecordingStarted: (cb: (ev: any, data: any) => void) => onChannel('recording-started', cb),
  onSummary: (cb: (ev: any, data: any) => void) => onChannel('summary-ready', cb),
  onSummaryStatus: (cb: (ev: any, data: any) => void) => onChannel('summary-status', cb),
  onSummaryStream: (cb: (ev: any, data: any) => void) => onChannel('summary-stream', cb),
  onBootstrapStatus: (cb: (ev: any, data: any) => void) => onChannel('bootstrap-status', cb),
  processRecording: () => ipcRenderer.invoke('process-recording'),
})
