"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("backend", {
  start: (opts) => electron.ipcRenderer.send("backend-start", opts || {}),
  stop: () => electron.ipcRenderer.send("backend-stop"),
  pause: () => electron.ipcRenderer.send("backend-pause"),
  resume: () => electron.ipcRenderer.send("backend-resume"),
  listDevices: () => electron.ipcRenderer.invoke("list-devices"),
  getSessionsRoot: () => electron.ipcRenderer.invoke("get-sessions-root"),
  chooseSessionsRoot: () => electron.ipcRenderer.invoke("choose-sessions-root"),
  deleteSessionAudio: (sessionDir) => electron.ipcRenderer.invoke("delete-session-audio", sessionDir),
  generateFollowUpEmail: (payload) => electron.ipcRenderer.invoke("generate-followup-email", payload),
  onSession: (cb) => electron.ipcRenderer.on("session-started", cb),
  onTranscript: (cb) => electron.ipcRenderer.on("transcript-ready", cb),
  onTranscriptionStatus: (cb) => electron.ipcRenderer.on("transcription-status", cb),
  onSummary: (cb) => electron.ipcRenderer.on("summary-ready", cb),
  onSummaryStatus: (cb) => electron.ipcRenderer.on("summary-status", cb),
  onSummaryStream: (cb) => electron.ipcRenderer.on("summary-stream", cb),
  onBootstrapStatus: (cb) => electron.ipcRenderer.on("bootstrap-status", cb)
});
