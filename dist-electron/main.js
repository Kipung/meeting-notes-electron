import { ipcMain, app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
const __dirname$1 = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname$1, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
let win;
let backendProcess = null;
let currentSessionDir = null;
let currentModelName = "small.en";
let transcriberProcess = null;
let transcriberStdoutBuf = "";
let summarizerProcess = null;
let summarizerStdoutBuf = "";
let currentSummaryModelPath = null;
let recordStdoutBuf = "";
let pendingChunkTranscriptions = 0;
let recordingStopped = false;
const DEFAULT_RECORD_CHUNK_SECS = 60;
function getRecordChunkSecs() {
  const raw = process.env["RECORD_CHUNK_SECS"];
  if (!raw) return DEFAULT_RECORD_CHUNK_SECS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}
function isChunkTranscriptPath(outPath) {
  return outPath.includes(`${path.sep}chunks${path.sep}`) && outPath.endsWith(".txt");
}
function finalizeTranscriptFromChunks(sessionDir) {
  const chunksDir = path.join(sessionDir, "chunks");
  const outPath = path.join(sessionDir, "transcript.txt");
  let combined = "";
  try {
    const files = fs.readdirSync(chunksDir).filter((f) => f.endsWith(".txt")).sort();
    for (const file of files) {
      const part = fs.readFileSync(path.join(chunksDir, file), "utf-8").trim();
      if (part) combined += (combined ? "\n" : "") + part;
    }
  } catch (e) {
    console.error("failed to assemble chunk transcripts", e);
  }
  try {
    fs.writeFileSync(outPath, combined);
  } catch (e) {
    console.error("failed to write combined transcript", e);
  }
  handleTranscriptReady(outPath, combined);
}
function resolveSummaryModelPath() {
  const override = process.env["SUMMODEL"];
  if (override && override.trim()) return override;
  const modelsDir = path.join(process.env.APP_ROOT, "models");
  const preferred = path.join(modelsDir, "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  if (fs.existsSync(preferred)) return preferred;
  try {
    const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
    const ggufs = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")).map((entry) => path.join(modelsDir, entry.name)).sort();
    if (ggufs.length > 0) return ggufs[0];
  } catch (e) {
    console.error("failed to scan models directory", e);
  }
  const ggmlBin = path.join(modelsDir, "ggml-model.bin");
  if (fs.existsSync(ggmlBin)) return ggmlBin;
  return null;
}
function startSummarizerIfNeeded(modelPath) {
  if (!modelPath) {
    console.error("summary model path not set");
    try {
      win == null ? void 0 : win.webContents.send("summary-status", { state: "error", sessionDir: currentSessionDir, message: "summary model not found" });
    } catch (e) {
      console.error("failed to send summary-status error", e);
    }
    return;
  }
  if (summarizerProcess) {
    if (currentSummaryModelPath && currentSummaryModelPath !== modelPath) {
      try {
        summarizerProcess.stdin.write(JSON.stringify({ cmd: "load_model", model_path: modelPath }) + "\n");
        currentSummaryModelPath = modelPath;
      } catch (e) {
        console.error("failed to send load_model to summarizer", e);
      }
    }
    return;
  }
  const script = path.join(process.env.APP_ROOT, "backend", "summarizer_daemon.py");
  summarizerProcess = spawn("python3", [script, "--model-path", modelPath], { stdio: ["pipe", "pipe", "pipe"] });
  currentSummaryModelPath = modelPath;
  summarizerProcess.stdout.on("data", (d) => {
    const s = d.toString();
    summarizerStdoutBuf += s;
    const parts = summarizerStdoutBuf.split("\n");
    summarizerStdoutBuf = parts.pop() || "";
    for (const line of parts) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.event === "done") {
          const summaryOut = obj.out;
          const summaryText = obj.text || "";
          try {
            win == null ? void 0 : win.webContents.send("summary-ready", { sessionDir: currentSessionDir, summaryPath: summaryOut, text: summaryText });
          } catch (e) {
            console.error("failed to send summary-ready", e);
          }
          try {
            win == null ? void 0 : win.webContents.send("summary-status", { state: "done", sessionDir: currentSessionDir, message: "summary complete" });
          } catch (e) {
            console.error("failed to send summary-status done", e);
          }
        } else if (obj.event === "loaded") {
          console.log("[summarizer] loaded", obj.model);
        } else if (obj.event === "progress") {
          console.log("[summarizer]", obj.msg);
          try {
            win == null ? void 0 : win.webContents.send("summary-status", { state: "running", sessionDir: currentSessionDir, message: obj.msg || "summarizing" });
          } catch (e) {
            console.error("failed to send summary-status running", e);
          }
        } else if (obj.event === "error") {
          console.error("[summarizer error]", obj.msg);
          try {
            win == null ? void 0 : win.webContents.send("summary-status", { state: "error", sessionDir: currentSessionDir, message: obj.msg || "summary error" });
          } catch (e) {
            console.error("failed to send summary-status error", e);
          }
        }
      } catch (e) {
        console.error("failed to parse summarizer stdout line", e, line);
      }
    }
  });
  summarizerProcess.stderr.on("data", (d) => console.error("[summarizer err]", d.toString().trim()));
  summarizerProcess.on("exit", (code) => {
    console.log("[summarizer] exited", code);
    summarizerProcess = null;
  });
}
function handleTranscriptReady(outPath, text) {
  try {
    win == null ? void 0 : win.webContents.send("transcript-ready", { sessionDir: currentSessionDir, transcriptPath: outPath, text });
  } catch (e) {
    console.error("failed to send transcript-ready", e);
  }
  try {
    win == null ? void 0 : win.webContents.send("transcription-status", { state: "done", sessionDir: currentSessionDir, message: "transcription complete" });
  } catch (e) {
    console.error("failed to send transcription-status done", e);
  }
  try {
    const modelPath = resolveSummaryModelPath();
    if (!modelPath || !fs.existsSync(modelPath)) {
      throw new Error("summary model not found");
    }
    startSummarizerIfNeeded(modelPath);
    const summaryOut = path.join(currentSessionDir || "", "summary.txt");
    try {
      win == null ? void 0 : win.webContents.send("summary-status", { state: "starting", sessionDir: currentSessionDir, message: "starting summarization" });
    } catch (e) {
      console.error("failed to send summary-status starting", e);
    }
    if (!summarizerProcess) throw new Error("summarizer not running");
    summarizerProcess.stdin.write(JSON.stringify({ cmd: "summarize", file: outPath, out: summaryOut }) + "\n");
  } catch (e) {
    console.error("failed to start summarizer", e);
    try {
      win == null ? void 0 : win.webContents.send("summary-status", { state: "error", sessionDir: currentSessionDir, message: "failed to start summarizer" });
    } catch (e2) {
      console.error("failed to send summary-status error", e2);
    }
  }
}
function queueChunkTranscription(chunkPath) {
  if (!transcriberProcess) {
    console.error("transcriber not running for chunk", chunkPath);
    return;
  }
  const chunkDir = path.dirname(chunkPath);
  const base = path.basename(chunkPath, path.extname(chunkPath));
  const outPath = path.join(chunkDir, `${base}.txt`);
  if (pendingChunkTranscriptions === 0) {
    try {
      win == null ? void 0 : win.webContents.send("transcription-status", { state: "starting", sessionDir: currentSessionDir, message: "starting transcription" });
    } catch (e) {
      console.error("failed to send transcription-status starting", e);
    }
  }
  pendingChunkTranscriptions += 1;
  try {
    transcriberProcess.stdin.write(JSON.stringify({ cmd: "transcribe", wav: chunkPath, out: outPath }) + "\n");
  } catch (e) {
    pendingChunkTranscriptions = Math.max(pendingChunkTranscriptions - 1, 0);
    console.error("failed to send transcribe command for chunk", e);
  }
}
function handleRecordOutput(data) {
  recordStdoutBuf += data.toString();
  const parts = recordStdoutBuf.split("\n");
  recordStdoutBuf = parts.pop() || "";
  for (const rawLine of parts) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.event === "chunk" && obj.path) {
        queueChunkTranscription(obj.path);
        continue;
      }
    } catch {
    }
    console.log("[backend]", line);
  }
}
function startTranscriberIfNeeded(modelName) {
  if (transcriberProcess) {
    if (modelName && modelName !== currentModelName) {
      try {
        transcriberProcess.stdin.write(JSON.stringify({ cmd: "load_model", model: modelName }) + "\n");
        currentModelName = modelName;
      } catch (e) {
        console.error("failed to send load_model to transcriber", e);
      }
    }
    return;
  }
  const script = path.join(process.env.APP_ROOT, "backend", "transcriber_daemon.py");
  transcriberProcess = spawn("python3", [script, "--model", modelName], { stdio: ["pipe", "pipe", "pipe"] });
  currentModelName = modelName;
  transcriberProcess.stdout.on("data", (d) => {
    const s = d.toString();
    transcriberStdoutBuf += s;
    const parts = transcriberStdoutBuf.split("\n");
    transcriberStdoutBuf = parts.pop() || "";
    for (const line of parts) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.event === "done") {
          const outPath = obj.out;
          const text = obj.text || "";
          if (outPath && isChunkTranscriptPath(outPath)) {
            pendingChunkTranscriptions = Math.max(pendingChunkTranscriptions - 1, 0);
            if (recordingStopped && pendingChunkTranscriptions === 0 && currentSessionDir) {
              finalizeTranscriptFromChunks(currentSessionDir);
            }
            continue;
          }
          handleTranscriptReady(outPath, text);
        } else if (obj.event === "loaded") {
          console.log("[transcriber] loaded", obj.model);
        } else if (obj.event === "progress") {
          console.log("[transcriber]", obj.msg);
          try {
            win == null ? void 0 : win.webContents.send("transcription-status", { state: "running", sessionDir: currentSessionDir, message: obj.msg || "transcribing" });
          } catch (e) {
            console.error("failed to send transcription-status running", e);
          }
        } else if (obj.event === "error") {
          console.error("[transcriber error]", obj.msg);
          try {
            win == null ? void 0 : win.webContents.send("transcription-status", { state: "error", sessionDir: currentSessionDir, message: obj.msg || "transcription error" });
          } catch (e) {
            console.error("failed to send transcription-status error", e);
          }
        }
      } catch (e) {
        console.error("failed to parse transcriber stdout line", e, line);
      }
    }
  });
  transcriberProcess.stderr.on("data", (d) => console.error("[transcriber err]", d.toString().trim()));
  transcriberProcess.on("exit", (code) => {
    console.log("[transcriber] exited", code);
    transcriberProcess = null;
  });
}
function makeSessionDir() {
  const sessionsRoot = path.join(process.env.APP_ROOT, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  const sessionDir = path.join(sessionsRoot, ts);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}
function startBackend() {
  if (backendProcess) {
    console.log("[backend] already running");
    return;
  }
  recordStdoutBuf = "";
  pendingChunkTranscriptions = 0;
  recordingStopped = false;
  const sessionDir = makeSessionDir();
  currentSessionDir = sessionDir;
  const outWav = path.join(sessionDir, "audio.wav");
  console.log("[backend] sessionDir=", sessionDir);
  try {
    win == null ? void 0 : win.webContents.send("session-started", { sessionDir });
  } catch (e) {
    console.error("failed to send session-started", e);
  }
  startSummarizerIfNeeded(resolveSummaryModelPath());
  const scriptPath = path.join(process.env.APP_ROOT, "backend", "record.py");
  const args = [scriptPath, "--out", outWav];
  const chunkSecs = getRecordChunkSecs();
  if (chunkSecs > 0) {
    args.push("--chunk-secs", String(chunkSecs));
  }
  startTranscriberIfNeeded(currentModelName);
  startSummarizerIfNeeded(resolveSummaryModelPath());
  backendProcess = spawn("python3", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  backendProcess.stdout.on("data", (data) => {
    handleRecordOutput(data);
  });
  backendProcess.stderr.on("data", (data) => {
    console.error("[backend err]", data.toString().trim());
  });
  backendProcess.on("exit", (code) => {
    console.log("[backend] exited with code", code);
    backendProcess = null;
  });
}
function stopBackend() {
  if (!backendProcess) {
    console.log("[backend] not running");
    return;
  }
  backendProcess.kill("SIGTERM");
  backendProcess = null;
  console.log("[backend] stop signal sent");
  if (currentSessionDir) {
    const wavPath = path.join(currentSessionDir, "audio.wav");
    const outPath = path.join(currentSessionDir, "transcript.txt");
    recordingStopped = true;
    const chunkSecs = getRecordChunkSecs();
    if (chunkSecs > 0 && transcriberProcess) {
      return;
    }
    if (transcriberProcess) {
      try {
        try {
          win == null ? void 0 : win.webContents.send("transcription-status", { state: "starting", sessionDir: currentSessionDir, message: "starting transcription" });
        } catch (e) {
          console.error("failed to send transcription-status starting", e);
        }
        transcriberProcess.stdin.write(JSON.stringify({ cmd: "transcribe", wav: wavPath, out: outPath }) + "\n");
      } catch (e) {
        console.error("failed to send transcribe command to daemon", e);
      }
    } else {
      const transScript = path.join(process.env.APP_ROOT, "backend", "transcribe.py");
      const model = currentModelName || "small.en";
      try {
        win == null ? void 0 : win.webContents.send("transcription-status", { state: "starting", sessionDir: currentSessionDir, message: "starting transcription" });
      } catch (e) {
        console.error("failed to send transcription-status starting", e);
      }
      const tproc = spawn("python3", [transScript, "--wav", wavPath, "--model", model, "--out", outPath], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let buf = "";
      tproc.stdout.on("data", (data) => {
        buf += data.toString();
        console.log("[transcribe]", data.toString().trim());
      });
      tproc.stderr.on("data", (data) => {
        console.error("[transcribe err]", data.toString().trim());
      });
      tproc.on("exit", (code) => {
        console.log("[transcribe] exited", code);
        let text = "";
        try {
          text = fs.readFileSync(outPath, "utf-8");
        } catch (e) {
          text = buf;
        }
        try {
          win == null ? void 0 : win.webContents.send("transcript-ready", { sessionDir: currentSessionDir, transcriptPath: outPath, text });
        } catch (e) {
          console.error("failed to send transcript-ready", e);
        }
        try {
          const state = code === 0 ? "done" : "error";
          win == null ? void 0 : win.webContents.send("transcription-status", { state, sessionDir: currentSessionDir, message: code === 0 ? "transcription complete" : "transcription failed" });
        } catch (e) {
          console.error("failed to send transcription-status exit", e);
        }
        currentSessionDir = null;
      });
    }
  }
}
ipcMain.on("backend-start", (evt, opts = {}) => {
  console.log("[ipc] backend-start", opts);
  if (opts && opts.model) currentModelName = opts.model;
  if (backendProcess) {
    console.log("[backend] already running");
    return;
  }
  recordStdoutBuf = "";
  pendingChunkTranscriptions = 0;
  recordingStopped = false;
  const sessionDir = makeSessionDir();
  currentSessionDir = sessionDir;
  const outWav = path.join(sessionDir, "audio.wav");
  console.log("[backend] sessionDir=", sessionDir);
  try {
    win == null ? void 0 : win.webContents.send("session-started", { sessionDir });
  } catch (e) {
    console.error("failed to send session-started", e);
  }
  const scriptPath = path.join(process.env.APP_ROOT, "backend", "record.py");
  const args = [scriptPath, "--out", outWav];
  if (opts && typeof opts.deviceIndex === "number") {
    args.push("--device-index", String(opts.deviceIndex));
  }
  const chunkSecs = getRecordChunkSecs();
  if (chunkSecs > 0) {
    args.push("--chunk-secs", String(chunkSecs));
  }
  startTranscriberIfNeeded(currentModelName);
  startSummarizerIfNeeded(resolveSummaryModelPath());
  backendProcess = spawn("python3", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  backendProcess.stdout.on("data", (data) => {
    handleRecordOutput(data);
  });
  backendProcess.stderr.on("data", (data) => {
    console.error("[backend err]", data.toString().trim());
  });
  backendProcess.on("exit", (code) => {
    console.log("[backend] exited with code", code);
    backendProcess = null;
  });
});
ipcMain.on("backend-stop", () => {
  console.log("[ipc] backend-stop");
  stopBackend();
});
ipcMain.handle("list-devices", async () => {
  const script = path.join(process.env.APP_ROOT, "backend", "devices.py");
  return new Promise((resolve) => {
    const p = spawn("python3", [script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => out += d.toString());
    p.stderr.on("data", (d) => console.error("[devices err]", d.toString().trim()));
    p.on("exit", () => {
      try {
        const json = JSON.parse(out || "{}");
        resolve(json);
      } catch (e) {
        resolve({ error: "failed to parse devices", raw: out });
      }
    });
  });
});
function createWindow() {
  win = new BrowserWindow({
    width: 1e3,
    height: 700,
    icon: path.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: path.join(__dirname$1, "preload.mjs")
    }
  });
  win.webContents.on("did-finish-load", () => {
    win == null ? void 0 : win.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString());
  });
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}
app.whenReady().then(() => {
  createWindow();
});
app.on("window-all-closed", () => {
  win = null;
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    startBackend();
  }
});
app.on("before-quit", () => {
  stopBackend();
  if (transcriberProcess) {
    try {
      transcriberProcess.kill("SIGTERM");
    } catch (e) {
      console.error("failed to kill transcriber", e);
    }
    transcriberProcess = null;
  }
  if (summarizerProcess) {
    try {
      summarizerProcess.kill("SIGTERM");
    } catch (e) {
      console.error("failed to kill summarizer", e);
    }
    summarizerProcess = null;
  }
});
export {
  MAIN_DIST,
  RENDERER_DIST,
  VITE_DEV_SERVER_URL
};
