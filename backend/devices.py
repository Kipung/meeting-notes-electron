#!/usr/bin/env python3
"""
List available PyAudio devices in JSON format.
"""
import json
import sys
try:
    if sys.platform == 'win32':
        import pyaudiowpatch as pyaudio
    else:
        import pyaudio
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)

def main():
    p = pyaudio.PyAudio()
    devices = []
    try:
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
