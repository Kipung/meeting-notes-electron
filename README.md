# Meeting Notes Electron

Record meetings, transcribe with Whisper, and summarize with a local GGUF/GGML Llama model. Sessions are stored on disk with audio, transcript, and summary files.

## Features

- Record from a selected input device
- Whisper transcription with selectable model size
- Automatic summarization after transcription using a local LLM (GGUF/GGML) via llama-cpp
- Multi-pass chunked summarization for long meetings
- Background chunk transcription to reduce wait time after Stop
- Session artifacts saved under `app.getPath('userData')/sessions/<timestamp>/`

## Project layout

- `electron/` - main process and IPC wiring
- `src/` - renderer UI
- `backend/` - Python scripts for recording, transcription, summarization
- `models/` - local GGUF/GGML model files
- `sessions/` - legacy dev output (current outputs go to `app.getPath('userData')/sessions`)
- `python/` - bundled Python runtime for offline installer builds
- `whisper/` - bundled Whisper model files (e.g. `small.en.pt`)
- `ffmpeg/` - bundled ffmpeg binary for offline installer builds
- `lib/` - ffmpeg dynamic libraries for macOS offline builds

## Setup

### macOS end-to-end (clean machine)

1) Install system prerequisites:

```bash
brew install node ffmpeg portaudio
```

2) Install and activate conda (Miniconda/Anaconda), then:

```bash
conda create -n meeting-notes python=3.10 -y
conda activate meeting-notes
```

3) Install pnpm and JS deps:

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
```

4) Install Python deps (inside the conda env):

```bash
pip install -r requirements.txt
```

5) (Optional) Install HF CLI for model downloads:

```bash
pip install -U "huggingface_hub[cli]"
```

6) Download a GGUF model into `models/` (example):

```bash
hf download unsloth/Llama-3.2-3B-Instruct-GGUF Llama-3.2-3B-Instruct-Q4_K_M.gguf --local-dir models --local-dir-use-symlinks False
```

7) (Optional) Download a second model variant (same repo, different quant):

```bash
hf download unsloth/Llama-3.2-3B-Instruct-GGUF Llama-3.2-3B-Instruct-Q5_K_M.gguf --local-dir models --local-dir-use-symlinks False
```

8) Run the app:

```bash
pnpm dev
```

### Windows end-to-end (clean machine)

1) Install system prerequisites (PowerShell):

```powershell
winget install OpenJS.NodeJS
winget install Gyan.FFmpeg
winget install PortAudio.PortAudio
```

2) Install Miniconda or Anaconda, then open the Anaconda Prompt and:

```powershell
conda create -n meeting-notes python=3.11.14
conda activate meeting-notes
```

3) Install pnpm and JS deps:

```powershell
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
```

4) Install Python deps (inside the conda env):

```powershell
pip install -r requirements.txt
```

5) (Optional) Install HF CLI for model downloads:

```powershell
pip install -U "huggingface_hub[cli]"
```

6) Download a GGUF model into `models/` (example):

```powershell
hf download unsloth/Llama-3.2-3B-Instruct-GGUF Llama-3.2-3B-Instruct-Q4_K_M.gguf --local-dir models --local-dir-use-symlinks False
```

7) (Optional) Download a second model variant (same repo, different quant):

```powershell
hf download unsloth/Llama-3.2-3B-Instruct-GGUF Llama-3.2-3B-Instruct-Q5_K_M.gguf --local-dir models --local-dir-use-symlinks False
```

8) Run the app:

```powershell
pnpm dev
```

## End-to-end setup after cloning (offline installer build)

This produces an installer that works without internet by bundling Python, Whisper, the GGUF model, and ffmpeg.

### macOS (arm64)

1) Install system prerequisites:

```bash
brew install node ffmpeg portaudio
```

2) Create a Python env (3.10 or 3.11) and install deps:

```bash
conda create -n meeting-notes-runtime python=3.11 -y
conda activate meeting-notes-runtime
pip install -r requirements.txt
```

3) Install JS deps:

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
```

4) Put a GGUF model in `models/` (example):

```bash
hf download unsloth/Llama-3.2-3B-Instruct-GGUF Llama-3.2-3B-Instruct-Q4_K_M.gguf --local-dir models --local-dir-use-symlinks False
```

5) Prepare the offline bundle (copies Python, Whisper model, ffmpeg, and libs):

```bash
pnpm prepare:offline --python-bin "$HOME/miniconda3/envs/meeting-notes-runtime/bin/python" --ffmpeg "$(which ffmpeg)" --force
```

If ffmpeg libs aren't detected, pass the conda lib dir explicitly:

```bash
pnpm prepare:offline --python-bin "$HOME/miniconda3/envs/meeting-notes-runtime/bin/python" --ffmpeg "$(which ffmpeg)" --ffmpeg-lib "$HOME/miniconda3/envs/meeting-notes-runtime/lib" --force
```

6) Build the installer:

```bash
pnpm build
```

### Windows (x64)

1) Install prerequisites (PowerShell):

```powershell
winget install OpenJS.NodeJS
```

2) Create a Python env (3.10 or 3.11) and install deps:

```powershell
conda create -n meeting-notes-runtime python=3.11 -y
conda activate meeting-notes-runtime
pip install -r requirements.txt
```

3) Install ffmpeg (inside the conda env):

```powershell
conda install -c conda-forge ffmpeg -y
```

4) Install JS deps:

```powershell
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
```

5) Put a GGUF model in `models\` (example):

```powershell
hf download unsloth/Llama-3.2-3B-Instruct-GGUF Llama-3.2-3B-Instruct-Q4_K_M.gguf --local-dir models --local-dir-use-symlinks False
```

6) Prepare the offline bundle:

```powershell
$ffmpegPath = (where.exe ffmpeg | Select-Object -First 1)
pnpm prepare:offline --python-bin C:\Users\<you>\miniconda3\envs\meeting-notes-runtime\python.exe --ffmpeg $ffmpegPath --force
```

7) Build the installer:

```powershell
pnpm build
```

## Running

```bash
pnpm dev
```

## Summarization model

The app preloads a llama-cpp model via `backend/summarizer_daemon.py`.
It prefers a model in `app.getPath('userData')/models` (or `models/` in dev), picking `Llama-3.2-3B-Instruct-Q4_K_M.gguf` if present, otherwise the first `.gguf` it finds.
Override with an env var:

```bash
SUMMODEL=/path/to/your/model.gguf pnpm dev
```

The model path should be a GGUF or GGML file. A smaller Llama model (3B-8B) is a good starting point.

For offline installer builds, place your GGUF model in `models/` before running `pnpm build`.

If no model is found during development, the app will download a default GGUF.
Override the download URL (or disable downloads by setting `SUMMODEL`) with:

```bash
SUMMODEL_URL=https://example.com/your-model.gguf pnpm dev
```

If you need a larger context window (useful for long meetings), set:

```bash
SUM_N_CTX=4096 pnpm dev
```

To avoid hallucinated summaries on extremely short or empty recordings, the summarizer skips transcripts below a word threshold (default 20). Override with:

```bash
SUM_MIN_WORDS=10 pnpm dev
```

## Faster end-of-session processing

By default the recorder writes rolling audio chunks while you speak and transcribes those chunks during the recording. This reduces the wait after you press Stop.
The final transcript appears after Stop, once the background chunks are assembled.

Configure the chunk duration (in seconds), or set to 0 to disable:

```bash
RECORD_CHUNK_SECS=60 pnpm dev
```

## Outputs

Each session is saved to:

- `app.getPath('userData')/sessions/<timestamp>/audio.wav`
- `app.getPath('userData')/sessions/<timestamp>/transcript.txt`
- `app.getPath('userData')/sessions/<timestamp>/summary.txt`

## Packaging (installer)

Use:

```bash
pnpm build
```

Notes:
- `backend/` scripts are bundled via `electron-builder.json5` (`extraResources`).
- The app performs a preflight setup on launch and blocks Start until dependencies and models are ready.
- Offline installer requirements: bundle `python/`, `models/`, and `whisper/` directories in the project root before building. These are copied into the app via `extraResources`.
- The bundled `python/` must contain `bin/python3` (mac) or `python.exe` (Windows).
- Whisper models are loaded from `app.getPath('userData')/whisper` and are copied from the bundled `whisper/` on first run (override with `WHISPER_MODEL`).
- The summary model is loaded from bundled `models/` (or `app.getPath('userData')/models` if you add additional files).
- The bundled `ffmpeg/` must contain `ffmpeg` (mac) or `ffmpeg.exe` (Windows). You can override with `FFMPEG_PATH`.
- macOS: copy ffmpeg’s dependent `.dylib` files into `lib/` so the binary can run in the packaged app.
- The build validates the offline bundle; set `EXPECTED_PYTHON_VERSION=3.11` (or `3.10,3.11` / `3.10-3.11`) to enforce a version range, or `SKIP_BUNDLE_CHECK=1` to bypass.

### Offline bundle prep

Before building the installer, populate these folders at the project root:

```
python/   # runtime with bin/python3 (mac) or python.exe (windows)
models/   # GGUF model(s), e.g. Llama-3.2-3B-Instruct-Q4_K_M.gguf
whisper/  # Whisper model(s), e.g. small.en.pt
ffmpeg/   # ffmpeg binary, e.g. ffmpeg or ffmpeg.exe
lib/      # ffmpeg .dylib files for macOS
```

The app will error at setup time if any required bundled files are missing.

Quick helper (builds `python/` from your current Python env and copies/downloads the Whisper model):

```bash
pnpm prepare:offline
```

Options:
- `--python-home /path/to/env` (use a specific env root)
- `--python-bin /path/to/python3` (use a specific python binary)
- `--whisper-model small.en`
- `--ffmpeg /path/to/ffmpeg`
- `--ffmpeg-lib /path/to/lib`
- `--force` (overwrite existing `python/`)

## Manual summarization (LLM)

```bash
python3 backend/summarize_llm.py --model-path models/<your-model>.gguf --file app.getPath('userData')/sessions/<timestamp>/transcript.txt --out app.getPath('userData')/sessions/<timestamp>/summary.txt
```
