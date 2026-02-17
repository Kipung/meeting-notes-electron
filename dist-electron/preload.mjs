"use strict";
const electron = require("electron");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const electron__namespace = /* @__PURE__ */ _interopNamespaceDefault(electron);
const { contextBridge, ipcRenderer } = electron__namespace;
const onChannel = (channel, cb) => {
  ipcRenderer.on(channel, cb);
  return () => ipcRenderer.removeListener(channel, cb);
};
contextBridge.exposeInMainWorld("backend", {
  start: (opts) => ipcRenderer.send("backend-start", opts || {}),
  stop: () => ipcRenderer.send("backend-stop"),
  pause: () => ipcRenderer.send("backend-pause"),
  resume: () => ipcRenderer.send("backend-resume"),
  listDevices: () => ipcRenderer.invoke("list-devices"),
  getSessionsRoot: () => ipcRenderer.invoke("get-sessions-root"),
  chooseSessionsRoot: () => ipcRenderer.invoke("choose-sessions-root"),
  deleteSessionAudio: (sessionDir) => ipcRenderer.invoke("delete-session-audio", sessionDir),
  generateFollowUpEmail: (payload) => ipcRenderer.invoke("generate-followup-email", payload),
  onSession: (cb) => onChannel("session-started", cb),
  onTranscript: (cb) => onChannel("transcript-ready", cb),
  onTranscriptPartial: (cb) => onChannel("transcript-partial", cb),
  onTranscriptionStatus: (cb) => onChannel("transcription-status", cb),
  onRecordingReady: (cb) => onChannel("recording-ready", cb),
  onRecordingStarted: (cb) => onChannel("recording-started", cb),
  onSummary: (cb) => onChannel("summary-ready", cb),
  onSummaryStatus: (cb) => onChannel("summary-status", cb),
  onSummaryStream: (cb) => onChannel("summary-stream", cb),
  onBootstrapStatus: (cb) => onChannel("bootstrap-status", cb),
  processRecording: () => ipcRenderer.invoke("process-recording"),
  processTranscriptFile: () => ipcRenderer.invoke("process-transcript-file"),
  summarizeTranscriptText: (text) => ipcRenderer.invoke("summarize-transcript-text", { text }),
  processInputPath: (inputPath) => ipcRenderer.invoke("process-input-path", inputPath)
});
