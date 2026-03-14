#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const candidates = [
  process.env.MEETING_NOTES_PYTHON,
  process.env.PYTHON,
  'python3',
  'python',
].filter(Boolean)

const args = ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v']

for (const command of candidates) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  })

  if (!result.error) {
    process.exit(result.status ?? 0)
  }
}

console.error(`Unable to find a Python interpreter. Tried: ${candidates.join(', ')}`)
process.exit(1)
