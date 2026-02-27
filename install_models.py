import argparse
import os
import shutil
import sys
from importlib import resources
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np
from faster_whisper import WhisperModel


DEFAULT_WHISPER_MODEL = "medium.en"
DEFAULT_LLAMA_MODEL = "Llama-3.2-1B-Instruct-Q6_K.gguf"
DEFAULT_LLAMA_URL = (
    "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/"
    "Llama-3.2-1B-Instruct-Q6_K.gguf?download=true"
)
def log(message: str):
    print(message, flush=True)


def download_file(url: str, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    req = Request(url, headers={"User-Agent": "meeting-notes-model-installer/1.0"})
    with urlopen(req) as response, open(tmp, "wb") as fh:
        total = int(response.headers.get("Content-Length") or 0)
        read = 0
        log(f"Downloading {target.name} -> {target}")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            fh.write(chunk)
            read += len(chunk)
            if total > 0:
                percent = round((read / total) * 100, 2)
                log(f"  {percent}%")
    tmp.replace(target)


def whisper_cached(model_name: str, download_root: Path) -> bool:
    # Faster-whisper models are cached under HuggingFace-style repo cache names.
    cache_name = f"models--Systran--faster-whisper-{model_name}"
    return (download_root / cache_name).exists()


def ensure_whisper_model(model_name: str, whisper_dir: Path):
    whisper_dir.mkdir(parents=True, exist_ok=True)
    if whisper_cached(model_name, whisper_dir):
        log(f"Whisper model already present: {model_name} ({whisper_dir})")
        return
    log(f"Installing Whisper model: {model_name} ({whisper_dir})")
    model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=str(whisper_dir))
    warmup, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language="en", task="transcribe")
    for _ in warmup:
        pass
    log(f"Installed Whisper model: {model_name}")


def _resolve_silero_onnx_path() -> Path | None:
    try:
        import silero_vad

        # Newer releases package the ONNX model under silero_vad/data.
        pkg_path = resources.files("silero_vad").joinpath("data").joinpath("silero_vad.onnx")
        if pkg_path.is_file():
            return Path(str(pkg_path))

        # Fallback for layouts where model sits next to package files.
        module_dir = Path(silero_vad.__file__).resolve().parent
        candidate = module_dir / "data" / "silero_vad.onnx"
        if candidate.exists():
            return candidate
    except Exception:
        return None
    return None


def ensure_vad_model(vad_path: Path):
    if vad_path.exists():
        log(f"VAD model already present: {vad_path}")
        return

    log("Installing VAD model via silero_vad...")
    try:
        from silero_vad import load_silero_vad
    except Exception as exc:
        raise RuntimeError(f"failed to import silero_vad: {exc}") from exc

    try:
        # Lets silero_vad perform any internal model fetch/setup.
        load_silero_vad(onnx=True)
    except Exception as exc:
        raise RuntimeError(f"silero_vad failed to initialize ONNX model: {exc}") from exc

    source_path = _resolve_silero_onnx_path()
    if source_path is None or not source_path.exists():
        raise RuntimeError("could not locate silero_vad.onnx after load_silero_vad(onnx=True)")

    vad_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, vad_path)
    log(f"Installed VAD model: {vad_path}")


def ensure_llama_model(models_dir: Path, model_name: str, model_url: str):
    model_path = models_dir / model_name
    if model_path.exists():
        log(f"Llama model already present: {model_path}")
        return

    log(f"Installing Llama model: {model_path}")
    download_file(model_url, model_path)
    log("Installed Llama model")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prebuild model installer for packaging local models into the app bundle.",
    )
    parser.add_argument("--models-dir", default=str(Path(__file__).resolve().parent / "models"))
    parser.add_argument("--whisper-model", default=DEFAULT_WHISPER_MODEL)
    parser.add_argument("--llama-model-name", default=DEFAULT_LLAMA_MODEL)
    parser.add_argument("--llama-url", default=os.getenv("SUMMODEL_URL", DEFAULT_LLAMA_URL))
    return parser.parse_args()


def main():
    args = parse_args()
    models_dir = Path(args.models_dir).resolve()
    whisper_dir = models_dir / "whisper"
    vad_path = models_dir / "silero_vad.onnx"

    models_dir.mkdir(parents=True, exist_ok=True)
    log(f"Preparing models in: {models_dir}")
    ensure_whisper_model(args.whisper_model.strip() or DEFAULT_WHISPER_MODEL, whisper_dir)
    ensure_vad_model(vad_path)
    ensure_llama_model(
        models_dir,
        args.llama_model_name.strip() or DEFAULT_LLAMA_MODEL,
        args.llama_url.strip() or DEFAULT_LLAMA_URL,
    )
    log("All models are ready for packaging.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log(f"Model installation failed: {exc}")
        sys.exit(1)
