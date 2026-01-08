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
import warnings
import sys
import time
from typing import Optional
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


def _record_mic_only(args, warn_message: Optional[str] = None):
    if warn_message:
        print(json.dumps({"event": "warning", "msg": warn_message}), flush=True)

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


def _record_mix_system(args):
    if sys.platform != "win32":
        _record_mic_only(args, "system mix not supported; recording mic only")
        return
    try:
        import numpy as np
        import sounddevice as sd
    except Exception as exc:
        print(f"[record] Failed to import sounddevice: {exc}", file=sys.stderr, flush=True)
        _record_mic_only(args, "system audio unavailable; recording mic only")
        return

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    sample_width = 2
    wf = wave.open(args.out, "wb")
    wf.setnchannels(args.channels)
    wf.setsampwidth(sample_width)

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

    def to_mono(arr: "np.ndarray") -> "np.ndarray":
        if arr.ndim == 1:
            return arr
        if arr.shape[1] == 1:
            return arr[:, 0]
        return arr.mean(axis=1)

    fallback_message = None
    try:
        output_device = sd.default.device[1]
        output_info = sd.query_devices(output_device, "output")
        out_channels = max(1, int(output_info.get("max_output_channels", 2) or 2))
        out_channels = 2 if out_channels >= 2 else 1
        mix_rate = int(output_info.get("default_samplerate") or args.rate)
        wf.setframerate(mix_rate)
        try:
            loopback = sd.WasapiSettings(loopback=True)
        except TypeError as exc:
            print(f"[record] WASAPI loopback not supported by sounddevice: {exc}", file=sys.stderr, flush=True)
            try:
                wf.close()
            except Exception:
                pass
            wf = None
            _record_mix_system_soundcard(args, "system audio loopback not supported; trying soundcard")
            return

        if chunk_secs > 0:
            chunk_dir = os.path.join(os.path.dirname(args.out), "chunks")
            os.makedirs(chunk_dir, exist_ok=True)
            chunk_path = os.path.join(chunk_dir, f"chunk-{chunk_index:04d}.wav")
            chunk_wf = _open_chunk(chunk_path, args.channels, mix_rate, sample_width)
            chunk_start_t = time.time()

        try:
            mic_stream = None
            with sd.InputStream(
                samplerate=mix_rate,
                channels=out_channels,
                dtype="float32",
                blocksize=args.chunk,
                device=output_device,
                extra_settings=loopback,
            ) as sys_stream:
                try:
                    mic_stream = sd.InputStream(
                        samplerate=mix_rate,
                        channels=1,
                        dtype="float32",
                        blocksize=args.chunk,
                        device=None,
                    )
                    mic_stream.start()
                except Exception as exc:
                    mic_stream = None
                    print(json.dumps({"event": "warning", "msg": f"mic unavailable at {mix_rate} Hz; recording system audio only ({exc})"}), flush=True)

                print(f"[record] START out={args.out}", flush=True)

                start_t = time.time()
                last_print = 0.0
                while not STOP:
                    sys_data, _ = sys_stream.read(args.chunk)
                    sys_mono = to_mono(sys_data)
                    if mic_stream:
                        mic_data, _ = mic_stream.read(args.chunk)
                        mic_mono = to_mono(mic_data)
                        mixed = (0.5 * mic_mono) + (0.5 * sys_mono)
                        mixed = np.clip(mixed, -1.0, 1.0)
                        int16 = (mixed * 32767).astype(np.int16)
                    else:
                        int16 = (np.clip(sys_mono, -1.0, 1.0) * 32767).astype(np.int16)

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
                if mic_stream:
                    try:
                        mic_stream.stop()
                        mic_stream.close()
                    except Exception:
                        pass
        except Exception as exc:
            print(f"[record] Failed to open WASAPI loopback stream: {exc}", file=sys.stderr, flush=True)
            fallback_message = "system audio unavailable; recording mic only"
    finally:
        if wf:
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

    if fallback_message:
        _record_mic_only(args, fallback_message)
        return

    print("[record] STOP", flush=True)
    sys.exit(0)


def _record_mix_system_soundcard(args, warn_message: Optional[str] = None):
    try:
        import numpy as np
        import soundcard as sc
    except Exception as exc:
        print(f"[record] Failed to import soundcard: {exc}", file=sys.stderr, flush=True)
        _record_mic_only(args, "system audio unavailable; recording mic only")
        return

    warnings.filterwarnings("ignore", category=UserWarning, message=".*data discontinuity in recording.*")

    if warn_message:
        print(json.dumps({"event": "warning", "msg": warn_message}), flush=True)

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

    speaker = sc.default_speaker()
    loopback_mic = None
    try:
        loopback_mic = sc.get_microphone(speaker.name, include_loopback=True)
    except Exception:
        loopback_mic = None
    if loopback_mic is None or not getattr(loopback_mic, "isloopback", False):
        for mic in sc.all_microphones(include_loopback=True):
            if getattr(mic, "isloopback", False) and speaker.name in mic.name:
                loopback_mic = mic
                break
    if loopback_mic is None or not getattr(loopback_mic, "isloopback", False):
        for mic in sc.all_microphones(include_loopback=True):
            if getattr(mic, "isloopback", False):
                loopback_mic = mic
                break
    if loopback_mic is None or not getattr(loopback_mic, "isloopback", False):
        _record_mic_only(args, "system audio loopback not available; recording mic only")
        return

    loopback_rate = getattr(loopback_mic, "samplerate", None) or getattr(loopback_mic, "sampling_rate", None)
    if isinstance(loopback_rate, (int, float)) and loopback_rate > 0:
        loopback_rate = int(loopback_rate)
    else:
        loopback_rate = args.rate

    wf.setframerate(loopback_rate)
    if chunk_secs > 0 and chunk_wf:
        try:
            chunk_wf.close()
        except Exception:
            pass
        chunk_path = os.path.join(chunk_dir, f"chunk-{chunk_index:04d}.wav") if chunk_dir else None
        chunk_wf = _open_chunk(chunk_path, args.channels, loopback_rate, sample_width) if chunk_path else None
        chunk_start_t = time.time()

    print(json.dumps({"event": "warning", "msg": f"using loopback device: {loopback_mic.name} ({loopback_rate} Hz)"}), flush=True)

    mic = sc.default_microphone()
    mic_rec = None
    try:
        mic_rec = mic.recorder(samplerate=loopback_rate, channels=1)
    except Exception as exc:
        mic_rec = None
        print(json.dumps({"event": "warning", "msg": f"mic unavailable at {args.rate} Hz; recording system audio only ({exc})"}), flush=True)

    try:
        with loopback_mic.recorder(samplerate=loopback_rate, channels=2) as sys_rec:
            if mic_rec:
                mic_rec.__enter__()
            start_t = time.time()
            last_print = 0.0
            while not STOP:
                sys_data = sys_rec.record(args.chunk)
                sys_mono = to_mono(sys_data)
                if mic_rec:
                    mic_data = mic_rec.record(args.chunk)
                    mic_mono = to_mono(mic_data)
                    mixed = (0.5 * mic_mono) + (0.5 * sys_mono)
                    mixed = np.clip(mixed, -1.0, 1.0)
                    int16 = (mixed * 32767).astype(np.int16)
                else:
                    int16 = (np.clip(sys_mono, -1.0, 1.0) * 32767).astype(np.int16)

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
        print(f"[record] Failed to capture system audio (soundcard): {exc}", file=sys.stderr, flush=True)
        _record_mic_only(args, "system audio unavailable; recording mic only")
        return
    finally:
        if mic_rec:
            try:
                mic_rec.__exit__(None, None, None)
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

    _record_mic_only(args)


if __name__ == "__main__":
    main()
