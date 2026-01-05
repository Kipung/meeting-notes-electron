# Meeting Notes Electron

Record meetings, transcribe with Whisper, and summarize with a local GGUF/GGML Llama model. Sessions are stored on disk with audio, transcript, and summary files.

## Features

- Record from a selected input device
- Whisper transcription with selectable model size
- Automatic summarization after transcription using a local LLM (GGUF/GGML) via llama-cpp
- Multi-pass chunked summarization for long meetings
- Background chunk transcription to reduce wait time after Stop
- Session artifacts saved under `sessions/<timestamp>/`

## Project layout

- `electron/` - main process and IPC wiring
- `src/` - renderer UI
- `backend/` - Python scripts for recording, transcription, summarization
- `models/` - local GGUF/GGML model files

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
conda create -n meeting-notes python=3.10 -y
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

## Running

```bash
pnpm dev
```

## Summarization model

The app preloads a llama-cpp model via `backend/summarizer_daemon.py`.
It will prefer `models/Llama-3.2-3B-Instruct-Q4_K_M.gguf` if present, otherwise it picks the first `.gguf` file found in `models/`.
Override with an env var:

```bash
SUMMODEL=/path/to/your/model.gguf pnpm dev
```

The model path should be a GGUF or GGML file. A smaller Llama model (3B-8B) is a good starting point.

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

- `sessions/<timestamp>/audio.wav`
- `sessions/<timestamp>/transcript.txt`
- `sessions/<timestamp>/summary.txt`

## Manual summarization (LLM)

```bash
python3 backend/summarize_llm.py --model-path models/<your-model>.gguf --file sessions/<timestamp>/transcript.txt --out sessions/<timestamp>/summary.txt
```
