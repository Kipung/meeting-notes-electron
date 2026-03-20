import { BrowserWindow, ipcMain, app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

export const QWEN_MODEL_NAME = 'qwen2.5-3b-instruct-q4_k_m.gguf'
const QWEN_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf'

/**
 * Returns true if the Qwen summary model is already present in any of the
 * known locations (userData, packaged resources, or dev-mode app root).
 */
export function isQwenModelPresent(): boolean {
  const candidates = [
    path.join(app.getPath('userData'), 'models', QWEN_MODEL_NAME),
    path.join(process.resourcesPath ?? '', 'models', QWEN_MODEL_NAME),
    path.join(process.env.APP_ROOT ?? '', 'models', QWEN_MODEL_NAME),
  ]
  return candidates.some((p) => fs.existsSync(p))
}

type DownloadProgress = {
  downloaded: number
  total?: number
  percent?: number
}

function getHttpClient(url: string): typeof https | typeof http {
  return url.startsWith('https:') ? https : http
}

function downloadFile(
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

export function createSetupWindow(options: {
  mainDist: string
  rendererDist: string
  viteDevServerUrl: string | undefined
  onComplete: () => void
}): BrowserWindow {
  const { mainDist, rendererDist, viteDevServerUrl, onComplete } = options

  const setupWin = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    center: true,
    icon: path.join(process.env.VITE_PUBLIC ?? '', 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(mainDist, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  // Prevent navigation away from the setup page
  setupWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  setupWin.webContents.on('will-navigate', (event, targetUrl) => {
    const current = setupWin.webContents.getURL()
    if (targetUrl !== current) event.preventDefault()
  })

  if (viteDevServerUrl) {
    void setupWin.loadURL(`${viteDevServerUrl}setup.html`)
  } else {
    void setupWin.loadFile(path.join(rendererDist, 'setup.html'))
  }

  // IPC: start model download — registered persistently so the user can retry on failure
  const handleDownload = async () => {
    const destPath = path.join(app.getPath('userData'), 'models', QWEN_MODEL_NAME)

    const send = (channel: string, payload?: unknown) => {
      if (!setupWin.isDestroyed()) setupWin.webContents.send(channel, payload)
    }

    // Already present (e.g. user clicked retry but model appeared meanwhile)
    if (fs.existsSync(destPath)) {
      send('setup:complete')
      setTimeout(() => {
        if (!setupWin.isDestroyed()) setupWin.close()
        onComplete()
      }, 1500)
      return
    }

    try {
      await downloadFile(QWEN_MODEL_URL, destPath, (progress) => {
        send('setup:progress', {
          percent: progress.percent ?? 0,
          message: 'Downloading Qwen 2.5 model...',
          downloaded: progress.downloaded,
          total: progress.total,
        })
      })

      send('setup:complete')
      setTimeout(() => {
        if (!setupWin.isDestroyed()) setupWin.close()
        onComplete()
      }, 1500)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send('setup:error', { message })
    }
  }

  ipcMain.handle('setup:start-download', handleDownload)

  // Clean up the IPC handler when the window closes
  setupWin.on('closed', () => {
    ipcMain.removeHandler('setup:start-download')
  })

  return setupWin
}
