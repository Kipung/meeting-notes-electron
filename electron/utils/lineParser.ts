/**
 * Returns a stateful data handler for a Node.js child process stdout stream.
 *
 * Accumulates incoming chunks in an internal buffer, splits on newlines, and
 * calls `onLine` for each complete JSON line. Non-JSON lines are silently skipped.
 *
 * Usage:
 *   proc.stdout.on('data', makeJsonLineParser<MyEvent>((obj) => { ... }))
 */
export function makeJsonLineParser<T>(onLine: (obj: T) => void): (data: Buffer) => void {
  let buf = ''
  return (data: Buffer) => {
    buf += data.toString()
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const raw of parts) {
      const line = raw.trim()
      if (!line) continue
      try {
        onLine(JSON.parse(line) as T)
      } catch {
        // skip non-JSON lines (e.g. model load progress from llama.cpp)
      }
    }
  }
}
