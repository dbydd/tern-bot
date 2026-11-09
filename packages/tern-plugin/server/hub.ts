#!/usr/bin/env bun
/**
 * Tern-Bot Single-Authority Hub companion (`urn:onlyne:hub:tern-bot`).
 *
 * Supervised by `packages/tern-plugin/host.luau`:
 *   1. Canonical Bot / Worker registry (`bots`), fed over `/onlyne/v3` or `/hub/bots`.
 *   2. Shared `ComputeBrokerService` (`DockerSandboxDriver` on OrbStack/Docker).
 *   3. Low-overhead Docker Activity Monitor sampler (`docker stats --no-stream`)
 *      producing per-container live rates + 24-point history series for Total CPU,
 *      Memory, Network, and Disk sparklines.
 *   4. Zero-stream keyframe thumbnail cache (`/hub/thumb/:workerId`): captures the
 *      sandbox's X display as a compact JPEG every 3.5s while a sandbox is active,
 *      bumping `thumbSeq` only when bytes actually change so `host.luau` never
 *      re-uploads unchanged blobs.
 */

import {
  DockerSandboxDriver,
  MockSandboxDriver,
  OrbstackMachineDriver,
  type AcquireSpec,
  type SandboxDescriptor,
  type SandboxDriver,
} from "@onlyne/compute-core"
import { ComputeBrokerService } from "@onlyne/compute-gateway"
import {
  MemoryStorage,
  OnlyneNode,
  type DeliveryPlan,
  type Entry,
  type Json,
  type MaintenanceClock,
  type NotifyEvent,
  type Plugins,
  type ThreadRef,
} from "@onlyne/lib"
import type { WorkRef } from "@onlyne/lib"
import { OnlyneError } from "@onlyne/lib"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export interface HubWorkerRecord {
  workerId: string
  taskId: string
  title: string
  description: string
  state: string
  dispatchedAt: number
  needsReview: boolean
  observations: number
  intervening?: boolean
  desktopUrl?: string
  interactiveDesktopUrl?: string
  cdpEndpoint?: string
  httpEndpoint?: string
  lastScreenshotPath?: string
  rejectionReason?: string
}

export interface HubBotRecord {
  botId: string
  workspace: string
  state: "idle" | "working" | "waiting" | "starting"
  /** The daemon instance that owns this board, and the process it runs in. */
  instanceId?: string
  pid?: number
  mainPane?: number
  boardPane?: number
  tab?: number
  contextTokens?: number
  contextBudget?: number
  updatedAt: number
  workers: HubWorkerRecord[]
}

export interface ContainerStatRow {
  id: string
  name: string
  group: "sandbox" | "service"
  cpuPct: number
  cpuText: string
  memBytes: number
  memText: string
  netRateBps: number
  netText: string
  diskRateBps: number
  diskText: string
}

export interface ActivityMonitorSnapshot {
  updatedAt: number
  totalCpuPct: number
  totalCpuText: string
  totalMemBytes: number
  totalMemText: string
  totalNetBps: number
  totalNetText: string
  totalDiskBps: number
  totalDiskText: string
  containers: ContainerStatRow[]
  series: {
    cpu: Array<[string, number]>
    mem: Array<[string, number]>
    net: Array<[string, number]>
    disk: Array<[string, number]>
  }
}

export interface HubConnectionInfo {
  port: number
  adminUrl: string
  endpoint: string
  nodeId: string
  pid: number
  token: string
  repoRoot: string
  /** omp executable used by the Tern Create Bot command. */
  ompBin: string
  /** Agent config root for every bot: PI_CODING_AGENT_DIR points here. */
  botConfigDir: string
}

const HUB_NODE_ID = "urn:onlyne:hub:tern-bot"
const RECORD_PLAN: DeliveryPlan = { response: "none", execution: "existing" }
const HEARTBEAT_TIMEOUT_MS = 90_000
const DEFAULT_CONTEXT_BUDGET = 131_072
const SERIES_LEN = 24

const dataDir =
  process.env.TERN_BOT_DATA ??
  process.env.TERN_PLUGIN_DATA ??
  join(homedir(), ".config", "tern-bot", "hub-data")
const botConfigDir = process.env.TERN_BOT_CONFIG_DIR ?? join(homedir(), ".config", "tern-bot")
const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const token = process.env.TERN_BOT_HUB_TOKEN ?? crypto.randomUUID()

// macOS GUI apps launch with a minimal PATH (/usr/bin:/bin); prepend OrbStack & Homebrew dirs
const extraPaths = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  join(homedir(), ".orbstack", "bin"),
  "/Applications/OrbStack.app/Contents/MacOS/xbin",
  join(homedir(), ".bun", "bin"),
]
process.env.PATH = `${extraPaths.join(":")}:${process.env.PATH ?? "/usr/bin:/bin"}`

const ompBin =
  process.env.TERN_BOT_OMP_BIN ??
  [
    join(homedir(), "Library", "Application Support", "Tern", "omp", "bin", "omp"),
    "/opt/homebrew/bin/omp",
    Bun.which("omp"),
  ].find((p): p is string => typeof p === "string" && existsSync(p)) ?? "omp"

const dockerBin =
  [
    "/usr/local/bin/docker",
    "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
    "/opt/homebrew/bin/docker",
  ].find((p) => existsSync(p)) ?? "docker"

mkdirSync(dataDir, { recursive: true })
mkdirSync(botConfigDir, { recursive: true })

const hubJsonPrimary = join(dataDir, "hub.json")
const hubJsonMirror = join(botConfigDir, "hub.json")

const bots = new Map<string, HubBotRecord>()
/** Live bot endpoints, learned from `/hub/peers`; `resolve` needs them to push replies. */
const peers = new Map<string, string>()
let ledgerThread: ThreadRef | undefined
let lastProbeAt = Date.now()

const hasDocker =
  existsSync("/var/run/docker.sock") ||
  existsSync(join(homedir(), ".orbstack", "run", "docker.sock"))
/**
 * `TERN_BOT_DRIVER` picks the sandbox provider: `orbstack` runs an isolated Linux machine per
 * lease, `docker` runs a container, `mock` runs nothing. Auto prefers Docker whenever its
 * socket exists: the sandbox image ships the desktop, Chromium and the agent CLI, and an
 * OrbStack machine created from a distro image carries none of them.
 */
const driverMode = (process.env.TERN_BOT_DRIVER ?? "auto").toLowerCase()
const orbctlBin = ["/opt/homebrew/bin/orbctl", "/usr/local/bin/orbctl"].find((p) => existsSync(p))

function selectDriver(): SandboxDriver {
  if (driverMode === "mock") return new MockSandboxDriver()
  if (driverMode === "docker") return new DockerSandboxDriver({ id: "orbstack-docker" })
  if (driverMode === "orbstack" && orbctlBin !== undefined) {
    return new OrbstackMachineDriver({ id: "orbstack-isolated-vm", orbctlPath: orbctlBin })
  }
  if (hasDocker) return new DockerSandboxDriver({ id: "orbstack-docker" })
  if (orbctlBin !== undefined) {
    return new OrbstackMachineDriver({ id: "orbstack-isolated-vm", orbctlPath: orbctlBin })
  }
  return new MockSandboxDriver()
}

const driver: SandboxDriver = selectDriver()

const compute = new ComputeBrokerService({
  nodeId: HUB_NODE_ID,
  storage: new MemoryStorage(),
  driver,
})

const sweepTimer = setInterval(() => {
  void compute.sweep().catch(() => undefined)
}, 20_000)
sweepTimer.unref?.()

// ---- Keyframe Thumbnail Cache (zero-stream, compact JPEG) ----

interface CachedThumb {
  seq: number
  mime: string
  bytes: Uint8Array
  hash: number
  capturedAt: number
}

const workerThumbs = new Map<string, CachedThumb>()
let thumbGlobalSeq = 0
let thumbCaptureBusy = false

/** Two bots both number their workers `worker-1`, so a bare worker id names no single desktop. */
function thumbKey(botId: string, workerId: string): string {
  return `${botId}/${workerId}`
}

/** Both bots number their workers from `worker-1`, so every worker route carries `?bot=`. */
function botParam(url: URL): string | undefined {
  const raw = url.searchParams.get("bot")
  return raw !== null && raw.length > 0 ? raw : undefined
}

function quickHash(buf: Uint8Array): number {
  let h = 2166136261
  const step = Math.max(1, Math.floor(buf.length / 256))
  for (let i = 0; i < buf.length; i += step) {
    h ^= buf[i]!
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function storeThumb(botId: string, workerId: string, bytes: Uint8Array, mime: string): void {
  const h = quickHash(bytes)
  const key = thumbKey(botId, workerId)
  const prev = workerThumbs.get(key)
  if (prev && prev.hash === h && prev.bytes.length === bytes.length) {
    prev.capturedAt = Date.now()
    return
  }
  thumbGlobalSeq += 1
  workerThumbs.set(key, {
    seq: thumbGlobalSeq,
    mime,
    bytes,
    hash: h,
    capturedAt: Date.now(),
  })
}

/**
 * The preview shows the sandbox desktop, which is an Xvfb root window, not a browser page.
 * CDP only sees Chromium's own page, and this image boots Chromium on `about:blank`, so a
 * page capture found no usable target and the mini PiP stayed empty forever. `import` grabs
 * the whole display the worker actually sees.
 */
async function captureDisplayJpeg(containerId: string): Promise<Uint8Array | null> {
  try {
    const proc = Bun.spawn(
      [
        dockerBin,
        "exec",
        containerId,
        "import",
        "-display",
        ":99",
        "-window",
        "root",
        "-resize",
        "480x",
        "jpg:-",
      ],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    )
    const guard = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
    }, 4000)
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
    const status = await proc.exited
    clearTimeout(guard)
    return status === 0 && bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

/** Running container ids for one bot, keyed by lease name (`<botId>-<workerId>`). */
async function botContainerIds(botId: string): Promise<Map<string, string>> {
  const byLeaseName = new Map<string, string>()
  const listed = await compute
    .status(`urn:onlyne:agent:${botId}`)
    .catch(() => [] as SandboxDescriptor[])
  for (const lease of Array.isArray(listed) ? listed : [listed]) {
    const containerId = lease?.allocated?.container_id
    if (containerId !== undefined && lease.state === "running") {
      byLeaseName.set(lease.name, containerId)
    }
  }
  return byLeaseName
}

async function refreshKeyframes(): Promise<void> {
  if (thumbCaptureBusy || Date.now() - lastProbeAt > 15_000) return
  thumbCaptureBusy = true
  try {
    for (const bot of bots.values()) {
      const byLeaseName = await botContainerIds(bot.botId)
      for (const w of bot.workers) {
        // A worker in review drives its review lease, whose desktop is the current screen.
        const containerId =
          byLeaseName.get(`${bot.botId}-review-${w.taskId}`) ??
          byLeaseName.get(`${bot.botId}-${w.workerId}`)
        if (containerId !== undefined) {
          const jpg = await captureDisplayJpeg(containerId)
          if (jpg !== null) {
            storeThumb(bot.botId, w.workerId, jpg, "image/jpeg")
            continue
          }
        }
        if (w.lastScreenshotPath && existsSync(w.lastScreenshotPath)) {
          try {
            const raw = new Uint8Array(readFileSync(w.lastScreenshotPath))
            if (raw.length > 0) {
              storeThumb(
                bot.botId,
                w.workerId,
                raw,
                w.lastScreenshotPath.endsWith(".png") ? "image/png" : "image/jpeg",
              )
            }
          } catch {}
        }
      }
    }
  } finally {
    thumbCaptureBusy = false
  }
}

const thumbTimer = setInterval(() => {
  void refreshKeyframes()
}, 3500)
thumbTimer.unref?.()

// ---- Docker Activity Monitor Sampler (OrbStack style) ----

function parseByteUnit(raw: string): number {
  const m = raw.trim().match(/^([0-9.]+)\s*([a-zA-Z]+)?$/)
  if (!m) return 0
  const num = Number.parseFloat(m[1] ?? "0")
  if (!Number.isFinite(num)) return 0
  const unit = (m[2] ?? "B").toLowerCase()
  if (unit === "b") return num
  if (unit === "kb") return num * 1_000
  if (unit === "kib") return num * 1_024
  if (unit === "mb") return num * 1_000_000
  if (unit === "mib") return num * 1_048_576
  if (unit === "gb") return num * 1_000_000_000
  if (unit === "gib") return num * 1_073_741_824
  if (unit === "tb" || unit === "tib") return num * 1_099_511_627_776
  return num
}

function parseIoPair(raw: string): number {
  const parts = raw.split("/")
  return parseByteUnit(parts[0] ?? "0") + parseByteUnit(parts[1] ?? "0")
}

function formatBytesHuman(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_073_741_824).toFixed(2)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`
  return `${Math.round(bytes)} B`
}

function formatRateHuman(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kB/s`
  if (bps > 0) return `1 kB/s`
  return `0 kB/s`
}

const prevIoByContainer = new Map<string, { at: number; net: number; disk: number }>()
const cpuHistory: number[] = Array.from({ length: SERIES_LEN }, () => 0)
const memHistory: number[] = Array.from({ length: SERIES_LEN }, () => 0)
const netHistory: number[] = Array.from({ length: SERIES_LEN }, () => 0)
const diskHistory: number[] = Array.from({ length: SERIES_LEN }, () => 0)

let latestActivity: ActivityMonitorSnapshot = {
  updatedAt: Date.now(),
  totalCpuPct: 0,
  totalCpuText: "0.0%",
  totalMemBytes: 0,
  totalMemText: "0 MB",
  totalNetBps: 0,
  totalNetText: "0 kB/s",
  totalDiskBps: 0,
  totalDiskText: "0 kB/s",
  containers: [],
  series: { cpu: [], mem: [], net: [], disk: [] },
}

let statsBusy = false

async function sampleDockerStats(): Promise<void> {
  if (!hasDocker || statsBusy || Date.now() - lastProbeAt > 20_000) return
  statsBusy = true
  try {
    const proc = Bun.spawn([dockerBin, "stats", "--no-stream", "--format", "{{json .}}"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    // A wedged daemon makes `docker stats` hang for minutes; the sample is optional, so the
    // process is killed and this pass skipped rather than stalling the hub's event loop.
    const guard = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }, 4000)
    const text = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(guard)

    const now = Date.now()
    const rows: ContainerStatRow[] = []
    let sumCpu = 0
    let sumMem = 0
    let sumNetBps = 0
    let sumDiskBps = 0

    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) continue
      try {
        const obj = JSON.parse(trimmed) as {
          ID?: string
          Name?: string
          CPUPerc?: string
          MemUsage?: string
          NetIO?: string
          BlockIO?: string
        }
        const id = obj.ID ?? ""
        const name = obj.Name ?? id
        const cpuPct = Number.parseFloat((obj.CPUPerc ?? "0").replace("%", "")) || 0
        const memFirst = (obj.MemUsage ?? "0B / 0B").split("/")[0] ?? "0B"
        const memBytes = parseByteUnit(memFirst)
        const netTotal = parseIoPair(obj.NetIO ?? "0B / 0B")
        const diskTotal = parseIoPair(obj.BlockIO ?? "0B / 0B")

        const prev = prevIoByContainer.get(name)
        let netRateBps = 0
        let diskRateBps = 0
        if (prev && now > prev.at) {
          const dtSec = Math.max(0.5, (now - prev.at) / 1000)
          netRateBps = Math.max(0, (netTotal - prev.net) / dtSec)
          diskRateBps = Math.max(0, (diskTotal - prev.disk) / dtSec)
        }
        prevIoByContainer.set(name, { at: now, net: netTotal, disk: diskTotal })

        const isSandbox = name.startsWith("oecp-") || name.includes("tern-bot")
        rows.push({
          id,
          name,
          group: isSandbox ? "sandbox" : "service",
          cpuPct,
          cpuText: `${cpuPct.toFixed(1)}%`,
          memBytes,
          memText: formatBytesHuman(memBytes),
          netRateBps,
          netText: formatRateHuman(netRateBps),
          diskRateBps,
          diskText: formatRateHuman(diskRateBps),
        })

        sumCpu += cpuPct
        sumMem += memBytes
        sumNetBps += netRateBps
        sumDiskBps += diskRateBps
      } catch {}
    }

    // Sort: sandboxes first, then by CPU / Memory descending
    rows.sort((a, b) => {
      if (a.group !== b.group) return a.group === "sandbox" ? -1 : 1
      return b.memBytes - a.memBytes
    })

    cpuHistory.push(Number(sumCpu.toFixed(2)))
    if (cpuHistory.length > SERIES_LEN) cpuHistory.shift()
    memHistory.push(Math.round(sumMem / 1_048_576)) // MB
    if (memHistory.length > SERIES_LEN) memHistory.shift()
    netHistory.push(Math.round(sumNetBps / 1000)) // kB/s
    if (netHistory.length > SERIES_LEN) netHistory.shift()
    diskHistory.push(Math.round(sumDiskBps / 1000)) // kB/s
    if (diskHistory.length > SERIES_LEN) diskHistory.shift()

    latestActivity = {
      updatedAt: now,
      totalCpuPct: Number(sumCpu.toFixed(1)),
      totalCpuText: `${sumCpu.toFixed(1)}%`,
      totalMemBytes: sumMem,
      totalMemText: formatBytesHuman(sumMem),
      totalNetBps: sumNetBps,
      totalNetText: formatRateHuman(sumNetBps),
      totalDiskBps: sumDiskBps,
      totalDiskText: formatRateHuman(sumDiskBps),
      containers: rows,
      series: {
        cpu: cpuHistory.map((v, i) => [`t${i}`, v]),
        mem: memHistory.map((v, i) => [`t${i}`, v]),
        net: netHistory.map((v, i) => [`t${i}`, v]),
        disk: diskHistory.map((v, i) => [`t${i}`, v]),
      },
    }
  } catch {
    // ignore transient docker cli errors
  } finally {
    statsBusy = false
  }
}

void sampleDockerStats()
const statsTimer = setInterval(() => {
  void sampleDockerStats()
}, 2500)
statsTimer.unref?.()

// ---- Onlyne Protocol & Bot Registry ----

function readData(entry: Entry): Record<string, Json> {
  const data = entry.message.meta?.data
  return data === undefined ? {} : data
}

function asString(value: Json | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: Json | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function mergeWorker(prev: HubWorkerRecord | undefined, next: HubWorkerRecord): HubWorkerRecord {
  return { ...prev, ...next, intervening: next.intervening ?? prev?.intervening ?? false }
}

/** The bot a sync's authenticated sender speaks for; the hub and unknown actors speak for none. */
function actorBotId(sender: string): string | undefined {
  return /^urn:onlyne:(?:agent|bot):(.+)$/.exec(sender)?.[1]
}

/**
 * Who may move one bot's board. A snapshot is numbered inside the instance that wrote it, and
 * an instance that started later takes the bot over. A heartbeat that arrives late, an Onlyne
 * retry that replays an older entry, and a second daemon still running for the same bot would
 * each flip the board backwards, so they move nothing.
 */
interface BoardOwner {
  instanceId: string
  startedAt: number
  seq: number
}

const boardOwners = new Map<string, BoardOwner>()

const WORKING_STATES: Record<string, true> = { DISPATCHED: true, WORKING: true, REVIEWING: true }

function deriveState(declared: string | undefined, workers: HubWorkerRecord[]): HubBotRecord["state"] {
  if (workers.some((worker) => worker.needsReview)) return "waiting"
  if (workers.some((worker) => WORKING_STATES[worker.state] === true)) return "working"
  if (declared === "idle" || declared === "working" || declared === "waiting" || declared === "starting") {
    return declared
  }
  return "idle"
}

/** Applies one numbered board snapshot, or drops it when a newer word about this bot exists. */
function applyBotSync(sender: string, data: Record<string, Json>): void {
  const botId = actorBotId(sender)
  if (botId === undefined) return
  const declaredBotId = asString(data.botId)
  if (declaredBotId !== undefined && declaredBotId !== botId) return

  const instanceId = asString(data.instanceId)
  const seq = asNumber(data.seq)
  const startedAt = asNumber(data.startedAt)
  if (instanceId === undefined || seq === undefined || startedAt === undefined) return
  if (!Array.isArray(data.workers)) return

  const owner = boardOwners.get(botId)
  if (owner !== undefined) {
    if (owner.instanceId === instanceId) {
      if (seq <= owner.seq) return
    } else if (
      startedAt < owner.startedAt ||
      (startedAt === owner.startedAt && instanceId <= owner.instanceId)
    ) {
      return
    }
  }

  const prev = bots.get(botId)
  const prevByWorker = new Map((prev?.workers ?? []).map((worker) => [worker.workerId, worker]))
  const workers = (data.workers as unknown as HubWorkerRecord[]).map((worker) =>
    mergeWorker(prevByWorker.get(worker.workerId), worker),
  )
  const declared = asString(data.state)

  // Ids restart at `worker-1` for every task, so a re-dispatch keeps the id and changes the
  // dispatch time; the old desktop must not stand in for the new worker's screen.
  for (const worker of workers) {
    const before = prevByWorker.get(worker.workerId)
    if (before !== undefined && before.dispatchedAt !== worker.dispatchedAt) {
      workerThumbs.delete(thumbKey(botId, worker.workerId))
    }
  }

  boardOwners.set(botId, { instanceId, startedAt, seq })
  bots.set(botId, {
    botId,
    instanceId,
    pid: asNumber(data.pid),
    workspace: asString(data.workspace) ?? prev?.workspace ?? repoRoot,
    state: data.stopped === true ? "idle" : deriveState(declared, workers),
    mainPane: asNumber(data.mainPane) ?? prev?.mainPane,
    boardPane: asNumber(data.boardPane) ?? prev?.boardPane,
    tab: asNumber(data.tab) ?? prev?.tab,
    contextTokens: asNumber(data.contextTokens) ?? prev?.contextTokens,
    contextBudget: asNumber(data.contextBudget) ?? prev?.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    updatedAt: Date.now(),
    workers,
  })

  void refreshKeyframes()
}

/**
 * `/hub/bots` is Tern announcing a bot it is about to launch. The registration creates the
 * record and refreshes what Tern knows, but the board belongs to the bot's own numbered
 * snapshots: a registration never clears workers and never moves a live state.
 */
function registerBot(data: Record<string, Json>): HubBotRecord | undefined {
  const botId = asString(data.botId)
  if (botId === undefined) return undefined
  const prev = bots.get(botId)
  const record: HubBotRecord = {
    botId,
    instanceId: prev?.instanceId,
    pid: prev?.pid,
    workspace: asString(data.workspace) ?? prev?.workspace ?? repoRoot,
    state: prev?.state ?? "starting",
    mainPane: asNumber(data.mainPane) ?? prev?.mainPane,
    boardPane: asNumber(data.boardPane) ?? prev?.boardPane,
    tab: asNumber(data.tab) ?? prev?.tab,
    contextTokens: asNumber(data.contextTokens) ?? prev?.contextTokens,
    contextBudget: asNumber(data.contextBudget) ?? prev?.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    updatedAt: Date.now(),
    workers: prev?.workers ?? [],
  }
  bots.set(botId, record)
  return record
}

function applyInbound(entry: Entry): void {
  const kind = entry.message.delivery_kind
  if (kind !== "tern-bot.bot.sync") return
  applyBotSync(entry.authenticated_author, readData(entry))
}

let endpoint = "http://127.0.0.1:0/onlyne/v3"

const maintenanceClock: MaintenanceClock = {
  setTimer: (ms: number, run: () => void) => {
    const handle = setTimeout(run, ms)
    handle.unref?.()
    return handle
  },
  clearTimer: (handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

const plugins: Plugins = {
  authenticate: async (request: Request) => {
    const actor = request.headers.get("Onlyne-Actor")
    return { actor: actor !== null && actor.length > 0 ? actor : HUB_NODE_ID }
  },
  inboundThread: async () => true,
  mayAdmit: async () => true,
  // A bot returns its own listener address when it registers, so a reply is a push to that
  // address. An id nobody registered is served here, which keeps local records working.
  resolve: async (id) => ({
    node_id: id,
    base_url: peers.get(id) ?? endpoint,
    headers: { "Onlyne-Actor": HUB_NODE_ID },
  }),
  decide: () => {
    throw new Error("The hub records entries; it never asks a model to judge one")
  },
  storage: new MemoryStorage(),
  maintenanceClock,
  runtime: {
    // The hub answers every plan it can hold: a compute request may arrive as `await`, a
    // bot sync never needs an answer, and the hub's own records are admitted here too.
    supports: async (): Promise<boolean> => true,
    inject: async (entry: Entry, context?: string) => {
      applyInbound(entry)
      const kind = entry.message.delivery_kind
      if (kind === "compute") {
        // Handle compute message by forwarding to internal ComputeBrokerService
        await handleComputeMessage(entry)
        return { context: context ?? "hub", consumed: true, outcome: "consumed" }
      }
      return { context: context ?? "hub", consumed: true, outcome: "consumed" }
    },
    notify: (event: NotifyEvent) => {
      if (event.event === "inbound") ledgerThread ??= event.thread
    },
  },
}

/** Compute arguments arrive under `meta.data`; a top-level key is merged first when present. */
function computeFields(entry: Entry): Record<string, unknown> {
  const meta = (entry.message.meta ?? {}) as Record<string, unknown>
  const data = (meta.data ?? {}) as Record<string, unknown>
  return { ...data, ...meta }
}

/** Entry ids whose compute is still running; a second pass sees the first and does nothing. */
const computeInFlight = new Set<string>()

async function handleComputeMessage(entry: Entry): Promise<void> {
  const id = `${entry.thread_ref.owner}/${entry.thread_ref.id}/${entry.seq}`
  if (computeInFlight.has(id)) return
  computeInFlight.add(id)
  try {
    await runCompute(entry)
  } finally {
    computeInFlight.delete(id)
  }
}

async function runCompute(entry: Entry): Promise<void> {
  const meta = computeFields(entry)
  const operation = meta.operation as string | undefined
  if (!operation) {
    await sendComputeResult(entry, {
      ok: false,
      error: { code: "invalid_request", message: "Compute request requires meta.data.operation." },
    })
    return
  }

  try {
    let result: Json
    const sender = entry.authenticated_author
    switch (operation) {
      case "acquire": {
        const spec = meta as unknown as AcquireSpec
        result = (await compute.acquire(sender, spec)) as unknown as Json
        break
      }
      case "renew": {
        const lease_id = meta.lease_id as string | undefined
        const ttl_ms = meta.ttl_ms as number | undefined
        if (!lease_id || typeof ttl_ms !== "number") {
          throw new OnlyneError("invalid_request", "renew requires lease_id and ttl_ms.")
        }
        result = (await compute.renew(sender, lease_id, ttl_ms)) as unknown as Json
        break
      }
      case "release": {
        const lease_id = meta.lease_id as string | undefined
        if (!lease_id) throw new OnlyneError("invalid_request", "release requires lease_id.")
        result = (await compute.release(sender, lease_id)) as unknown as Json
        break
      }
      case "destroy": {
        const lease_id = meta.lease_id as string | undefined
        if (!lease_id) throw new OnlyneError("invalid_request", "destroy requires lease_id.")
        result = (await compute.destroy(sender, lease_id)) as unknown as Json
        void sampleDockerStats()
        break
      }
      case "status": {
        const lease_id = meta.lease_id as string | undefined
        result = (await compute.status(sender, lease_id)) as unknown as Json
        break
      }
      default:
        throw new OnlyneError("invalid_request", `Unknown compute operation: ${operation}`)
    }
    await sendComputeResult(entry, result)
  } catch (error) {
    const failure =
      error instanceof OnlyneError
        ? { code: error.error.code, message: error.error.message }
        : { code: "unavailable", message: error instanceof Error ? error.message : String(error) }
    await sendComputeResult(entry, { ok: false, error: failure } as Json)
  }
}

/**
 * The answer is admitted into the request's own thread on this node. The requester is already
 * a member of that thread and reads it over the wire, so no push to an unknown address is
 * needed and the reply cannot be lost behind an unreachable peer.
 */
async function sendComputeResult(entry: Entry, payload: Json): Promise<void> {
  const incomingWork = entry.message.meta?.work as WorkRef | undefined
  const work = incomingWork?.unit ? incomingWork : undefined
  try {
    const receipt = await node.messages.admit(
      { actor: HUB_NODE_ID },
      {
        target_endpoint: HUB_NODE_ID,
        idempotency_key: crypto.randomUUID(),
        retry_until: new Date(Date.now() + 60_000).toISOString(),
        plan: RECORD_PLAN,
        message: {
          id: crypto.randomUUID(),
          sender: HUB_NODE_ID,
          delivery_kind: "compute-result",
          msg: JSON.stringify(payload),
          meta: {
            thread: entry.thread_ref,
            in_reply_to: { sender: entry.message.sender, id: entry.message.id },
            relation: "reply",
            ...(work === undefined ? {} : { work }),
          },
        },
      },
    )
    ledgerThread ??= receipt.thread_ref
  } catch {
    // A failed reply never fails the compute itself: the requester can ask `status` again.
  }
}

const node = new OnlyneNode({
  node_id: HUB_NODE_ID,
  base_url: endpoint,
  instance_id: crypto.randomUUID(),
  now: () => Date.now(),
  id: () => crypto.randomUUID(),
  authentication: ["none"],
  plugins,
})

node.client.runMaintenance()

async function recordHubEvent(deliveryKind: string, msg: string, data: Record<string, Json>): Promise<void> {
  const receipt = await node.messages.admit(
    { actor: HUB_NODE_ID },
    {
      target_endpoint: HUB_NODE_ID,
      idempotency_key: crypto.randomUUID(),
      retry_until: new Date(Date.now() + 60_000).toISOString(),
      plan: RECORD_PLAN,
      message: {
        id: crypto.randomUUID(),
        sender: HUB_NODE_ID,
        delivery_kind: deliveryKind,
        msg,
        meta: { ...(ledgerThread === undefined ? {} : { thread: ledgerThread }), data },
      },
    },
  )
  ledgerThread ??= receipt.thread_ref
}

function viewOnly(url: string): string {
  const stripped = url.replace(/[?&]view_only=(true|false)/g, "")
  return `${stripped}${stripped.includes("?") ? "&" : "?"}view_only=true&resize=scale`
}

function interactive(url: string): string {
  const stripped = url.replace(/[?&]view_only=(true|false)/g, "")
  return `${stripped}${stripped.includes("?") ? "&" : "?"}resize=remote`
}

async function leaseRows(): Promise<unknown[]> {
  const submitters = new Set<string>([HUB_NODE_ID])
  for (const bot of bots.values()) submitters.add(`urn:onlyne:agent:${bot.botId}`)

  const rows: unknown[] = []
  const now = Date.now()
  for (const submitter of submitters) {
    const listed = await compute.status(submitter).catch(() => [] as SandboxDescriptor[])
    for (const lease of Array.isArray(listed) ? listed : [listed]) {
      if (lease === undefined || lease.state === "destroyed") continue
      rows.push({
        leaseId: lease.lease_id,
        name: lease.name,
        kind: lease.name.includes("-review-") ? "review" : "worker",
        state: lease.state,
        ttlRemainingSecs: Math.max(0, Math.round((lease.expires_at - now) / 1000)),
        desktopUrl: lease.connection?.portal_urls?.desktop ?? null,
        cdpEndpoint: lease.connection?.endpoints?.cdp ?? null,
        httpEndpoint: lease.connection?.endpoints?.http ?? null,
        containerId: lease.allocated?.container_id ?? null,
      })
    }
  }
  return rows
}

const BOT_TTL_MS = 30_000

/** A bot that stopped publishing is gone; `updatedAt` is the only liveness evidence there is. */
function pruneStaleBots(): void {
  const now = Date.now()
  for (const [botId, bot] of bots) {
    if (now - bot.updatedAt <= BOT_TTL_MS) continue
    bots.delete(botId)
    // The next bot launched under this id starts from a clean board; a leftover owner would
    // make its first snapshots look like an older instance's.
    boardOwners.delete(botId)
  }
}

async function boardSnapshot(): Promise<unknown> {
  const now = Date.now()
  pruneStaleBots()
  let ledgerCount = 0
  if (ledgerThread !== undefined) {
    const snapshot = await node.messages
      .snapshot({ actor: HUB_NODE_ID }, ledgerThread)
      .catch(() => undefined)
    ledgerCount = snapshot?.entries.length ?? 0
  }

  return {
    hubNodeId: HUB_NODE_ID,
    repoRoot,
    ledgerCount,
    bots: [...bots.values()].map((bot) => ({
      ...bot,
      workers: bot.workers.map((worker) => {
        const thumb = workerThumbs.get(thumbKey(bot.botId, worker.workerId))
        return {
          ...worker,
          elapsedSecs: Math.max(1, Math.round((now - worker.dispatchedAt) / 1000)),
          thumbSeq: thumb?.seq ?? 0,
          thumbMime: thumb?.mime ?? "image/jpeg",
        }
      }),
    })),
    leases: await leaseRows(),
    activity: latestActivity,
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function findWorker(
  botId: string,
  targetId: string,
): { bot: HubBotRecord; worker: HubWorkerRecord } | undefined {
  const bot = bots.get(botId)
  if (bot === undefined) return undefined
  const worker = bot.workers.find((item) => item.workerId === targetId || item.taskId === targetId)
  return worker === undefined ? undefined : { bot, worker }
}

/**
 * A bot reads the hub endpoint once at startup, so a respawned hub must come back on the
 * port the published record names; only a missing record leaves the choice to the OS.
 */
function stickyPort(): number {
  const fromEnv = Number(process.env.TERN_BOT_HUB_PORT ?? "0")
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  try {
    const published = JSON.parse(readFileSync(hubJsonPrimary, "utf8")) as { port?: number }
    return typeof published.port === "number" && published.port > 0 ? published.port : 0
  } catch {
    return 0
  }
}

async function hubAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/hub/status`, { signal: AbortSignal.timeout(700) })
    return response.ok
  } catch {
    return false
  }
}

function startHub(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request: Request): Promise<Response> {
    lastProbeAt = Date.now()
    const url = new URL(request.url)

    if (url.pathname === "/onlyne/v3" || url.pathname.startsWith("/onlyne/v3/")) {
      return await node.fetch(request)
    }

    if (url.pathname === "/hub/status" && request.method === "GET") {
      return json(await boardSnapshot())
    }

    // Keyframe thumbnail endpoint: raw JPEG/PNG bytes for `cx:blob`. `?bot=` scopes the
    // lookup, because every bot numbers its own workers from `worker-1`.
    const thumbMatch = url.pathname.match(/^\/hub\/thumb\/(.+)$/)
    if (thumbMatch !== null && request.method === "GET") {
      const workerId = decodeURIComponent(thumbMatch[1] as string)
      const botId = botParam(url)
      if (botId === undefined) return json({ error: "bot required" }, 400)
      let thumb = workerThumbs.get(thumbKey(botId, workerId))
      if (!thumb) {
        await refreshKeyframes()
        thumb = workerThumbs.get(thumbKey(botId, workerId))
      }
      if (!thumb) return new Response("not found", { status: 404 })
      return new Response(Buffer.from(thumb.bytes), {
        status: 200,
        headers: {
          "content-type": thumb.mime,
          "x-thumb-seq": String(thumb.seq),
          "cache-control": "no-store",
        },
      })
    }

    // A bot process registers the loopback address its own Onlyne listener answers on.
    if (url.pathname === "/hub/peers" && request.method === "POST") {
      const body = (await request.json()) as { nodeId?: string; baseUrl?: string }
      if (typeof body.nodeId !== "string" || typeof body.baseUrl !== "string") {
        return json({ error: "nodeId and baseUrl required" }, 400)
      }
      peers.set(body.nodeId, body.baseUrl)
      return json({ ok: true, peers: peers.size })
    }

    if (url.pathname === "/hub/bots" && request.method === "POST") {
      const data = (await request.json()) as Record<string, Json>
      const bot = registerBot(data)
      const botId = asString(data.botId) ?? ""
      await recordHubEvent("tern-bot.bot.sync", `Bot ${botId} registered by Tern`, data)
      return json({ ok: true, bot: bot ?? null })
    }

    if (url.pathname === "/hub/compute" && request.method === "POST") {
      const body = (await request.json()) as {
        botId?: string
        operation: "acquire" | "renew" | "release" | "destroy" | "status" | "sweep"
        spec?: AcquireSpec
        leaseId?: string
        ttlMs?: number
      }
      const submitter = `urn:onlyne:agent:${body.botId ?? "bot-1"}`
      try {
        if (body.operation === "acquire" && body.spec !== undefined) {
          const descriptor = await compute.acquire(submitter, body.spec)
          await recordHubEvent("tern-bot.compute.acquire", `Acquired ${body.spec.name}`, {
            botId: body.botId ?? "bot-1",
            leaseId: descriptor.lease_id,
            name: body.spec.name,
          })
          void sampleDockerStats()
          return json(descriptor)
        }
        if (body.operation === "renew" && body.leaseId !== undefined) {
          return json(await compute.renew(submitter, body.leaseId, body.ttlMs ?? 1_800_000))
        }
        if (body.operation === "release" && body.leaseId !== undefined) {
          return json(await compute.release(submitter, body.leaseId))
        }
        if (body.operation === "destroy" && body.leaseId !== undefined) {
          const descriptor = await compute.destroy(submitter, body.leaseId)
          await recordHubEvent("tern-bot.compute.destroy", `Destroyed ${body.leaseId}`, {
            botId: body.botId ?? "bot-1",
            leaseId: body.leaseId,
          })
          void sampleDockerStats()
          return json(descriptor)
        }
        if (body.operation === "sweep") {
          const swept = await compute.sweep()
          void sampleDockerStats()
          return json(swept)
        }
        if (body.operation === "status") {
          return json(await compute.status(submitter, body.leaseId))
        }
        return json({ error: "invalid compute request" }, 400)
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }

    const workerMatch = url.pathname.match(/^\/hub\/worker\/(.+)$/)
    if (workerMatch !== null && request.method === "GET") {
      const botId = botParam(url)
      if (botId === undefined) return json({ error: "bot required" }, 400)
      const hit = findWorker(botId, decodeURIComponent(workerMatch[1] as string))
      if (hit === undefined) return json({ error: "worker not found" }, 404)
      const desktop = hit.worker.desktopUrl
      return json({
        botId: hit.bot.botId,
        workspace: hit.bot.workspace,
        mainPane: hit.bot.mainPane ?? null,
        worker: hit.worker,
        pipUrl: desktop === undefined ? null : viewOnly(desktop),
        interveneUrl: desktop === undefined ? null : interactive(desktop),
      })
    }

    if (url.pathname === "/hub/intervene" && request.method === "POST") {
      const body = (await request.json()) as { botId?: string; workerId: string; active?: boolean }
      if (typeof body.botId !== "string" || body.botId.length === 0) {
        return json({ error: "botId required" }, 400)
      }
      const hit = findWorker(body.botId, body.workerId)
      if (hit === undefined) return json({ error: "worker not found" }, 404)
      hit.worker.intervening = body.active ?? !hit.worker.intervening
      await recordHubEvent(
        "tern-bot.human.intervene",
        hit.worker.intervening
          ? `Human took control of ${hit.worker.workerId}`
          : `Human handed ${hit.worker.workerId} back to the bot`,
        { botId: hit.bot.botId, workerId: hit.worker.workerId, intervening: hit.worker.intervening },
      )
      const desktop = hit.worker.desktopUrl
      return json({
        ok: true,
        botId: hit.bot.botId,
        mainPane: hit.bot.mainPane ?? null,
        intervening: hit.worker.intervening,
        interveneUrl: desktop === undefined ? null : interactive(desktop),
      })
    }

    if (url.pathname === "/hub/ledger" && request.method === "GET") {
      if (ledgerThread === undefined) return json({ entries: [] })
      const snapshot = await node.messages.snapshot({ actor: HUB_NODE_ID }, ledgerThread)
      return json({ entries: snapshot.entries })
    }

      return json({ error: "not found" }, 404)
    },
  })
}

const preferredPort = stickyPort()
let server: ReturnType<typeof Bun.serve>
try {
  server = startHub(preferredPort)
} catch (error) {
  if (preferredPort === 0 || !(await hubAnswers(preferredPort))) throw error
  console.error(`tern-bot hub already answers on 127.0.0.1:${preferredPort}; not starting a second one`)
  process.exit(0)
}

endpoint = `http://127.0.0.1:${server.port}/onlyne/v3`

const info: HubConnectionInfo = {
  port: server.port ?? 0,
  adminUrl: `http://127.0.0.1:${server.port}`,
  endpoint,
  nodeId: HUB_NODE_ID,
  pid: process.pid,
  token,
  repoRoot,
  ompBin,
  botConfigDir,
}

async function writeHubJson(path: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(info, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}

await writeHubJson(hubJsonPrimary)
await writeHubJson(hubJsonMirror)

let stopping = false
/**
 * Removes the published record only while it still names this process. A hub that is
 * shutting down must not erase the record of the hub that replaced it.
 */
function unlinkOwnHubJson(): void {
  try {
    const published = JSON.parse(readFileSync(hubJsonPrimary, "utf8")) as { pid?: number }
    if (published.pid !== process.pid) return
  } catch {
    return
  }
  rmSync(hubJsonPrimary, { force: true })
}

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  clearInterval(sweepTimer)
  clearInterval(thumbTimer)
  clearInterval(statsTimer)
  unlinkOwnHubJson()
  server.stop(true)
  process.exit(0)
}

process.on("unhandledRejection", (reason) => {
  // A background task (a keyframe capture, a docker sample) must not take the hub down:
  // every bot's compute routing depends on this process staying up.
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  void writeFile(join(dataDir, "hub-error.log"), `${new Date().toISOString()} ${text}\n`, {
    flag: "a",
  }).catch(() => undefined)
})

process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())

if (process.env.TERN_BOT_STANDALONE !== "1") {
  const orphanTimer = setInterval(() => {
    if (Date.now() - lastProbeAt > HEARTBEAT_TIMEOUT_MS) void shutdown()
  }, 15_000)
  orphanTimer.unref?.()
}

void recordHubEvent("tern-bot.hub.ready", `Hub ready on ${info.adminUrl}`, {
  nodeId: HUB_NODE_ID,
  port: info.port,
})
