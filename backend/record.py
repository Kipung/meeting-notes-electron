#!/usr/bin/env python3
"""
Record microphone audio to a WAV file until terminated (SIGTERM/SIGINT).

Outputs:
- <session_dir>/audio.wav

Notes:
- Uses PyAudio (portaudio). This matches your existing stack.
- Designed to be controlled by Electron: Start spawns this process, Stop sends SIGTERM.
"""

import argparse
import json
import os
import signal
import sys
import time
import wave

import pyaudio

STOP = False


def _handle_stop(signum, frame):
    global STOP
    STOP = True


def _open_chunk(path: str, channels: int, rate: int, sample_width: int):
    wf = wave.open(path, "wb")
    wf.setnchannels(channels)
    wf.setsampwidth(sample_width)
    wf.setframerate(rate)
    return wf


def _emit_chunk(path: str, index: int):
    print(json.dumps({"event": "chunk", "path": path, "index": index}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="Output WAV path (e.g., sessions/.../audio.wav)")
    parser.add_argument("--rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--chunk", type=int, default=1024)
    parser.add_argument("--device-index", type=int, default=None, help="Optional input device index")
    parser.add_argument("--chunk-secs", type=int, default=0, help="Optional rolling chunk size in seconds")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    # Handle stop signals (Electron stop -> SIGTERM)
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    pa = pyaudio.PyAudio()

    stream_kwargs = dict(
        format=pyaudio.paInt16,
        channels=args.channels,
        rate=args.rate,
        input=True,
        frames_per_buffer=args.chunk,
    )
    if args.device_index is not None:
        stream_kwargs["input_device_index"] = args.device_index

    try:
        stream = pa.open(**stream_kwargs)
    except Exception as e:
        print(f"[record] Failed to open input stream: {e}", file=sys.stderr, flush=True)
        try:
            pa.terminate()
        except Exception:
            pass
        sys.exit(1)

    sample_width = pa.get_sample_size(pyaudio.paInt16)

    wf = wave.open(args.out, "wb")
    wf.setnchannels(args.channels)
    wf.setsampwidth(sample_width)
    wf.setframerate(args.rate)

    chunk_secs = max(args.chunk_secs or 0, 0)
    chunk_dir = None
    chunk_wf = None
    chunk_path = None
    chunk_index = 1
    chunk_start_t = time.time()
    chunk_bytes = 0
    if chunk_secs > 0:
        chunk_dir = os.path.join(os.path.dirname(args.out), "chunks")
        os.makedirs(chunk_dir, exist_ok=True)
        chunk_path = os.path.join(chunk_dir, f"chunk-{chunk_index:04d}.wav")
        chunk_wf = _open_chunk(chunk_path, args.channels, args.rate, sample_width)
        chunk_start_t = time.time()

    print(f"[record] START out={args.out}", flush=True)

    start_t = time.time()
    last_print = 0.0

    try:
        while not STOP:
            data = stream.read(args.chunk, exception_on_overflow=False)
            wf.writeframes(data)
            if chunk_wf:
                chunk_wf.writeframes(data)
                chunk_bytes += len(data)

            elapsed = time.time() - start_t
            if elapsed - last_print >= 1.0:
                last_print = elapsed
                print(f"[record] seconds={int(elapsed)}", flush=True)

            if chunk_wf and chunk_secs > 0 and (time.time() - chunk_start_t) >= chunk_secs:
                try:
                    chunk_wf.close()
                except Exception:
                    pass
                if chunk_bytes > 0 and chunk_path:
                    _emit_chunk(chunk_path, chunk_index)
                chunk_index += 1
                chunk_path = os.path.join(chunk_dir, f"chunk-{chunk_index:04d}.wav") if chunk_dir else None
                chunk_wf = _open_chunk(chunk_path, args.channels, args.rate, sample_width) if chunk_path else None
                chunk_start_t = time.time()
                chunk_bytes = 0

    finally:
        try:
            stream.stop_stream()
            stream.close()
        except Exception:
            pass
        try:
            pa.terminate()
        except Exception:
            pass
        try:
            wf.close()
        except Exception:
            pass
        if chunk_wf:
            try:
                chunk_wf.close()
            except Exception:
                pass
            if chunk_bytes > 0 and chunk_path:
                _emit_chunk(chunk_path, chunk_index)

    print("[record] STOP", flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
