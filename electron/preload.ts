import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('backend', {
  start: (opts?: { deviceIndex?: number; model?: string }) => ipcRenderer.send('backend-start', opts || {}),
  stop: () => ipcRenderer.send('backend-stop'),
  pause: () => ipcRenderer.send('backend-pause'),
  resume: () => ipcRenderer.send('backend-resume'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  getSessionsRoot: () => ipcRenderer.invoke('get-sessions-root'),
  chooseSessionsRoot: () => ipcRenderer.invoke('choose-sessions-root'),
  deleteSessionAudio: (sessionDir: string) => ipcRenderer.invoke('delete-session-audio', sessionDir),
  generateFollowUpEmail: (payload: { summary: string; studentName?: string; instructions?: string; temperature?: number; maxTokens?: number }) =>
    ipcRenderer.invoke('generate-followup-email', payload),
  onSession: (cb: (ev: any, data: any) => void) => ipcRenderer.on('session-started', cb),
  onTranscript: (cb: (ev: any, data: any) => void) => ipcRenderer.on('transcript-ready', cb),
  onTranscriptionStatus: (cb: (ev: any, data: any) => void) => ipcRenderer.on('transcription-status', cb),
  onSummary: (cb: (ev: any, data: any) => void) => ipcRenderer.on('summary-ready', cb),
  onSummaryStatus: (cb: (ev: any, data: any) => void) => ipcRenderer.on('summary-status', cb),
  onSummaryStream: (cb: (ev: any, data: any) => void) => ipcRenderer.on('summary-stream', cb),
  onBootstrapStatus: (cb: (ev: any, data: any) => void) => ipcRenderer.on('bootstrap-status', cb),
})
