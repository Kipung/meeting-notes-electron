#!/usr/bin/env python3
"""
List available PyAudio devices in JSON format.
"""
import json
import sys
try:
    import pyaudio
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)

def main():
    p = pyaudio.PyAudio()
    devices = []
    try:
        if sys.platform == "win32":
            try:
                import sounddevice  # noqa: F401
            except Exception:
                pass
            else:
                devices.append({
                    'index': -1,
                    'name': 'System + Default Mic (WASAPI)',
                    'maxInputChannels': 1,
                    'maxOutputChannels': 0,
                })
        for i in range(p.get_device_count()):
            try:
                info = p.get_device_info_by_index(i)
            except Exception:
                continue
            devices.append({
                'index': i,
                'name': info.get('name'),
                'maxInputChannels': info.get('maxInputChannels', 0),
                'maxOutputChannels': info.get('maxOutputChannels', 0),
            })
    finally:
        try:
            p.terminate()
        except Exception:
            pass

    print(json.dumps({'devices': devices}))

if __name__ == '__main__':
    main()
