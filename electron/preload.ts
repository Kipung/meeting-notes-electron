import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('backend', {
  start: (opts?: { deviceIndex?: number; model?: string }) => ipcRenderer.send('backend-start', opts || {}),
  stop: () => ipcRenderer.send('backend-stop'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  onSession: (cb: (ev: any, data: any) => void) => ipcRenderer.on('session-started', cb),
  onRecordingStatus: (cb: (ev: any, data: any) => void) => ipcRenderer.on('recording-status', cb),
  onTranscript: (cb: (ev: any, data: any) => void) => ipcRenderer.on('transcript-ready', cb),
  onTranscriptionStatus: (cb: (ev: any, data: any) => void) => ipcRenderer.on('transcription-status', cb),
  onSummary: (cb: (ev: any, data: any) => void) => ipcRenderer.on('summary-ready', cb),
  onSummaryStatus: (cb: (ev: any, data: any) => void) => ipcRenderer.on('summary-status', cb),
  onBootstrapStatus: (cb: (ev: any, data: any) => void) => ipcRenderer.on('bootstrap-status', cb),
})
