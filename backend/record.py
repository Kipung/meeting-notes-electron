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


def _write_frames(wf, chunk_wf, data_bytes: bytes) -> int:
    wf.writeframes(data_bytes)
    if chunk_wf:
        chunk_wf.writeframes(data_bytes)
    return len(data_bytes)


def _record_mix_system(args):
    if sys.platform != "win32":
        print("[record] System mix is only supported on Windows", file=sys.stderr, flush=True)
        sys.exit(1)
    try:
        import numpy as np
        import sounddevice as sd
    except Exception as exc:
        print(f"[record] Failed to import sounddevice: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    sample_width = 2
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

    def to_mono(arr: "np.ndarray") -> "np.ndarray":
        if arr.ndim == 1:
            return arr
        if arr.shape[1] == 1:
            return arr[:, 0]
        return arr.mean(axis=1)

    try:
        output_device = sd.default.device[1]
        output_info = sd.query_devices(output_device, "output")
        out_channels = max(1, int(output_info.get("max_output_channels", 2) or 2))
        out_channels = 2 if out_channels >= 2 else 1
        loopback = sd.WasapiSettings(loopback=True)

        try:
            with sd.InputStream(
                samplerate=args.rate,
                channels=1,
                dtype="float32",
                blocksize=args.chunk,
                device=None,
            ) as mic_stream, sd.InputStream(
                samplerate=args.rate,
                channels=out_channels,
                dtype="float32",
                blocksize=args.chunk,
                device=output_device,
                extra_settings=loopback,
            ) as sys_stream:
                start_t = time.time()
                last_print = 0.0
                while not STOP:
                    mic_data, _ = mic_stream.read(args.chunk)
                    sys_data, _ = sys_stream.read(args.chunk)
                    mic_mono = to_mono(mic_data)
                    sys_mono = to_mono(sys_data)
                    mixed = (0.5 * mic_mono) + (0.5 * sys_mono)
                    mixed = np.clip(mixed, -1.0, 1.0)
                    int16 = (mixed * 32767).astype(np.int16)

                    if args.channels > 1:
                        int16 = np.column_stack([int16] * args.channels)
                    data_bytes = int16.tobytes()
                    chunk_bytes += _write_frames(wf, chunk_wf, data_bytes)

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
        except Exception as exc:
            print(f"[record] Failed to open WASAPI loopback stream: {exc}", file=sys.stderr, flush=True)
            sys.exit(1)
    finally:
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="Output WAV path (e.g., sessions/.../audio.wav)")
    parser.add_argument("--rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--chunk", type=int, default=1024)
    parser.add_argument("--device-index", type=int, default=None, help="Optional input device index")
    parser.add_argument("--chunk-secs", type=int, default=0, help="Optional rolling chunk size in seconds")
    parser.add_argument("--mix-system", action="store_true", help="Mix system audio (WASAPI loopback) with the default mic")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    if args.mix_system:
        _record_mix_system(args)
        return

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
