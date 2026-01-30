"use strict";
const electron = require("electron");
const onChannel = (channel, cb) => {
  electron.ipcRenderer.on(channel, cb);
  return () => electron.ipcRenderer.removeListener(channel, cb);
};
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
  onSession: (cb) => onChannel("session-started", cb),
  onTranscript: (cb) => onChannel("transcript-ready", cb),
  onTranscriptPartial: (cb) => onChannel("transcript-partial", cb),
  onTranscriptionStatus: (cb) => onChannel("transcription-status", cb),
  onRecordingReady: (cb) => onChannel("recording-ready", cb),
  onRecordingStarted: (cb) => onChannel("recording-started", cb),
  onSummary: (cb) => onChannel("summary-ready", cb),
  onSummaryStatus: (cb) => onChannel("summary-status", cb),
  onSummaryStream: (cb) => onChannel("summary-stream", cb),
  onBootstrapStatus: (cb) => onChannel("bootstrap-status", cb)
});
