import { ipcMain as P, dialog as te, app as b, BrowserWindow as le } from "electron";
import { spawn as O } from "node:child_process";
import { fileURLToPath as Oe } from "node:url";
import { randomUUID as Re } from "node:crypto";
import d from "node:fs";
import i from "node:path";
import Te from "node:http";
import Le from "node:https";
const ue = i.dirname(Oe(import.meta.url));
process.env.APP_ROOT = i.join(ue, "..");
const re = process.env.VITE_DEV_SERVER_URL, yt = i.join(process.env.APP_ROOT, "dist-electron"), de = i.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = re ? i.join(process.env.APP_ROOT, "public") : de;
const R = "Llama-3.2-1B-Instruct-Q6_K.gguf";
let o, h = null, v = null, ne = "small.en", S = null, ee = "", U = null, q = "", H = "idle", I = null, N = null;
const w = /* @__PURE__ */ new Map(), oe = 600;
let L = [], C = !1, fe = 0, se = /* @__PURE__ */ new Map(), J = 0, G = "", K = !1, z = null, T = !1, Q = null, E = null, D = null, W = "";
function M() {
  return b.getPath("userData");
}
function me() {
  return i.join(M(), "settings.json");
}
function pe() {
  const e = me();
  if (!d.existsSync(e)) return {};
  try {
    const t = d.readFileSync(e, "utf-8"), r = JSON.parse(t);
    return !r || typeof r != "object" ? {} : r;
  } catch (t) {
    return console.error("failed to read settings", t), {};
  }
}
function Ce(e) {
  const t = me();
  d.mkdirSync(i.dirname(t), { recursive: !0 }), d.writeFileSync(t, JSON.stringify(e, null, 2));
}
function ye() {
  return i.join(M(), "sessions");
}
function A() {
  var r;
  const t = (r = pe().sessionsRoot) == null ? void 0 : r.trim();
  return t && t.length > 0 ? t : ye();
}
function Me(e) {
  const t = e.trim(), r = pe();
  return t ? r.sessionsRoot = t : delete r.sessionsRoot, Ce(r), t || ye();
}
function Ae(e) {
  if (!e || typeof e != "string") return null;
  const t = i.resolve(e), r = i.resolve(A());
  return t === r || !t.startsWith(r + i.sep) ? null : t;
}
function je(e) {
  const t = [], r = i.join(e, "audio.wav");
  d.existsSync(r) && t.push(r);
  const n = i.join(e, "chunks");
  if (d.existsSync(n))
    try {
      const s = d.readdirSync(n);
      for (const a of s)
        a.toLowerCase().endsWith(".wav") && t.push(i.join(n, a));
    } catch (s) {
      console.error("failed to read chunks dir", s);
    }
  return t;
}
function B() {
  return i.join(M(), "models");
}
function V() {
  return i.join(process.env.APP_ROOT, "models");
}
function Y() {
  return i.join(process.resourcesPath, "models");
}
function ge() {
  const e = process.env.WHISPER_ROOT;
  if (e && e.trim()) return e;
  const t = [
    i.join(V(), "whisper"),
    i.join(Y(), "whisper"),
    i.join(B(), "whisper")
  ];
  for (const r of t)
    if (d.existsSync(r)) return r;
  return i.join(V(), "whisper");
}
function Ie() {
  const e = process.env.SILERO_VAD_MODEL;
  if (e && e.trim()) return e;
  const t = [
    i.join(V(), "silero_vad.onnx"),
    i.join(Y(), "silero_vad.onnx"),
    i.join(B(), "silero_vad.onnx")
  ];
  for (const r of t)
    if (d.existsSync(r)) return r;
  return i.join(V(), "silero_vad.onnx");
}
function Ne() {
  return i.join(process.resourcesPath, "ffmpeg");
}
function ze() {
  return i.join(process.resourcesPath, "lib");
}
function Be(e) {
  return process.platform === "win32" ? i.join(e, "ffmpeg.exe") : i.join(e, "ffmpeg");
}
function he() {
  const e = process.env.FFMPEG_PATH;
  if (e && e.trim() && d.existsSync(e)) return e;
  const t = Be(Ne());
  return d.existsSync(t) ? t : null;
}
function $() {
  const e = process.env.BACKEND_ROOT;
  if (e && e.trim()) return e;
  const t = i.join(M(), "backend");
  if (d.existsSync(t)) return t;
  const r = i.join(process.resourcesPath, "backend");
  return d.existsSync(r) ? r : i.join(process.env.APP_ROOT, "backend");
}
function Se() {
  return process.platform === "win32" ? i.join(process.resourcesPath, "python", "python.exe") : i.join(process.resourcesPath, "python", "bin", "python3");
}
function ve() {
  return process.platform === "win32" ? i.join(M(), "python", "python.exe") : i.join(M(), "python", "bin", "python3");
}
function j() {
  const e = process.env.MEETING_NOTES_PYTHON;
  if (e && e.trim()) return e;
  const t = Se();
  if (d.existsSync(t)) return t;
  const r = ve();
  return d.existsSync(r) ? r : process.platform === "win32" ? "python" : "python3";
}
function F() {
  const e = {
    ...process.env,
    WHISPER_ROOT: ge(),
    SILERO_VAD_MODEL: Ie()
  }, t = he();
  if (t) {
    e.FFMPEG_PATH = e.FFMPEG_PATH || t;
    const r = i.dirname(t);
    e.PATH = [r, e.PATH || ""].filter(Boolean).join(i.delimiter);
  }
  if (process.platform === "darwin") {
    const r = ze();
    d.existsSync(r) && (e.DYLD_LIBRARY_PATH = [r, e.DYLD_LIBRARY_PATH || ""].filter(Boolean).join(i.delimiter));
  }
  return e.GGML_LOG_LEVEL = e.GGML_LOG_LEVEL || "0", e.LLAMA_CPP_LOG_LEVEL = e.LLAMA_CPP_LOG_LEVEL || "0", e;
}
function $e(e) {
  const t = e.trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}
function ke() {
  L = [], C = !1, fe = 0, se = /* @__PURE__ */ new Map(), J = 0, G = "", K = !1, Q = null, z = null, T = !1, E = null;
}
function Fe(e) {
  if (!K || !S) return;
  const t = e.trim();
  t && (L.push({ id: fe++, text: t, sessionDir: v }), we());
}
function we() {
  if (C || !S || L.length === 0) return;
  const e = L.shift();
  C = !0;
  const t = {
    cmd: "summarize",
    text: e.text,
    out: null,
    chunk_words: oe,
    context: { type: "chunk", id: e.id, sessionDir: e.sessionDir }
  };
  _(S, "summarizer", JSON.stringify(t) + `
`) || (C = !1, L.unshift(e), console.error("[summarizer chunk] failed to send chunk summarization command"), ie());
}
function Ue(e) {
  if (!K) return;
  G = e || "";
  const r = G.slice(J);
  r.trim() && $e(r) >= oe && (Fe(r), J = G.length);
}
function ie() {
  if (!z || C || L.length > 0) return;
  const e = z;
  z = null, We(e);
}
function He(e) {
  if (!v) {
    console.error("cannot request final summary without a session directory");
    return;
  }
  z = e, K = !1, E = v, ie();
}
function We(e) {
  if (!S || T) return;
  T = !0;
  const t = Array.from(se.entries()).sort((f, g) => f[0] - g[0]).map(([, f]) => f).filter(Boolean), r = Math.min(J, e.length), n = e.slice(r).trim(), s = [];
  t.length > 0 && s.push(`Previous chunk summaries:
${t.join(`

`)}`), n && s.push(`Remaining transcript:
${n}`);
  const a = s.length > 0 ? s.join(`

`) : e, u = E || v;
  if (!u) {
    console.error("final summary requested with no session directory"), T = !1;
    return;
  }
  const c = i.join(u, "summary.txt");
  _(S, "summarizer", JSON.stringify({
    cmd: "summarize",
    text: a,
    out: c,
    chunk_words: oe,
    context: { type: "final", sessionDir: u }
  }) + `
`) || (T = !1, console.error("[summarizer final] failed to send summary command"));
}
function qe(e, t) {
  if (!t || t.type !== "chunk" || !t.sessionDir || t.sessionDir !== Q) return;
  const r = typeof t.id == "number" ? t.id : null;
  if (e.event !== "progress" && e.event !== "summary_delta" && (e.event === "done" || e.event === "error")) {
    if (C = !1, e.event === "done" && r !== null) {
      const n = (e.text || "").trim();
      n && se.set(r, n);
    }
    e.event === "error" && console.error(`[summarizer chunk ${r}] error`, e.msg), we(), ie();
  }
}
function Ge(e) {
  const t = "Action Items:", r = e.indexOf(t);
  if (r === -1) return e;
  const n = e.slice(0, r), a = e.slice(r + t.length).trim();
  if (!a) return `${n}${t}`;
  if (a.replace(/\.*$/, "").trim().toLowerCase() === "none")
    return `${n}${t} ${a}`;
  const c = Ye(a);
  if (c.length === 0)
    return `${n}${t}
${a}`;
  const m = c.slice(0, 5).map((f) => `- ${f}`);
  return `${n}${t}
${m.join(`
`)}`;
}
function Je(e) {
  const t = e.replace(/\s+/g, " ").trim();
  return t ? (t.match(/[^.!?]+[.!?]*/g) || []).map((n) => n.trim()).filter(Boolean) : [];
}
function Ve(e) {
  return e.replace(/^[•\-\*]\s*/, "").trim();
}
function Ye(e) {
  const t = e.replace(/\r/g, "").trim();
  if (!t) return [];
  const r = t.split(/\n+/).map((c) => c.trim()).filter(Boolean);
  if (r.length > 1)
    return r.map(Ve);
  const n = r[0], s = n.match(/^[•\-\*]\s*(.+)$/);
  if (s)
    return [s[1].trim()];
  const a = n.split(/(?=\d+\.)/g).map((c) => c.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
  if (a.length > 1)
    return a;
  const u = Je(n);
  return u.length > 1 || u.length === 1 ? u : [n];
}
function x(e, t, r) {
  try {
    o == null || o.webContents.send("bootstrap-status", { state: e, message: t, percent: r });
  } catch (n) {
    console.error("failed to send bootstrap-status", n);
  }
}
function _(e, t, r) {
  if (!(e != null && e.stdin))
    return console.error(`[${t}] stdin not available`), !1;
  try {
    return e.stdin.write(r), !0;
  } catch (n) {
    return console.error(`[${t}] failed to write`, n), !1;
  }
}
function Ke(e) {
  return e.startsWith("https:") ? Le : Te;
}
function Pe(e, t, r, n = 0) {
  return n > 5 ? Promise.reject(new Error("too many redirects")) : new Promise((s, a) => {
    Ke(e).get(e, (l) => {
      if (l.statusCode && l.statusCode >= 300 && l.statusCode < 400 && l.headers.location) {
        l.resume(), s(Pe(l.headers.location, t, r, n + 1));
        return;
      }
      if (l.statusCode !== 200) {
        l.resume(), a(new Error(`download failed with status ${l.statusCode}`));
        return;
      }
      d.mkdirSync(i.dirname(t), { recursive: !0 });
      const m = `${t}.partial`, f = d.createWriteStream(m);
      let g = 0;
      const p = Number(l.headers["content-length"] || 0);
      l.on("data", (y) => {
        if (g += y.length, r)
          if (p > 0) {
            const k = Math.min(100, Math.round(g / p * 100));
            r({ downloaded: g, total: p, percent: k });
          } else
            r({ downloaded: g });
      }), l.on("error", (y) => {
        f.close(() => {
        });
        try {
          d.unlinkSync(m);
        } catch {
        }
        a(y);
      }), f.on("error", (y) => {
        l.destroy();
        try {
          d.unlinkSync(m);
        } catch {
        }
        a(y);
      }), f.on("finish", () => {
        f.close(() => {
          d.rename(m, t, (y) => {
            y ? a(y) : s();
          });
        });
      }), l.pipe(f);
    }).on("error", a);
  });
}
async function ce(e) {
  return new Promise((t, r) => {
    const n = O(e, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    n.on("error", (s) => r(s)), n.on("exit", (s) => {
      s === 0 ? t() : r(new Error(`python exited with ${s}`));
    });
  });
}
async function Qe() {
  if (!he()) {
    if (b.isPackaged)
      throw new Error("ffmpeg missing in installer");
    await new Promise((t, r) => {
      const n = O("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
      n.on("error", (s) => r(s)), n.on("exit", (s) => {
        s === 0 ? t() : r(new Error("ffmpeg not available on PATH"));
      });
    });
  }
}
async function Xe() {
  const e = process.env.MEETING_NOTES_PYTHON;
  if (e && e.trim()) {
    if ((e.includes(i.sep) || e.includes("/")) && !d.existsSync(e))
      throw new Error(`MEETING_NOTES_PYTHON not found at ${e}`);
    await ce(e);
    return;
  }
  if (!d.existsSync(Se()) && !d.existsSync(ve())) {
    if (b.isPackaged)
      throw new Error("bundled python runtime missing in installer");
    await ce(j());
  }
}
async function Ze(e, t) {
  const r = i.join($(), "setup.py");
  return new Promise((n, s) => {
    var l, m;
    const a = { ...F(), WHISPER_MODEL: e, WHISPER_DIR: t }, u = O(j(), [r], {
      stdio: ["ignore", "pipe", "pipe"],
      env: a
    });
    let c = "";
    (l = u.stdout) == null || l.on("data", (f) => {
      c += f.toString();
      const g = c.split(`
`);
      c = g.pop() || "";
      for (const p of g) {
        const y = p.trim();
        if (y)
          try {
            const k = JSON.parse(y);
            k.event === "status" ? x("running", k.message || "running setup") : k.event === "done" ? x("running", k.message || "setup complete") : k.event === "error" && x("error", k.message || "setup failed");
          } catch {
          }
      }
    }), (m = u.stderr) == null || m.on("data", (f) => console.error("[setup err]", f.toString().trim())), u.on("error", (f) => s(f)), u.on("exit", (f) => {
      f === 0 ? n() : s(new Error(`setup failed with code ${f}`));
    });
  });
}
async function et() {
  const e = process.env.WHISPER_MODEL || "small.en", t = ge(), r = `models--Systran--faster-whisper-${e}`, n = i.join(t, r);
  d.existsSync(n) || (d.mkdirSync(t, { recursive: !0 }), await Ze(e, t));
}
function X() {
  const e = process.env.SUMMODEL;
  if (e && e.trim()) return e;
  if (N && d.existsSync(N)) return N;
  const t = [
    i.join(B(), R),
    i.join(Y(), R),
    i.join(process.env.APP_ROOT, "models", R)
  ];
  for (const n of t)
    if (d.existsSync(n)) return n;
  const r = [B(), Y(), i.join(process.env.APP_ROOT, "models")];
  for (const n of r) {
    if (!d.existsSync(n)) continue;
    const s = i.join(n, R);
    if (d.existsSync(s)) return s;
    try {
      const c = d.readdirSync(n, { withFileTypes: !0 }).filter((l) => l.isFile() && l.name.toLowerCase().endsWith(".gguf")).map((l) => i.join(n, l.name)).sort();
      if (c.length > 0) return c[0];
    } catch (u) {
      console.error("failed to scan models directory", u);
    }
    const a = i.join(n, "ggml-model.bin");
    if (d.existsSync(a)) return a;
  }
  return null;
}
async function be() {
  const e = process.env.SUMMODEL;
  if (e && e.trim()) {
    if (!d.existsSync(e))
      throw new Error(`summary model not found at ${e}`);
    return e;
  }
  const t = X();
  if (t && d.existsSync(t))
    return N = t, t;
  if (b.isPackaged)
    throw new Error("summary model missing in installer");
  const r = process.env.SUMMODEL_URL;
  if (!r)
    throw new Error(
      `summary model missing; place ${R} under ${i.join(process.env.APP_ROOT, "models")} or set SUMMODEL_URL to download it`
    );
  const n = B();
  let s = R;
  try {
    const u = new URL(r), c = i.basename(u.pathname);
    c && (s = c);
  } catch {
  }
  const a = i.join(n, s);
  return x("running", "downloading summary model", 0), await Pe(r, a, (u) => {
    typeof u.percent == "number" && x("running", "downloading summary model", u.percent);
  }), N = a, a;
}
async function _e() {
  return H === "done" ? !0 : I || (H = "running", I = (async () => {
    try {
      return await Qe(), await Xe(), await et(), await be(), H = "done", x("done", "ready", 100), !0;
    } catch (e) {
      H = "error";
      const t = e instanceof Error ? e.message : "setup failed";
      return x("error", t), !1;
    } finally {
      I = null;
    }
  })(), I);
}
function Z(e) {
  if (!e) {
    console.error("summary model path not set");
    try {
      o == null || o.webContents.send("summary-status", { state: "error", sessionDir: v, message: "summary model not found" });
    } catch (n) {
      console.error("failed to send summary-status error", n);
    }
    return;
  }
  if (S) {
    U && U !== e && _(S, "summarizer", JSON.stringify({ cmd: "load_model", model_path: e }) + `
`) && (U = e);
    return;
  }
  const t = i.join($(), "summarizer_daemon.py"), r = { ...F(), SUMMODEL_PATH: e };
  S = O(j(), [t], { stdio: ["pipe", "pipe", "pipe"], env: r }), U = e, S.stdout ? S.stdout.on("data", (n) => {
    const s = n.toString();
    ee += s;
    const a = ee.split(`
`);
    ee = a.pop() || "";
    for (const u of a)
      if (u)
        try {
          const c = JSON.parse(u), l = c.context, m = (l == null ? void 0 : l.sessionDir) ?? null;
          if ((l == null ? void 0 : l.type) === "chunk") {
            qe(c, l);
            continue;
          }
          const f = (l == null ? void 0 : l.type) === "final";
          if (f && (!E || m !== E))
            continue;
          const g = m || E || v;
          if (f && (c.event === "done" || c.event === "error") && (T = !1), c.event === "summary_start")
            try {
              o == null || o.webContents.send("summary-stream", { sessionDir: g, reset: !0 });
            } catch (p) {
              console.error("failed to send summary-stream reset", p);
            }
          else if (c.event === "summary_delta") {
            const p = c.text || "";
            if (p)
              try {
                o == null || o.webContents.send("summary-stream", { sessionDir: g, delta: p });
              } catch (y) {
                console.error("failed to send summary-stream delta", y);
              }
          } else if (c.event === "done") {
            const p = c.out, y = Ge(c.text || "");
            try {
              o == null || o.webContents.send("summary-ready", { sessionDir: g, summaryPath: p, text: y });
            } catch (k) {
              console.error("failed to send summary-ready", k);
            }
            try {
              o == null || o.webContents.send("summary-status", { state: "done", sessionDir: g, message: "summary complete" });
            } catch (k) {
              console.error("failed to send summary-status done", k);
            }
            f && (E = null);
          } else if (c.event === "followup_done") {
            const p = c.id, y = p ? w.get(p) : null;
            y ? (clearTimeout(y.timeout), y.resolve({ ok: !0, text: c.text || "" }), w.delete(p)) : console.warn("[summarizer] follow-up done with no request id", c.id);
          } else if (c.event === "progress") {
            if ((l == null ? void 0 : l.type) !== "final") continue;
            try {
              o == null || o.webContents.send("summary-status", { state: "running", sessionDir: g, message: c.msg || "summarizing" });
            } catch (p) {
              console.error("failed to send summary-status running", p);
            }
          } else if (c.event === "error") {
            console.error("[summarizer error]", c.msg);
            try {
              o == null || o.webContents.send("summary-status", { state: "error", sessionDir: g, message: c.msg || "summary error" });
            } catch (p) {
              console.error("failed to send summary-status error", p);
            }
            f && (E = null);
          } else if (c.event === "followup_error") {
            const p = c.id, y = p ? w.get(p) : null;
            y ? (clearTimeout(y.timeout), y.resolve({ ok: !1, error: c.msg || "follow-up error" }), w.delete(p)) : console.warn("[summarizer] follow-up error with no request id", c.id, c.msg);
          }
        } catch {
        }
  }) : console.error("[summarizer] stdout not available"), S.stderr ? S.stderr.on("data", () => {
  }) : console.error("[summarizer] stderr not available"), S.on("error", (n) => {
    console.error("[summarizer spawn error]", n);
    try {
      o == null || o.webContents.send("summary-status", { state: "error", sessionDir: v, message: "failed to start summarizer" });
    } catch (s) {
      console.error("failed to send summary-status spawn error", s);
    }
  }), S.on("exit", (n) => {
    if (console.log("[summarizer] exited", n), S = null, w.size > 0)
      for (const [s, a] of w.entries())
        clearTimeout(a.timeout), a.resolve({ ok: !1, error: "summarizer exited before follow-up finished" }), w.delete(s);
  });
}
function De(e, t) {
  try {
    o == null || o.webContents.send("transcript-ready", { sessionDir: v, transcriptPath: e, text: t });
  } catch (r) {
    console.error("failed to send transcript-ready", r);
  }
  try {
    o == null || o.webContents.send("transcription-status", { state: "done", sessionDir: v, message: "transcription complete" });
  } catch (r) {
    console.error("failed to send transcription-status done", r);
  }
  try {
    const r = X();
    if (!r || !d.existsSync(r))
      throw new Error("summary model not found");
    Z(r);
    try {
      o == null || o.webContents.send("summary-status", { state: "starting", sessionDir: v, message: "starting summarization" });
    } catch (n) {
      console.error("failed to send summary-status starting", n);
    }
    if (!S) throw new Error("summarizer not running");
    He(t);
  } catch (r) {
    console.error("failed to start summarizer", r);
    try {
      o == null || o.webContents.send("summary-status", { state: "error", sessionDir: v, message: "failed to start summarizer" });
    } catch (n) {
      console.error("failed to send summary-status error", n);
    }
  }
}
function tt(e) {
  q += e.toString();
  const t = q.split(`
`);
  q = t.pop() || "";
  for (const r of t) {
    const n = r.trim();
    if (n)
      try {
        const s = JSON.parse(n);
        if (s.event === "partial") {
          try {
            o == null || o.webContents.send("transcript-partial", {
              sessionDir: v,
              text: s.text || "",
              fullText: s.full_text || s.fullText || ""
            });
          } catch (u) {
            console.error("failed to send transcript-partial", u);
          }
          const a = s.full_text || s.fullText || s.text || "";
          Ue(a);
          continue;
        }
        if (s.event === "started") {
          const a = typeof s.started_at == "number" ? s.started_at : typeof s.startedAt == "number" ? s.startedAt : null, u = a ? Math.round(a * 1e3) : Date.now();
          try {
            o == null || o.webContents.send("recording-started", { sessionDir: v, startedAtMs: u });
          } catch (c) {
            console.error("failed to send recording-started", c);
          }
          continue;
        }
        if (s.event === "ready") {
          try {
            o == null || o.webContents.send("recording-ready", { ready: !0 });
          } catch (a) {
            console.error("failed to send recording-ready", a);
          }
          continue;
        }
        if (s.event === "done" && s.out) {
          const a = s.out, u = s.text || "";
          De(a, u);
          continue;
        }
      } catch {
        continue;
      }
  }
}
function rt(e) {
  const t = v;
  if (t) {
    if (e.event === "started") {
      try {
        o == null || o.webContents.send("transcription-status", {
          state: "running",
          sessionDir: t,
          message: "transcribing uploaded recording"
        });
      } catch (r) {
        console.error("failed to send transcription-status running", r);
      }
      return;
    }
    if (e.event === "done" && e.out) {
      De(e.out, e.text || "");
      return;
    }
    if (e.event === "error") {
      const r = e.msg || "transcription failed";
      try {
        o == null || o.webContents.send("transcription-status", { state: "error", sessionDir: t, message: r });
      } catch (n) {
        console.error("failed to send transcription-status error", n);
      }
    }
  }
}
function Ee() {
  const e = A();
  d.mkdirSync(e, { recursive: !0 });
  const t = (/* @__PURE__ */ new Date()).toISOString().replace(/[:]/g, "-").replace(/\..+$/, ""), r = i.join(e, t);
  return d.mkdirSync(r, { recursive: !0 }), r;
}
async function ae() {
  if (h) {
    console.log("[backend] already running");
    return;
  }
  if (!await _e()) return;
  q = "";
  try {
    o == null || o.webContents.send("recording-ready", { ready: !1 });
  } catch (n) {
    console.error("failed to send recording-ready false", n);
  }
  const t = i.join($(), "record_and_transcribe.py"), r = { ...F(), WHISPER_MODEL: ne };
  Z(X()), h = O(j(), [t], {
    stdio: ["pipe", "pipe", "pipe"],
    env: r
  }), h.stdout ? h.stdout.on("data", (n) => {
    tt(n);
  }) : console.error("[backend] stdout not available"), h.stderr ? h.stderr.on("data", (n) => {
    console.error("[backend err]", n.toString().trim());
  }) : console.error("[backend] stderr not available"), h.on("error", (n) => {
    console.error("[backend spawn error]", n);
    try {
      o == null || o.webContents.send("transcription-status", { state: "error", sessionDir: v, message: "failed to start recorder" });
    } catch (s) {
      console.error("failed to send transcription-status spawn error", s);
    }
  }), h.on("exit", (n) => {
    console.log("[backend] exited with code", n), h = null;
    try {
      o == null || o.webContents.send("recording-ready", { ready: !1 });
    } catch (s) {
      console.error("failed to send recording-ready false", s);
    }
  });
}
async function nt() {
  if (D)
    return { ok: !1, error: "Already processing a recording" };
  if (!o)
    return { ok: !1, error: "window not ready" };
  if (!await _e())
    return { ok: !1, error: "setup not ready" };
  const t = await te.showOpenDialog(o, {
    title: "Select a recording",
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["wav", "mp3", "m4a", "flac", "aac", "ogg", "webm"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (t.canceled || t.filePaths.length === 0)
    return { ok: !1, error: "no file selected" };
  const r = t.filePaths[0];
  ke();
  const n = Ee();
  v = n, Q = n;
  try {
    o == null || o.webContents.send("session-started", { sessionDir: n, sessionsRoot: A() });
  } catch (m) {
    console.error("failed to send session-started for file upload", m);
  }
  const s = i.join(n, i.basename(r));
  try {
    d.copyFileSync(r, s);
  } catch (m) {
    return { ok: !1, error: `failed to copy recording: ${m instanceof Error ? m.message : String(m)}` };
  }
  try {
    o == null || o.webContents.send("transcription-status", { state: "running", sessionDir: n, message: "preparing transcription" });
  } catch (m) {
    console.error("failed to send transcription-status running for upload", m);
  }
  const a = i.join(n, "transcript.txt"), u = X();
  if (!u)
    return { ok: !1, error: "summary model not found" };
  Z(u);
  const c = i.join($(), "transcribe_file.py"), l = {
    ...F(),
    TRANSCRIBE_MODEL: ne,
    TRANSCRIBE_AUDIO: s,
    TRANSCRIPT_OUT: a
  };
  return W = "", D = O(j(), [c], {
    stdio: ["ignore", "pipe", "pipe"],
    env: l
  }), D.stdout ? D.stdout.on("data", (m) => {
    W += m.toString();
    const f = W.split(`
`);
    W = f.pop() || "";
    for (const g of f) {
      const p = g.trim();
      if (p)
        try {
          const y = JSON.parse(p);
          rt(y);
        } catch {
          continue;
        }
    }
  }) : console.error("[file-transcribe] stdout not available"), D.stderr ? D.stderr.on("data", (m) => {
    console.error("[file-transcribe err]", m.toString().trim());
  }) : console.error("[file-transcribe] stderr not available"), D.on("exit", () => {
    D = null;
  }), { ok: !0 };
}
function ot() {
  if (!h) {
    console.log("[backend] not running");
    return;
  }
  if (_(h, "recorder", JSON.stringify({ cmd: "stop" }) + `
`)) {
    console.log("[backend] stop command sent");
    return;
  }
  console.error("[backend] failed to send stop command");
}
function st() {
  if (!h) {
    console.log("[backend] not running");
    return;
  }
  _(h, "recorder", JSON.stringify({ cmd: "pause" }) + `
`);
}
function it() {
  if (!h) {
    console.log("[backend] not running");
    return;
  }
  _(h, "recorder", JSON.stringify({ cmd: "resume" }) + `
`);
}
P.on("backend-start", (e, t = {}) => {
  (async () => {
    if (console.log("[ipc] backend-start", t), ke(), t && t.model && (ne = t.model), await ae(), !h) return;
    const r = Ee();
    v = r, Q = r;
    const n = i.join(r, "audio.wav"), s = i.join(r, "transcript.txt");
    console.log("[backend] sessionDir=", r);
    try {
      o == null || o.webContents.send("session-started", { sessionDir: r, sessionsRoot: A() });
    } catch (u) {
      console.error("failed to send session-started", u);
    }
    const a = {
      cmd: "start",
      out: n,
      transcript_out: s,
      device_index: t && typeof t.deviceIndex == "number" ? t.deviceIndex : void 0,
      loopback_device_index: t && typeof t.loopbackDeviceIndex == "number" ? t.loopbackDeviceIndex : void 0
    };
    _(h, "recorder", JSON.stringify(a) + `
`) || console.error("[backend] failed to send start command");
  })();
});
P.on("backend-stop", () => {
  console.log("[ipc] backend-stop"), ot();
});
P.on("backend-pause", () => {
  console.log("[ipc] backend-pause"), st();
});
P.on("backend-resume", () => {
  console.log("[ipc] backend-resume"), it();
});
P.handle("list-devices", async () => {
  const e = i.join($(), "devices.py");
  return new Promise((t) => {
    const r = O(j(), [e], { stdio: ["ignore", "pipe", "pipe"], env: F() });
    let n = "";
    r.stdout.on("data", (s) => n += s.toString()), r.stderr.on("data", (s) => console.error("[devices err]", s.toString().trim())), r.on("exit", () => {
      try {
        const s = JSON.parse(n || "{}");
        t(s);
      } catch {
        t({ error: "failed to parse devices", raw: n });
      }
    });
  });
});
P.handle("get-sessions-root", () => A());
P.handle("choose-sessions-root", async () => {
  try {
    const e = {
      title: "Choose session save location",
      defaultPath: A(),
      properties: ["openDirectory", "createDirectory"]
    }, t = o ? await te.showOpenDialog(o, e) : await te.showOpenDialog(e);
    if (t.canceled || t.filePaths.length === 0) return null;
    const r = t.filePaths[0];
    return d.mkdirSync(r, { recursive: !0 }), Me(r);
  } catch (e) {
    return console.error("failed to choose sessions root", e), null;
  }
});
P.handle("process-recording", async () => {
  try {
    return await nt();
  } catch (e) {
    return console.error("[process-recording] failed", e), { ok: !1, error: e instanceof Error ? e.message : "failed to process recording" };
  }
});
P.handle("generate-followup-email", async (e, t = {}) => {
  const r = typeof t.summary == "string" ? t.summary.trim() : "";
  if (!r) return { ok: !1, error: "summary is required" };
  const n = typeof t.studentName == "string" ? t.studentName.trim() : "", s = typeof t.instructions == "string" ? t.instructions.trim() : "", a = typeof t.temperature == "number" ? t.temperature : void 0, u = typeof t.maxTokens == "number" ? t.maxTokens : void 0, c = await be();
  if (!c) return { ok: !1, error: "summary model not found" };
  if (Z(c), !S) return { ok: !1, error: "summarizer not running" };
  const l = Re();
  return new Promise((m) => {
    const f = setTimeout(() => {
      w.delete(l), m({ ok: !1, error: "follow-up generation timed out" });
    }, 9e4);
    w.set(l, { resolve: m, timeout: f });
    const g = {
      cmd: "followup_email",
      id: l,
      summary: r,
      instructions: s
    };
    n && (g.student_name = n), typeof a == "number" && (g.temperature = a), typeof u == "number" && (g.max_tokens = u), _(S, "summarizer", JSON.stringify(g) + `
`) || (clearTimeout(f), w.delete(l), m({ ok: !1, error: "failed to start follow-up generation" }));
  });
});
P.handle("delete-session-audio", async (e, t) => {
  const r = Ae(t);
  if (!r) return { ok: !1, error: "invalid session directory" };
  if (h && v && i.resolve(v) === r)
    return { ok: !1, error: "cannot delete audio while recording" };
  const n = je(r);
  if (n.length === 0) return { ok: !0, deleted: [] };
  const s = [];
  for (const u of n)
    try {
      d.unlinkSync(u), s.push(u);
    } catch (c) {
      console.error("failed to delete audio file", u, c);
    }
  const a = s.length === n.length;
  return { ok: a, deleted: s, error: a ? void 0 : "failed to delete some audio files" };
});
function xe() {
  o = new le({
    width: 1e3,
    height: 700,
    icon: i.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: i.join(ue, "preload.mjs")
    }
  }), o.webContents.on("did-finish-load", () => {
    o == null || o.webContents.send("main-process-message", (/* @__PURE__ */ new Date()).toLocaleString()), ae();
  }), re ? o.loadURL(re) : o.loadFile(i.join(de, "index.html"));
}
b.whenReady().then(() => {
  xe();
});
b.on("window-all-closed", () => {
  o = null, process.platform !== "darwin" && b.quit();
});
b.on("activate", () => {
  le.getAllWindows().length === 0 && (xe(), ae());
});
b.on("before-quit", () => {
  if (h && (_(h, "recorder", JSON.stringify({ cmd: "shutdown" }) + `
`), setTimeout(() => {
    if (h) {
      try {
        h.kill("SIGTERM");
      } catch (e) {
        console.error("failed to kill backend", e);
      }
      h = null;
    }
  }, 3e3)), S) {
    try {
      S.kill("SIGTERM");
    } catch (e) {
      console.error("failed to kill summarizer", e);
    }
    S = null;
  }
});
export {
  yt as MAIN_DIST,
  de as RENDERER_DIST,
  re as VITE_DEV_SERVER_URL
};
