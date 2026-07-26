import { appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, desktopCapturer, screen } from 'electron'
import type { GameCapture } from '../plugin-sdk/src/types'
import type { GameWindowDesktopSourceInfo } from './handlers/screen-source'
import { ElectronCaptureStreamSession } from './screen-capture/stream-session'

interface ProbeGeneration {
  generation: number
  sourceId: string
  frameSize: { width: number; height: number }
  gameSize: { width: number; height: number }
  frames: number
  changedFrames: number
  p95CaptureMs: number
  maxCaptureMs: number
}

const DEFAULT_DURATION_MS = 120_000
const DEFAULT_CADENCE_MS = 500
const PROBE_WIDTH = 320
const PROBE_HEIGHT = 180

function trace(event: string, details: Record<string, unknown> = {}): void {
  appendFileSync(
    join(app.getPath('userData'), 'capture-host-probe-events.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`,
    'utf8',
  )
}

trace('module-loaded', { argv: process.argv, appPath: app.getAppPath() })

function numericArg(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

function stringArg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function recordResult(result: unknown): void {
  const serialized = `${JSON.stringify(result)}\n`
  const resultPath = stringArg('result') ?? join(app.getPath('userData'), 'capture-host-probe-result.json')
  writeFileSync(resultPath, serialized, 'utf8')
  process.stdout.write(serialized)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sampleSignature(capture: GameCapture): number {
  let hash = 2166136261
  const step = Math.max(4, Math.floor(capture.pixels.length / 1024 / 4) * 4)
  for (let offset = 0; offset < capture.pixels.length; offset += step) {
    hash ^= capture.pixels[offset]
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function percentile95(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))] ?? 0
}

async function resolvePoeSource(): Promise<GameWindowDesktopSourceInfo | null> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 4096, height: 2160 },
    fetchWindowIcons: false,
  })
  const source =
    sources.find((candidate) => candidate.name === 'Path of Exile 2') ??
    sources.find((candidate) => candidate.name === 'Path of Exile')
  if (!source) return null

  const frameSize = source.thumbnail.getSize()
  if (frameSize.width <= 0 || frameSize.height <= 0) return null
  const display =
    screen.getAllDisplays().find((candidate) => String(candidate.id) === source.display_id) ??
    screen.getPrimaryDisplay()
  const scaleFactor = Math.max(0.1, display.scaleFactor)
  return {
    source,
    sourceId: source.id,
    displayScaleFactor: scaleFactor,
    gameSize: {
      w: Math.max(1, Math.round(frameSize.width / scaleFactor)),
      h: Math.max(1, Math.round(frameSize.height / scaleFactor)),
    },
  }
}

async function runGeneration(generation: number, frames: number, cadenceMs: number): Promise<ProbeGeneration> {
  trace('generation-create', { generation, frames, cadenceMs })
  const captureSession = new ElectronCaptureStreamSession(generation, resolvePoeSource, resolve(__dirname, '../..'))
  let fatal: Error | undefined
  const unsubscribe = captureSession.onFatal((error) => {
    fatal = error
  })
  try {
    await captureSession.start()
    trace('generation-started', {
      generation,
      sourceId: captureSession.sourceId,
      frameSize: captureSession.frameSize,
      gameSize: captureSession.gameSize,
    })
    const gameSize = captureSession.gameSize
    const frameSize = captureSession.frameSize
    const sourceId = captureSession.sourceId
    if (!gameSize || !frameSize || !sourceId) {
      throw new Error('Capture session started without source/frame/game geometry.')
    }
    const region = {
      x: Math.max(0, Math.floor((gameSize.width - PROBE_WIDTH) / 2)),
      y: Math.max(0, Math.floor((gameSize.height - PROBE_HEIGHT) / 2)),
      width: Math.min(PROBE_WIDTH, gameSize.width),
      height: Math.min(PROBE_HEIGHT, gameSize.height),
    }
    const durations: number[] = []
    let previousSignature: number | undefined
    let changedFrames = 0

    for (let index = 0; index < frames; index += 1) {
      if (fatal) throw fatal
      const startedAt = performance.now()
      const capture = await captureSession.capture(region)
      const elapsed = performance.now() - startedAt
      durations.push(elapsed)
      const signature = sampleSignature(capture)
      if (previousSignature !== undefined && signature !== previousSignature) changedFrames += 1
      previousSignature = signature
      await delay(Math.max(0, cadenceMs - elapsed))
    }
    trace('generation-frames-complete', { generation, frames })

    return {
      generation,
      sourceId,
      frameSize,
      gameSize,
      frames,
      changedFrames,
      p95CaptureMs: Math.round(percentile95(durations) * 10) / 10,
      maxCaptureMs: Math.round(Math.max(...durations) * 10) / 10,
    }
  } finally {
    trace('generation-stop', { generation })
    unsubscribe()
    await captureSession.stop()
    captureSession.destroy()
    trace('generation-destroyed', { generation })
  }
}

async function main(): Promise<void> {
  const durationMs = numericArg('duration-ms', DEFAULT_DURATION_MS)
  const cadenceMs = numericArg('cadence-ms', DEFAULT_CADENCE_MS)
  const totalFrames = Math.max(2, Math.floor(durationMs / cadenceMs))
  const firstFrames = Math.max(1, Math.floor(totalFrames / 2))
  const secondFrames = Math.max(1, totalFrames - firstFrames)

  const startedAt = Date.now()
  const first = await runGeneration(1, firstFrames, cadenceMs)
  const second = await runGeneration(2, secondFrames, cadenceMs)
  recordResult({
    ok: true,
    requestedDurationMs: durationMs,
    actualDurationMs: Date.now() - startedAt,
    cadenceMs,
    totalFrames,
    recoveryBoundary: 'destroy-generation-1/create-fresh-partition-generation-2',
    generations: [first, second],
  })
}

void app
  .whenReady()
  .then(async () => {
    trace('app-ready')
    const sentinel = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true })
    try {
      await main()
    } finally {
      sentinel.destroy()
    }
  })
  .then(() => app.exit(0))
  .catch((caught) => {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    recordResult({ ok: false, error: error.stack ?? error.message })
    process.stderr.write(`${error.stack ?? error.message}\n`)
    app.exit(1)
  })
