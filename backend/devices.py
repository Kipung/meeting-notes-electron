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
    loopback_by_index = {}
    try:
        if sys.platform == 'win32' and hasattr(p, 'get_loopback_device_info_generator'):
            try:
                for info in p.get_loopback_device_info_generator():
                    idx = info.get('index')
                    loopback_by_index[idx] = {
                        'index': idx,
                        'name': info.get('name'),
                        'maxInputChannels': info.get('maxInputChannels', 0),
                        'maxOutputChannels': info.get('maxOutputChannels', 0),
                        'isLoopback': True,
                    }
            except Exception:
                loopback_by_index = {}
        for i in range(p.get_device_count()):
            try:
                info = p.get_device_info_by_index(i)
            except Exception:
                continue
            name = info.get('name')
            name_lower = name.lower() if isinstance(name, str) else ''
            is_loopback = 'loopback' in name_lower
            if sys.platform == 'darwin' and 'blackhole' in name_lower:
                is_loopback = True
            if i in loopback_by_index:
                continue
            devices.append({
                'index': i,
                'name': name,
                'maxInputChannels': info.get('maxInputChannels', 0),
                'maxOutputChannels': info.get('maxOutputChannels', 0),
                'isLoopback': is_loopback,
            })
        if loopback_by_index:
            devices.extend(loopback_by_index.values())
    finally:
        try:
            p.terminate()
        except Exception:
            pass

    print(json.dumps({'devices': devices}))

if __name__ == '__main__':
    main()
