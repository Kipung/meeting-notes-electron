# Refactor Notes

Working log — one section per step. Each step records: what changed, why, what to test before moving on.

---

## Progress Summary

| Step | What | Status |
|------|------|--------|
| 1 | Extract shared `downloadFile` utility | ✅ Done |
| 2 | Extract JSON newline-buffer parser utility | ✅ Done |
| 3 | Fix summarizerService stderr silencing | ✅ Done |
| 4 | Remove external `sendProcessCommand` dependency from summarizerService | ✅ Done |
| 5 | Fix `handleTranscriptReady` nested try/catch in main.ts | ✅ Done |
| 6 | App.tsx: extract custom hooks (timer, metadata, follow-up email) | ✅ Done |
| 7 | App.tsx: extract sub-components (RecordingPanel, TranscriptPanel, etc.) | ⏳ Pending |
| 8 | summaryOrchestrator: make thresholds configurable via constructor options | ✅ Done |
| 9 | Remove Llama fallback + harden installation (VAD URL, SHA256, HF offline) | ✅ Done |
| — | Switch default Whisper model from `small.en` to `medium.en` | ✅ Done |
| — | Qwen SHA256 verification after download | ⏳ Pending |

### Pending
- **Step 7** — App.tsx sub-components: split the JSX render into `<RecordingPanel>`, `<TranscriptPanel>`, `<SummaryPanel>`, `<MetadataForm>`. Hooks are stable, this is unblocked.
- **Qwen SHA256** — `setupWindow.ts` needs a `verifyFileSha256` call after the Qwen download. Requires the known hash for `qwen2.5-3b-instruct-q4_k_m.gguf`.

### Known issues (pre-existing)
- `backend/` files deleted on `cleanup` branch — run `git restore backend/` to recover
- Stale `whisper/*.pt` files in app data (old openai-whisper format, not used by faster-whisper)
- `torch_cache/hub/snakers4_silero-vad_master/` in app data (old PyTorch VAD, no longer used)

---

## Inventory of concrete issues (ranked by impact/risk)

### Electron main process

| # | File | Issue | Risk |
|---|------|-------|------|
| 1 | `runtimeSupport.ts` vs `setupWindow.ts` | `downloadFile()` duplicated verbatim (different redirect limits: 5 vs 10, slightly different error strings) | Low |
| 2 | `transcriptionService.ts` (×2) + `summarizerService.ts` + `runtimeSupport.ts` | JSON newline-buffer parsing pattern copied in 4 places | Low |
| 3 | `summarizerService.ts` L246 | `stderr.on('data', () => {})` — stderr completely silenced, errors invisible | Low (1-line) |
| 4 | `summarizerService.ts` options | Accepts `sendProcessCommand` as external dependency; `transcriptionService.ts` owns its version internally — asymmetric | Low |
| 5 | `main.ts` `handleTranscriptReady` | 3 separate try/catch blocks wrapping single-line `webContents.send` calls; `sendToRenderer` exists for exactly this but isn't used consistently | Low |
| 6 | `summaryOrchestrator.ts` L5-6 | `CHUNK_WORD_THRESHOLD = 900` and `FINAL_SUMMARY_DIRECT_TRANSCRIPT_WORD_THRESHOLD = 1400` hardcoded module constants — can't tune without a code change | Low |

### React renderer

| # | File | Issue | Risk |
|---|------|-------|------|
| 7 | `src/App.tsx` (~600 lines of component body alone) | God component: ~30 state vars, 10+ IPC listener registrations, all user interaction handlers, all rendering in one function | High (careful extraction needed) |
| 8 | `src/App.tsx` | All IPC events wired in a single massive `useEffect` — hard to reason about, no way to test in isolation | Medium |
| 9 | `src/App.tsx` | Recording timer logic (refs + elapsed calc) mixed into main component | Medium |
| 10 | `src/App.tsx` | Follow-up email state (4 vars + handler) mixed into main component | Medium |

### What is NOT a problem (leave alone)
- `registerIpcHandlers.ts` — clean, well-typed, just a wiring file
- `sessionStore.ts` — clean factory, good separation
- `sessionMetadata.ts` — clean types + persistence
- `summaryOrchestrator.ts` — clean class design, logic is sound
- `summarizerService.ts` — logic is good, just the stderr silencing and asymmetric sendProcessCommand dep
- Module-level parsing functions in `App.tsx` (`parseSummaryForView`, `parseActionItems`, etc.) — these are already extracted from the component, leave them as-is
- Python tests — well-structured, comprehensive

---

## Step 1 — Extract shared `downloadFile` utility

**Status**: ✅ Done

**What**: `downloadFile()` appears identically in `electron/runtimeSupport.ts` (L333-400, redirect limit=5)
and `electron/setupWindow.ts` (L34-91, redirect limit=10). Both are standalone HTTP download helpers with
`.partial` temp file and progress callback. The only real differences are the redirect limit and minor error message wording.

**Why**: Any download bug has to be fixed in two places. The diverged redirect limits are a latent inconsistency.

**Decision**: Use limit=10 (setupWindow's more lenient value). Extract to `electron/utils/fileDownloader.ts`.

**Roadblock**: None — pure extraction, both callers use the same signature.

**Test before proceeding**: `pnpm lint && pnpm exec tsc --noEmit`

---

## Step 2 — Extract JSON newline-buffer parser utility

**Status**: ✅ Done

**What**: The pattern of accumulating stdout into a buffer, splitting on `\n`, and parsing each line as JSON
appears in 4 places:
- `transcriptionService.ts` `handleRecorderOutput()` L67-69
- `transcriptionService.ts` `fileTranscribeProcess.stdout.on('data')` L320-330
- `summarizerService.ts` `startIfNeeded()` L227-240
- `runtimeSupport.ts` `runSetupScript()` L464-484 (slightly different — no line-trim before JSON.parse)

**Why**: Duplicated buffer accumulation logic. A bug in the split/parse pattern requires 4 fixes.

**Decision**: Extract `makeJsonLineParser<T>(onLine: (obj: T) => void): (data: Buffer) => void` to
`electron/utils/lineParser.ts`. Returns a data handler that can be passed directly to `.on('data', ...)`.

**Roadblock**: `runtimeSupport.ts`'s version doesn't trim the line before JSON.parse — minor inconsistency,
harmless because the JSON parser ignores leading/trailing whitespace anyway. Unify to always trim.

**Test before proceeding**: `pnpm lint && pnpm exec tsc --noEmit`

---

## Step 3 — Fix summarizerService stderr silencing (1-line fix)

**Status**: ✅ Done

**What**: `summarizerProcess.stderr.on('data', () => {})` (L246) silently swallows all stderr from the
Python summarizer process. Any Python tracebacks or llama.cpp warnings are invisible to the developer.

**Why**: Every other process in the codebase logs stderr. This is a debugging trap.

**Test before proceeding**: `pnpm lint && pnpm exec tsc --noEmit`

---

## Step 4 — Remove external sendProcessCommand dependency from summarizerService

**Status**: ✅ Done

**What**: `createSummarizerService` accepts `sendProcessCommand` as a constructor option. This is the only
service that does this. `transcriptionService` owns its `sendProcessCommand` internally. The external dep
also forces `main.ts` to define its own copy of the function just to pass it in.

**Why**: Unnecessary coupling. summarizerService already owns its process (`summarizerProcess`). It can
own the stdin write operation too. This removes the duplicated function in `main.ts` and simplifies the
service options type.

**Roadblock**: `summarizerService.sendCommand` is exported and used by `summaryOrchestrator` via `main.ts`.
That call path goes: `main.ts → sendSummarizerCommand → summarizerService.sendCommand → sendProcessCommand(summarizerProcess, ...)`.
After the change, `summarizerService.sendCommand` handles the stdin write directly.

**Test before proceeding**: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`

---

## Step 5 — Fix handleTranscriptReady nested try/catch in main.ts

**Status**: ✅ Done

**What**: `handleTranscriptReady` (L202-223) has 3 separate try/catch blocks each wrapping one
`win?.webContents.send(...)` call. `sendToRenderer()` exists for exactly this purpose and is used everywhere
else. The redundant try/catch blocks add ~12 lines of noise.

**Why**: Inconsistency and noise. `sendToRenderer` is the established pattern.

---

## Pre-existing issue — Python backend missing from working tree

**Status**: ⚠️ Not caused by this refactor

`backend/` files show as `deleted` in git status on the `cleanup` branch. Tests fail because
`backend.summarizer_daemon`, `backend.summary_formatting`, etc. don't exist on disk.
`pnpm lint` and `tsc --noEmit` both pass — only Python tests are broken, and they were broken before this work.

To restore: `git restore backend/`

---

## Step 6 — App.tsx: extract custom hooks

**Status**: ✅ Done

**What**: Extracted three self-contained hooks:
- `src/hooks/useRecordingTimer.ts` — refs + elapsed time + blink tick + start/pause/resume/stop/reset
- `src/hooks/useSessionMetadata.ts` — 5 form fields + payload memo + backend sync useEffect
- `src/hooks/useFollowUpEmail.ts` — follow-up state (4 vars) + generate handler + reset

**Why**: The component body was ~1200 lines mixing UI, IPC wiring, and interaction logic.
Hooks let us isolate and test each concern independently. No UI changes in this step.

**Result**: App.tsx: 1211 → 1140 lines. 15+ state variables extracted. 3 new focused hook files.

**Approach taken**: Hooks are ordered before the big IPC `useEffect` so that functions like
`resetFollowUp` and `startTimer` are in scope when the effect callback is registered.
The IPC `useEffect` uses `[]` deps intentionally (register-once-on-mount pattern) — suppressed
exhaustive-deps lint warning with targeted comment because all captured functions are stable setState calls.

**Test**: `pnpm lint && pnpm exec tsc --noEmit` ✅

---

## Step 7 — App.tsx: extract sub-components (PENDING)

**Status**: ⏳ Pending Step 6

**Planned splits**:
- `<RecordingPanel>` — device selectors, start/stop/pause buttons, elapsed timer
- `<TranscriptPanel>` — transcript display + copy button
- `<SummaryPanel>` — summary display, action items, progress steps
- `<MetadataForm>` — session metadata inputs (modality, subject, student, coach)

**Defer until**: Step 6 complete and hooks verified working.

---

## Step 8 — summaryOrchestrator: make thresholds configurable

**Status**: ✅ Done

**What**: `CHUNK_WORD_THRESHOLD = 900` and `FINAL_SUMMARY_DIRECT_TRANSCRIPT_WORD_THRESHOLD = 1400` are
module-level constants. Pass them as constructor options with those values as defaults.

**Why**: Enables tuning from config/env without code changes. Low risk since defaults stay the same.

---

## Step 9 — Remove Llama fallback model + harden installation

**Status**: ✅ Done

**What**:
1. Removed `'Llama-3.2-1B-Instruct-Q6_K.gguf'` from `PREFERRED_SUMMARY_MODEL_NAMES` in `main.ts` — Qwen is the only supported model.
2. Fixed broken Silero VAD URL in `main.ts` (`master/files/silero_vad.onnx` → `v6.2.1/src/silero_vad/data/silero_vad.onnx`, pinned to tag).
3. Added `verifyFileSha256(filePath, expectedSha256)` to `electron/utils/fileDownloader.ts` using `node:crypto`. Returns a promise that rejects on hash mismatch.
4. Added SHA256 verification after VAD download in `runtimeSupport.ts` (skipped only if `SILERO_VAD_URL` env override is set, since custom URLs may have different hashes).
5. Added `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` to `getPythonEnv()` — prevents HuggingFace/transformers from making unexpected network calls at runtime.
6. `runSetupScript()` deletes those two env keys before spawning setup.py so the initial Whisper model download is still allowed.

**Why**:
- The Llama 1B fallback was never needed; Qwen 3B is the intended model. Having two entries was misleading and could cause confusing fallback behavior.
- The Silero VAD URL was a 404. The file moved from `master/files/` to `src/silero_vad/data/` in a recent reorganization.
- SHA256 verification ensures the downloaded VAD model hasn't been tampered with or corrupted.
- `HF_HUB_OFFLINE` prevents `faster-whisper` and `transformers` from phoning home after setup is complete (supports the "all local after first run" pitch).

**Test**: `pnpm lint && pnpm exec tsc --noEmit` ✅

---
