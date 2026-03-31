import { BrowserWindow, ipcMain, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import { downloadFile } from './utils/fileDownloader'

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
