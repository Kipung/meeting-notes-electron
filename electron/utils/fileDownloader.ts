import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

export type DownloadProgress = {
  downloaded: number
  total?: number
  percent?: number
}

function getHttpClient(url: string): typeof https | typeof http {
  return url.startsWith('https:') ? https : http
}

/**
 * Downloads a file to destPath using a .partial temp file.
 * Follows redirects up to 10 times. Reports progress via optional callback.
 */
export function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void,
  redirects = 0,
): Promise<void> {
  if (redirects > 10) return Promise.reject(new Error('too many redirects'))
  return new Promise((resolve, reject) => {
    const client = getHttpClient(url)
    const request = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        resolve(downloadFile(res.headers.location, destPath, onProgress, redirects + 1))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`download failed with HTTP ${res.statusCode}`))
        return
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const tmpPath = `${destPath}.partial`
      const file = fs.createWriteStream(tmpPath)
      let downloaded = 0
      const total = Number(res.headers['content-length'] || 0)

      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        if (!onProgress) return
        if (total > 0) {
          onProgress({ downloaded, total, percent: Math.min(100, Math.round((downloaded / total) * 100)) })
        } else {
          onProgress({ downloaded })
        }
      })
      res.on('error', (err) => {
        file.close(() => undefined)
        try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
        reject(err)
      })
      file.on('error', (err) => {
        res.destroy()
        try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
        reject(err)
      })
      file.on('finish', () => {
        file.close(() => {
          fs.rename(tmpPath, destPath, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      })
      res.pipe(file)
    })
    request.on('error', reject)
  })
}

/**
 * Verifies a file's SHA256 hash matches expectedSha256 (lowercase hex).
 * Throws if the file is missing or the hash does not match.
 */
export function verifyFileSha256(filePath: string, expectedSha256: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => {
      const actual = hash.digest('hex')
      if (actual === expectedSha256.toLowerCase()) {
        resolve()
      } else {
        reject(new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`))
      }
    })
  })
}
