import * as electron from 'electron'

const { contextBridge, ipcRenderer } = electron

const onChannel = <T>(channel: string, cb: BackendEventHandler<T>) => {
  const listener = (event: electron.IpcRendererEvent, data: T) => cb(event, data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const backendApi: BackendApi = {
  start: (opts) => ipcRenderer.send('backend-start', opts || {}),
  stop: () => ipcRenderer.send('backend-stop'),
  pause: () => ipcRenderer.send('backend-pause'),
  resume: () => ipcRenderer.send('backend-resume'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  getSessionsRoot: () => ipcRenderer.invoke('get-sessions-root'),
  chooseSessionsRoot: () => ipcRenderer.invoke('choose-sessions-root'),
  setSessionMetadata: (metadata) => ipcRenderer.invoke('set-session-metadata', metadata),
  deleteSessionAudio: (sessionDir: string) => ipcRenderer.invoke('delete-session-audio', sessionDir),
  generateFollowUpEmail: (payload) => ipcRenderer.invoke('generate-followup-email', payload),
  onSession: (cb) => onChannel('session-started', cb),
  onTranscript: (cb) => onChannel('transcript-ready', cb),
  onTranscriptPartial: (cb) => onChannel('transcript-partial', cb),
  onTranscriptionStatus: (cb) => onChannel('transcription-status', cb),
  onRecordingReady: (cb) => onChannel('recording-ready', cb),
  onRecordingStarted: (cb) => onChannel('recording-started', cb),
  onSummary: (cb) => onChannel('summary-ready', cb),
  onSummaryStatus: (cb) => onChannel('summary-status', cb),
  onSummaryStream: (cb) => onChannel('summary-stream', cb),
  onBootstrapStatus: (cb) => onChannel('bootstrap-status', cb),
  processRecording: (payload) => ipcRenderer.invoke('process-recording', payload || {}),
  processTranscriptFile: (payload) => ipcRenderer.invoke('process-transcript-file', payload || {}),
  summarizeTranscriptText: (payload) => ipcRenderer.invoke('summarize-transcript-text', payload),
  processInputPath: (payload) => ipcRenderer.invoke('process-input-path', payload),
}

contextBridge.exposeInMainWorld('backend', backendApi)
