"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("backend", {
  start: (opts) => electron.ipcRenderer.send("backend-start", opts || {}),
  stop: () => electron.ipcRenderer.send("backend-stop"),
  listDevices: () => electron.ipcRenderer.invoke("list-devices"),
  onSession: (cb) => electron.ipcRenderer.on("session-started", cb),
  onRecordingStatus: (cb) => electron.ipcRenderer.on("recording-status", cb),
  onTranscript: (cb) => electron.ipcRenderer.on("transcript-ready", cb),
  onTranscriptionStatus: (cb) => electron.ipcRenderer.on("transcription-status", cb),
  onSummary: (cb) => electron.ipcRenderer.on("summary-ready", cb),
  onSummaryStatus: (cb) => electron.ipcRenderer.on("summary-status", cb),
  onBootstrapStatus: (cb) => electron.ipcRenderer.on("bootstrap-status", cb)
});
