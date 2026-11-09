/**
 * Bot Daemon — Unified runtime for one Tern Bot.
 *
 *   1. TavernHarness (compact prefix, infix, suffix assembly)
 *   2. BdflEngine (sandboxes leased from the hub's compute gateway, ArtifactBundles,
 *      the bot's Onlyne ledger, and `[ref=eN]`-annotated sandbox browser use)
 *   3. Board publisher: the bot's own state travels to the hub as `tern-bot.bot.sync`
 *      messages over the wire protocol. Every snapshot carries the instance that wrote it and
 *      a sequence number, and they leave in order, so the hub can tell a live board from a
 *      late heartbeat or a replay. No status HTTP server exists on this side.
 */

import { BdflEngine, readHubEndpoint } from "@tern-bot/bdfl-engine"
import { TavernHarness, type WindowBudget } from "@tern-bot/tavern-harness"

export interface BotDaemonOptions {
  botId: string
  budget?: WindowBudget
  storageDir?: string
  sandboxImage?: string
  workspace?: string
  /** How often the board state is published, in milliseconds. */
  syncIntervalMs?: number
  /** Agent CLI argv started inside each worker sandbox; default `omp acp`. */
  workerAgentCommand?: string[]
}

export interface BotDaemon {
  readonly botId: string
  /** One daemon run: snapshots carry it, so an older run never moves this bot's board again. */
  readonly instanceId: string
  readonly startedAt: number
  readonly pid: number
  readonly bdfl: BdflEngine
  readonly harness: TavernHarness
  stop(): Promise<void>
}

export type BoardState = "idle" | "working" | "waiting"

const DEFAULT_SYNC_MS = 2000
const SYNC_TIMEOUT_MS = 5000

/**
 * `TERN_BOT_WORKER_AGENT` names the agent CLI each sandbox runs: a JSON array, or
 * whitespace-separated argv. The default is omp in ACP mode.
 */
function workerAgentCommandFromEnv(): string[] {
  const raw = process.env.TERN_BOT_WORKER_AGENT?.trim()
  if (raw === undefined || raw.length === 0) return ["omp", "acp"]
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === "string")) {
        return parsed as string[]
      }
    } catch {
      // fall through to the whitespace form
    }
  }
  return raw.split(/\s+/)
}

export { readHubEndpoint } from "@tern-bot/bdfl-engine"

interface BoardWorker {
  workerId: string
  taskId: string
  title: string
  state: string
  dispatchedAt: number
  needsReview: boolean
  observations: number
  desktopUrl?: string
  cdpEndpoint?: string
  httpEndpoint?: string
  lastScreenshotPath?: string
  intervening?: boolean
  rejectionReason?: string
  /** Resident agent phase inside the worker sandbox. */
  agentPhase?: string
  agentSession?: string
  agentError?: string
  /** Pane command that opens the ACP front on this worker. */
  acpPaneCommand?: string
}

/** The board view of this bot, built from its own task records. */
function boardState(daemon: BotDaemon): {
  state: BoardState
  workers: BoardWorker[]
} {
  const tasks = daemon.bdfl.status()
  const state = tasks.some((t) => t.state === "SUBMITTED" || t.state === "REVIEWING")
    ? "waiting"
    : tasks.some((t) => t.state === "WORKING" || t.state === "DISPATCHED")
      ? "working"
      : "idle"

  const workers = tasks.map((t) => {
    const lease = t.reviewLease ?? t.workerLease
    return {
      workerId: t.workerId,
      taskId: t.id,
      title: t.title,
      state: t.state,
      dispatchedAt: t.dispatchedAt,
      needsReview: t.state === "SUBMITTED" || t.state === "REVIEWING",
      observations: t.reviewObservations,
      ...(lease?.connection?.portal_urls?.desktop === undefined
        ? {}
        : { desktopUrl: lease.connection.portal_urls.desktop }),
      ...(lease?.connection?.endpoints?.cdp === undefined
        ? {}
        : { cdpEndpoint: lease.connection.endpoints.cdp }),
      ...(lease?.connection?.endpoints?.http === undefined
        ? {}
        : { httpEndpoint: lease.connection.endpoints.http }),
      ...(t.lastObservation?.screenshotPath === undefined
        ? {}
        : { lastScreenshotPath: t.lastObservation.screenshotPath }),
      ...(t.rejectionReason === undefined ? {} : { rejectionReason: t.rejectionReason }),
      ...(t.workerAgent?.phase === undefined ? {} : { agentPhase: t.workerAgent.phase }),
      ...(t.workerAgent?.sessionId === undefined ? {} : { agentSession: t.workerAgent.sessionId }),
      ...(t.workerAgent?.error === undefined ? {} : { agentError: t.workerAgent.error }),
      ...(t.workerAgent?.front === undefined ? {} : { acpPaneCommand: t.workerAgent.front.paneCommand }),
    }
  })

  return { state, workers }
}

/**
 * One daemon's outbound snapshots. `seq` grows with every snapshot and each send waits for the
 * previous one, so a heartbeat that started earlier can never land after a later one.
 */
interface Publisher {
  seq: number
  queue: Promise<void>
  /** A heartbeat is queued but not sent; the next tick would say no more than it already says. */
  pending: boolean
  /** The final snapshot is queued: this daemon has nothing left to publish. */
  closed: boolean
}

const publishers = new WeakMap<BotDaemon, Publisher>()

function publisherFor(daemon: BotDaemon): Publisher {
  let current = publishers.get(daemon)
  if (current === undefined) {
    current = { seq: 0, queue: Promise.resolve(), pending: false, closed: false }
    publishers.set(daemon, current)
  }
  return current
}

/**
 * Publishes one board snapshot as a `tern-bot.bot.sync` message on the wire. The reply is not
 * read: a sync is a record, and the hub applies it when it admits the entry.
 *
 * `overrideState: "idle"` is this daemon's final snapshot: it carries no workers, is queued
 * behind any heartbeat still in flight, and closes the publisher.
 */
export function publishBoard(
  daemon: BotDaemon,
  hubEndpoint: string,
  workspace: string,
  overrideState?: BoardState,
): Promise<void> {
  const publisher = publisherFor(daemon)
  const final = overrideState === "idle"
  if (publisher.closed) return publisher.queue
  if (!final && publisher.pending) return publisher.queue

  const seq = ++publisher.seq
  publisher.closed = final
  publisher.pending = !final

  publisher.queue = publisher.queue.then(async () => {
    try {
      if (!final) await daemon.bdfl.refreshWorkerAgents()
      const board = final ? { state: "idle" as const, workers: [] } : boardState(daemon)
      const state = overrideState ?? board.state
      const body = {
        idempotency_key: crypto.randomUUID(),
        retry_until: new Date(Date.now() + 60_000).toISOString(),
        target_endpoint: "urn:onlyne:hub:tern-bot",
        plan: { response: "none", execution: "existing" },
        message: {
          id: crypto.randomUUID(),
          sender: `urn:onlyne:agent:${daemon.botId}`,
          delivery_kind: "tern-bot.bot.sync",
          msg: `${daemon.botId} ${state} #${seq} (${board.workers.length} workers)`,
          meta: {
            work: { unit: `${daemon.botId}.sync` },
            data: {
              botId: daemon.botId,
              instanceId: daemon.instanceId,
              startedAt: daemon.startedAt,
              pid: daemon.pid,
              seq,
              workspace,
              state,
              workers: board.workers,
              ...(final ? { stopped: true } : {}),
            },
          },
        },
      }

      await fetch(`${hubEndpoint}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Onlyne-Actor": `urn:onlyne:agent:${daemon.botId}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      })
    } catch (error) {
      console.error(`Board sync failed for ${daemon.botId}:`, error)
    } finally {
      if (!final) publisher.pending = false
    }
  })
  return publisher.queue
}

export async function startBotDaemon(options: BotDaemonOptions): Promise<BotDaemon> {
  if (!options.botId?.trim()) throw new Error("botId is required")

  const harness = new TavernHarness(options.budget ? { budget: options.budget } : undefined)
  const hubEndpoint = readHubEndpoint()
  const workspace = options.workspace ?? process.cwd()

  const bdfl = new BdflEngine({
    botId: options.botId,
    storageDir: options.storageDir,
    sandboxImage: options.sandboxImage,
    hubBaseUrl: hubEndpoint,
    workerAgentCommand: options.workerAgentCommand ?? workerAgentCommandFromEnv(),
  })

  let syncTimer: Timer | undefined
  let stopping: Promise<void> | undefined

  const daemon: BotDaemon = {
    botId: options.botId,
    instanceId: crypto.randomUUID(),
    startedAt: Date.now(),
    pid: process.pid,
    bdfl,
    harness,
    stop(): Promise<void> {
      stopping ??= (async () => {
        if (syncTimer !== undefined) {
          clearInterval(syncTimer)
          syncTimer = undefined
        }
        // The final publish queues behind any heartbeat already in flight, so the hub's last
        // word from this instance is the idle board rather than a working state outliving it.
        await publishBoard(daemon, hubEndpoint, workspace, "idle")
        await bdfl.destroyAll()
        bdfl.stop()
      })()
      return stopping
    },
  }

  // Publish immediately so the board shows this bot before its first task exists.
  void publishBoard(daemon, hubEndpoint, workspace).catch(() => undefined)
  syncTimer = setInterval(() => {
    void publishBoard(daemon, hubEndpoint, workspace).catch(() => undefined)
  }, options.syncIntervalMs ?? DEFAULT_SYNC_MS)
  syncTimer.unref?.()

  return daemon
}
