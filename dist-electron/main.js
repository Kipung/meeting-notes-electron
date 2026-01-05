import { ipcMain as H, app as b, BrowserWindow as J } from "electron";
import { spawn as v } from "node:child_process";
import { fileURLToPath as ce } from "node:url";
import u from "node:fs";
import i from "node:path";
import le from "node:http";
import de from "node:https";
const V = i.dirname(ce(import.meta.url));
process.env.APP_ROOT = i.join(V, "..");
const U = process.env.VITE_DEV_SERVER_URL, Ne = i.join(process.env.APP_ROOT, "dist-electron"), Y = i.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = U ? i.join(process.env.APP_ROOT, "public") : Y;
const ue = "https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf";
let n, p = null, m = null, x = "small.en", g = null, F = "", h = null, A = "", L = null, T = "", S = 0, B = !1, N = "idle", R = null, O = null;
const me = 60;
function C() {
  return b.getPath("userData");
}
function fe() {
  return i.join(C(), "sessions");
}
function K() {
  return i.join(C(), "models");
}
function pe() {
  return i.join(process.resourcesPath, "models");
}
function q() {
  return i.join(C(), "whisper");
}
function ge() {
  return i.join(process.resourcesPath, "whisper");
}
function ye() {
  return i.join(process.resourcesPath, "ffmpeg");
}
function he() {
  return i.join(process.resourcesPath, "lib");
}
function be(e) {
  return process.platform === "win32" ? i.join(e, "ffmpeg.exe") : i.join(e, "ffmpeg");
}
function Q() {
  const e = process.env.FFMPEG_PATH;
  if (e && e.trim() && u.existsSync(e)) return e;
  const r = be(ye());
  return u.existsSync(r) ? r : null;
}
function E() {
  const e = process.env.BACKEND_ROOT;
  if (e && e.trim()) return e;
  const r = i.join(C(), "backend");
  if (u.existsSync(r)) return r;
  const t = i.join(process.resourcesPath, "backend");
  return u.existsSync(t) ? t : i.join(process.env.APP_ROOT, "backend");
}
function X() {
  return process.platform === "win32" ? i.join(process.resourcesPath, "python", "python.exe") : i.join(process.resourcesPath, "python", "bin", "python3");
}
function Z() {
  return process.platform === "win32" ? i.join(C(), "python", "python.exe") : i.join(C(), "python", "bin", "python3");
}
function P() {
  const e = process.env.MEETING_NOTES_PYTHON;
  if (e && e.trim()) return e;
  const r = X();
  if (u.existsSync(r)) return r;
  const t = Z();
  return u.existsSync(t) ? t : process.platform === "win32" ? "python" : "python3";
}
function _() {
  const e = { ...process.env, WHISPER_ROOT: q() }, r = Q();
  if (r) {
    e.FFMPEG_PATH = e.FFMPEG_PATH || r;
    const t = i.dirname(r);
    e.PATH = [t, e.PATH || ""].filter(Boolean).join(i.delimiter);
  }
  if (process.platform === "darwin") {
    const t = he();
    u.existsSync(t) && (e.DYLD_LIBRARY_PATH = [t, e.DYLD_LIBRARY_PATH || ""].filter(Boolean).join(i.delimiter));
  }
  return e;
}
function $() {
  const e = process.env.RECORD_CHUNK_SECS;
  if (!e) return me;
  const r = Number(e);
  return !Number.isFinite(r) || r <= 0 ? 0 : Math.floor(r);
}
function Se(e) {
  return e.includes(`${i.sep}chunks${i.sep}`) && e.endsWith(".txt");
}
function D(e, r, t) {
  try {
    n == null || n.webContents.send("bootstrap-status", { state: e, message: r, percent: t });
  } catch (s) {
    console.error("failed to send bootstrap-status", s);
  }
}
function I(e, r, t) {
  if (!(e != null && e.stdin))
    return console.error(`[${r}] stdin not available`), !1;
  try {
    return e.stdin.write(t), !0;
  } catch (s) {
    return console.error(`[${r}] failed to write`, s), !1;
  }
}
function ve(e) {
  return e.startsWith("https:") ? de : le;
}
function ee(e, r, t, s = 0) {
  return s > 5 ? Promise.reject(new Error("too many redirects")) : new Promise((a, l) => {
    ve(e).get(e, (d) => {
      if (d.statusCode && d.statusCode >= 300 && d.statusCode < 400 && d.headers.location) {
        d.resume(), a(ee(d.headers.location, r, t, s + 1));
        return;
      }
      if (d.statusCode !== 200) {
        d.resume(), l(new Error(`download failed with status ${d.statusCode}`));
        return;
      }
      u.mkdirSync(i.dirname(r), { recursive: !0 });
      const f = `${r}.partial`, w = u.createWriteStream(f);
      let j = 0;
      const k = Number(d.headers["content-length"] || 0);
      d.on("data", (y) => {
        if (j += y.length, t)
          if (k > 0) {
            const ae = Math.min(100, Math.round(j / k * 100));
            t({ downloaded: j, total: k, percent: ae });
          } else
            t({ downloaded: j });
      }), d.on("error", (y) => {
        w.close(() => {
        });
        try {
          u.unlinkSync(f);
        } catch {
        }
        l(y);
      }), w.on("error", (y) => {
        d.destroy();
        try {
          u.unlinkSync(f);
        } catch {
        }
        l(y);
      }), w.on("finish", () => {
        w.close(() => {
          u.rename(f, r, (y) => {
            y ? l(y) : a();
          });
        });
      }), d.pipe(w);
    }).on("error", l);
  });
}
async function G(e) {
  return new Promise((r, t) => {
    const s = v(e, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    s.on("error", (a) => t(a)), s.on("exit", (a) => {
      a === 0 ? r() : t(new Error(`python exited with ${a}`));
    });
  });
}
async function we() {
  if (!Q()) {
    if (b.isPackaged)
      throw new Error("ffmpeg missing in installer");
    await new Promise((r, t) => {
      const s = v("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
      s.on("error", (a) => t(a)), s.on("exit", (a) => {
        a === 0 ? r() : t(new Error("ffmpeg not available on PATH"));
      });
    });
  }
}
async function Pe() {
  const e = process.env.MEETING_NOTES_PYTHON;
  if (e && e.trim()) {
    if ((e.includes(i.sep) || e.includes("/")) && !u.existsSync(e))
      throw new Error(`MEETING_NOTES_PYTHON not found at ${e}`);
    await G(e);
    return;
  }
  if (!u.existsSync(X()) && !u.existsSync(Z())) {
    if (b.isPackaged)
      throw new Error("bundled python runtime missing in installer");
    await G(P());
  }
}
async function ke(e, r) {
  const t = i.join(E(), "setup.py");
  return new Promise((s, a) => {
    var c, d;
    const l = v(P(), [t, "--whisper-model", e, "--whisper-dir", r], {
      stdio: ["ignore", "pipe", "pipe"],
      env: _()
    });
    let o = "";
    (c = l.stdout) == null || c.on("data", (f) => {
      o += f.toString();
      const w = o.split(`
`);
      o = w.pop() || "";
      for (const j of w) {
        const k = j.trim();
        if (k)
          try {
            const y = JSON.parse(k);
            y.event === "status" ? D("running", y.message || "running setup") : y.event === "done" ? D("running", y.message || "setup complete") : y.event === "error" && D("error", y.message || "setup failed");
          } catch {
            console.log("[setup]", k);
          }
      }
    }), (d = l.stderr) == null || d.on("data", (f) => console.error("[setup err]", f.toString().trim())), l.on("error", (f) => a(f)), l.on("exit", (f) => {
      f === 0 ? s() : a(new Error(`setup failed with code ${f}`));
    });
  });
}
async function xe() {
  const e = process.env.WHISPER_MODEL || "small.en", r = q(), t = i.join(r, `${e}.pt`);
  if (u.existsSync(t)) return;
  const s = i.join(ge(), `${e}.pt`);
  if (u.existsSync(s)) {
    u.mkdirSync(r, { recursive: !0 }), u.copyFileSync(s, t);
    return;
  }
  if (b.isPackaged)
    throw new Error(`whisper model missing in installer: ${e}.pt`);
  await ke(e, r);
}
function M() {
  const e = process.env.SUMMODEL;
  if (e && e.trim()) return e;
  if (O && u.existsSync(O)) return O;
  const r = [K(), pe(), i.join(process.env.APP_ROOT, "models")];
  for (const t of r) {
    if (!u.existsSync(t)) continue;
    const s = i.join(t, "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
    if (u.existsSync(s)) return s;
    try {
      const o = u.readdirSync(t, { withFileTypes: !0 }).filter((c) => c.isFile() && c.name.toLowerCase().endsWith(".gguf")).map((c) => i.join(t, c.name)).sort();
      if (o.length > 0) return o[0];
    } catch (l) {
      console.error("failed to scan models directory", l);
    }
    const a = i.join(t, "ggml-model.bin");
    if (u.existsSync(a)) return a;
  }
  return null;
}
async function De() {
  const e = process.env.SUMMODEL;
  if (e && e.trim()) {
    if (!u.existsSync(e))
      throw new Error(`summary model not found at ${e}`);
    return e;
  }
  const r = M();
  if (r && u.existsSync(r))
    return O = r, r;
  if (b.isPackaged)
    throw new Error("summary model missing in installer");
  const t = process.env.SUMMODEL_URL || ue, s = K();
  let a = "Llama-3.2-3B-Instruct-Q4_K_M.gguf";
  try {
    const o = new URL(t), c = i.basename(o.pathname);
    c && (a = c);
  } catch {
  }
  const l = i.join(s, a);
  return D("running", "downloading summary model", 0), await ee(t, l, (o) => {
    typeof o.percent == "number" && D("running", "downloading summary model", o.percent);
  }), O = l, l;
}
async function W() {
  return N === "done" ? !0 : R || (N = "running", R = (async () => {
    try {
      return await we(), await Pe(), await xe(), await De(), N = "done", D("done", "ready", 100), !0;
    } catch (e) {
      N = "error";
      const r = e instanceof Error ? e.message : "setup failed";
      return D("error", r), !1;
    } finally {
      R = null;
    }
  })(), R);
}
function Ee(e) {
  const r = i.join(e, "chunks"), t = i.join(e, "transcript.txt");
  let s = "";
  try {
    const a = u.readdirSync(r).filter((l) => l.endsWith(".txt")).sort();
    for (const l of a) {
      const o = u.readFileSync(i.join(r, l), "utf-8").trim();
      o && (s += (s ? `
` : "") + o);
    }
  } catch (a) {
    console.error("failed to assemble chunk transcripts", a);
  }
  try {
    u.writeFileSync(t, s);
  } catch (a) {
    console.error("failed to write combined transcript", a);
  }
  te(t, s);
}
function z(e) {
  if (!e) {
    console.error("summary model path not set");
    try {
      n == null || n.webContents.send("summary-status", { state: "error", sessionDir: m, message: "summary model not found" });
    } catch (t) {
      console.error("failed to send summary-status error", t);
    }
    return;
  }
  if (h) {
    L && L !== e && I(h, "summarizer", JSON.stringify({ cmd: "load_model", model_path: e }) + `
`) && (L = e);
    return;
  }
  const r = i.join(E(), "summarizer_daemon.py");
  h = v(P(), [r, "--model-path", e], { stdio: ["pipe", "pipe", "pipe"], env: _() }), L = e, h.stdout ? h.stdout.on("data", (t) => {
    const s = t.toString();
    A += s;
    const a = A.split(`
`);
    A = a.pop() || "";
    for (const l of a)
      if (l)
        try {
          const o = JSON.parse(l);
          if (o.event === "done") {
            const c = o.out, d = o.text || "";
            try {
              n == null || n.webContents.send("summary-ready", { sessionDir: m, summaryPath: c, text: d });
            } catch (f) {
              console.error("failed to send summary-ready", f);
            }
            try {
              n == null || n.webContents.send("summary-status", { state: "done", sessionDir: m, message: "summary complete" });
            } catch (f) {
              console.error("failed to send summary-status done", f);
            }
          } else if (o.event === "loaded")
            console.log("[summarizer] loaded", o.model);
          else if (o.event === "progress") {
            console.log("[summarizer]", o.msg);
            try {
              n == null || n.webContents.send("summary-status", { state: "running", sessionDir: m, message: o.msg || "summarizing" });
            } catch (c) {
              console.error("failed to send summary-status running", c);
            }
          } else if (o.event === "error") {
            console.error("[summarizer error]", o.msg);
            try {
              n == null || n.webContents.send("summary-status", { state: "error", sessionDir: m, message: o.msg || "summary error" });
            } catch (c) {
              console.error("failed to send summary-status error", c);
            }
          }
        } catch (o) {
          console.error("failed to parse summarizer stdout line", o, l);
        }
  }) : console.error("[summarizer] stdout not available"), h.stderr ? h.stderr.on("data", (t) => console.error("[summarizer err]", t.toString().trim())) : console.error("[summarizer] stderr not available"), h.on("error", (t) => {
    console.error("[summarizer spawn error]", t);
    try {
      n == null || n.webContents.send("summary-status", { state: "error", sessionDir: m, message: "failed to start summarizer" });
    } catch (s) {
      console.error("failed to send summary-status spawn error", s);
    }
  }), h.on("exit", (t) => {
    console.log("[summarizer] exited", t), h = null;
  });
}
function te(e, r) {
  try {
    n == null || n.webContents.send("transcript-ready", { sessionDir: m, transcriptPath: e, text: r });
  } catch (t) {
    console.error("failed to send transcript-ready", t);
  }
  try {
    n == null || n.webContents.send("transcription-status", { state: "done", sessionDir: m, message: "transcription complete" });
  } catch (t) {
    console.error("failed to send transcription-status done", t);
  }
  try {
    const t = M();
    if (!t || !u.existsSync(t))
      throw new Error("summary model not found");
    z(t);
    const s = i.join(m || "", "summary.txt");
    try {
      n == null || n.webContents.send("summary-status", { state: "starting", sessionDir: m, message: "starting summarization" });
    } catch (a) {
      console.error("failed to send summary-status starting", a);
    }
    if (!h) throw new Error("summarizer not running");
    if (!I(h, "summarizer", JSON.stringify({ cmd: "summarize", file: e, out: s }) + `
`))
      throw new Error("summarizer stdin not available");
  } catch (t) {
    console.error("failed to start summarizer", t);
    try {
      n == null || n.webContents.send("summary-status", { state: "error", sessionDir: m, message: "failed to start summarizer" });
    } catch (s) {
      console.error("failed to send summary-status error", s);
    }
  }
}
function _e(e) {
  if (!g) {
    console.error("transcriber not running for chunk", e);
    return;
  }
  const r = i.dirname(e), t = i.basename(e, i.extname(e)), s = i.join(r, `${t}.txt`);
  if (S === 0)
    try {
      n == null || n.webContents.send("transcription-status", { state: "starting", sessionDir: m, message: "starting transcription" });
    } catch (l) {
      console.error("failed to send transcription-status starting", l);
    }
  S += 1, I(g, "transcriber", JSON.stringify({ cmd: "transcribe", wav: e, out: s }) + `
`) || (S = Math.max(S - 1, 0));
}
function re(e) {
  T += e.toString();
  const r = T.split(`
`);
  T = r.pop() || "";
  for (const t of r) {
    const s = t.trim();
    if (s) {
      try {
        const a = JSON.parse(s);
        if (a.event === "chunk" && a.path) {
          _e(a.path);
          continue;
        }
      } catch {
      }
      console.log("[backend]", s);
    }
  }
}
function ne(e) {
  if (g) {
    e && e !== x && I(g, "transcriber", JSON.stringify({ cmd: "load_model", model: e }) + `
`) && (x = e);
    return;
  }
  const r = i.join(E(), "transcriber_daemon.py");
  g = v(P(), [r, "--model", e], { stdio: ["pipe", "pipe", "pipe"], env: _() }), x = e, g.stdout ? g.stdout.on("data", (t) => {
    const s = t.toString();
    F += s;
    const a = F.split(`
`);
    F = a.pop() || "";
    for (const l of a)
      if (l)
        try {
          const o = JSON.parse(l);
          if (o.event === "done") {
            const c = o.out, d = o.text || "";
            if (c && Se(c)) {
              S = Math.max(S - 1, 0), B && S === 0 && m && Ee(m);
              continue;
            }
            te(c, d);
          } else if (o.event === "loaded")
            console.log("[transcriber] loaded", o.model);
          else if (o.event === "progress") {
            console.log("[transcriber]", o.msg);
            try {
              n == null || n.webContents.send("transcription-status", { state: "running", sessionDir: m, message: o.msg || "transcribing" });
            } catch (c) {
              console.error("failed to send transcription-status running", c);
            }
          } else if (o.event === "error") {
            console.error("[transcriber error]", o.msg);
            try {
              n == null || n.webContents.send("transcription-status", { state: "error", sessionDir: m, message: o.msg || "transcription error" });
            } catch (c) {
              console.error("failed to send transcription-status error", c);
            }
          }
        } catch (o) {
          console.error("failed to parse transcriber stdout line", o, l);
        }
  }) : console.error("[transcriber] stdout not available"), g.stderr ? g.stderr.on("data", (t) => console.error("[transcriber err]", t.toString().trim())) : console.error("[transcriber] stderr not available"), g.on("error", (t) => {
    console.error("[transcriber spawn error]", t);
    try {
      n == null || n.webContents.send("transcription-status", { state: "error", sessionDir: m, message: "failed to start transcriber" });
    } catch (s) {
      console.error("failed to send transcription-status spawn error", s);
    }
  }), g.on("exit", (t) => {
    console.log("[transcriber] exited", t), g = null;
  });
}
function se() {
  const e = fe();
  u.mkdirSync(e, { recursive: !0 });
  const r = (/* @__PURE__ */ new Date()).toISOString().replace(/[:]/g, "-").replace(/\..+$/, ""), t = i.join(e, r);
  return u.mkdirSync(t, { recursive: !0 }), t;
}
async function je() {
  if (p) {
    console.log("[backend] already running");
    return;
  }
  if (!await W()) return;
  T = "", S = 0, B = !1;
  const r = se();
  m = r;
  const t = i.join(r, "audio.wav");
  console.log("[backend] sessionDir=", r);
  try {
    n == null || n.webContents.send("session-started", { sessionDir: r });
  } catch (o) {
    console.error("failed to send session-started", o);
  }
  z(M());
  const a = [i.join(E(), "record.py"), "--out", t], l = $();
  l > 0 && a.push("--chunk-secs", String(l)), ne(x), z(M()), p = v(P(), a, {
    stdio: ["ignore", "pipe", "pipe"],
    env: _()
  }), p.stdout ? p.stdout.on("data", (o) => {
    re(o);
  }) : console.error("[backend] stdout not available"), p.stderr ? p.stderr.on("data", (o) => {
    console.error("[backend err]", o.toString().trim());
  }) : console.error("[backend] stderr not available"), p.on("error", (o) => {
    console.error("[backend spawn error]", o);
    try {
      n == null || n.webContents.send("transcription-status", { state: "error", sessionDir: m, message: "failed to start recorder" });
    } catch (c) {
      console.error("failed to send transcription-status spawn error", c);
    }
  }), p.on("exit", (o) => {
    console.log("[backend] exited with code", o), p = null;
  });
}
function oe() {
  if (!p) {
    console.log("[backend] not running");
    return;
  }
  if (p.kill("SIGTERM"), p = null, console.log("[backend] stop signal sent"), m) {
    const e = i.join(m, "audio.wav"), r = i.join(m, "transcript.txt");
    if (B = !0, $() > 0 && g)
      return;
    if (g)
      try {
        try {
          n == null || n.webContents.send("transcription-status", { state: "starting", sessionDir: m, message: "starting transcription" });
        } catch (s) {
          console.error("failed to send transcription-status starting", s);
        }
        I(g, "transcriber", JSON.stringify({ cmd: "transcribe", wav: e, out: r }) + `
`);
      } catch (s) {
        console.error("failed to send transcribe command to daemon", s);
      }
    else {
      const s = i.join(E(), "transcribe.py"), a = x || "small.en";
      try {
        n == null || n.webContents.send("transcription-status", { state: "starting", sessionDir: m, message: "starting transcription" });
      } catch (c) {
        console.error("failed to send transcription-status starting", c);
      }
      const l = v(P(), [s, "--wav", e, "--model", a, "--out", r], {
        stdio: ["ignore", "pipe", "pipe"],
        env: _()
      });
      let o = "";
      l.stdout.on("data", (c) => {
        o += c.toString(), console.log("[transcribe]", c.toString().trim());
      }), l.stderr.on("data", (c) => {
        console.error("[transcribe err]", c.toString().trim());
      }), l.on("exit", (c) => {
        console.log("[transcribe] exited", c);
        let d = "";
        try {
          d = u.readFileSync(r, "utf-8");
        } catch {
          d = o;
        }
        try {
          n == null || n.webContents.send("transcript-ready", { sessionDir: m, transcriptPath: r, text: d });
        } catch (f) {
          console.error("failed to send transcript-ready", f);
        }
        try {
          const f = c === 0 ? "done" : "error";
          n == null || n.webContents.send("transcription-status", { state: f, sessionDir: m, message: c === 0 ? "transcription complete" : "transcription failed" });
        } catch (f) {
          console.error("failed to send transcription-status exit", f);
        }
        m = null;
      });
    }
  }
}
H.on("backend-start", (e, r = {}) => {
  (async () => {
    if (console.log("[ipc] backend-start", r), r && r.model && (x = r.model), p) {
      console.log("[backend] already running");
      return;
    }
    if (!await W()) return;
    T = "", S = 0, B = !1;
    const s = se();
    m = s;
    const a = i.join(s, "audio.wav");
    console.log("[backend] sessionDir=", s);
    try {
      n == null || n.webContents.send("session-started", { sessionDir: s });
    } catch (d) {
      console.error("failed to send session-started", d);
    }
    const o = [i.join(E(), "record.py"), "--out", a];
    r && typeof r.deviceIndex == "number" && o.push("--device-index", String(r.deviceIndex));
    const c = $();
    c > 0 && o.push("--chunk-secs", String(c)), ne(x), z(M()), p = v(P(), o, {
      stdio: ["ignore", "pipe", "pipe"],
      env: _()
    }), p.stdout ? p.stdout.on("data", (d) => {
      re(d);
    }) : console.error("[backend] stdout not available"), p.stderr ? p.stderr.on("data", (d) => {
      console.error("[backend err]", d.toString().trim());
    }) : console.error("[backend] stderr not available"), p.on("error", (d) => {
      console.error("[backend spawn error]", d);
      try {
        n == null || n.webContents.send("transcription-status", { state: "error", sessionDir: m, message: "failed to start recorder" });
      } catch (f) {
        console.error("failed to send transcription-status spawn error", f);
      }
    }), p.on("exit", (d) => {
      console.log("[backend] exited with code", d), p = null;
    });
  })();
});
H.on("backend-stop", () => {
  console.log("[ipc] backend-stop"), oe();
});
H.handle("list-devices", async () => {
  const e = i.join(E(), "devices.py");
  return new Promise((r) => {
    const t = v(P(), [e], { stdio: ["ignore", "pipe", "pipe"], env: _() });
    let s = "";
    t.stdout.on("data", (a) => s += a.toString()), t.stderr.on("data", (a) => console.error("[devices err]", a.toString().trim())), t.on("exit", () => {
      try {
        const a = JSON.parse(s || "{}");
        r(a);
      } catch {
        r({ error: "failed to parse devices", raw: s });
      }
    });
  });
});
function ie() {
  n = new J({
    width: 1e3,
    height: 700,
    icon: i.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: i.join(V, "preload.mjs")
    }
  }), n.webContents.on("did-finish-load", () => {
    n == null || n.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString()), W();
  }), U ? n.loadURL(U) : n.loadFile(i.join(Y, "index.html"));
}
b.whenReady().then(() => {
  ie();
});
b.on("window-all-closed", () => {
  n = null, process.platform !== "darwin" && b.quit();
});
b.on("activate", () => {
  J.getAllWindows().length === 0 && (ie(), je());
});
b.on("before-quit", () => {
  if (oe(), g) {
    try {
      g.kill("SIGTERM");
    } catch (e) {
      console.error("failed to kill transcriber", e);
    }
    g = null;
  }
  if (h) {
    try {
      h.kill("SIGTERM");
    } catch (e) {
      console.error("failed to kill summarizer", e);
    }
    h = null;
  }
});
export {
  Ne as MAIN_DIST,
  Y as RENDERER_DIST,
  U as VITE_DEV_SERVER_URL
};
