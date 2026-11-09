/**
 * BDFL Engine — Real Onlyne Compute Broker + Artifact Bundle + Sandbox Browser Use.
 *
 * 1. No local ComputeBroker: All compute operations (acquire, renew, release, destroy,
 *    status) are sent as Onlyne messages to the Hub (`urn:onlyne:hub:tern-bot`),
 *    which runs the single-authority ComputeBrokerService with DockerSandboxDriver.
 * 2. Audited Onlyne ledger: Every dispatch, submission, feedback, and acceptance
 *    is admitted into a real `@onlyne/lib` `OnlyneNode` thread.
 * 3. Real Sandbox Browser/Computer Use: `review(taskId)` provisions the Bot's
 *    own review sandbox (`tern-bot-sandbox:dev`), mounts the submitted bundle
 *    into `/workspace`, serves it on port 8080, and `browserUse(taskId, action)`
 *    drives Chromium over CDP, returning an AX tree and a `[ref=eN]`-annotated
 *    PNG screenshot after every single operation.
 */

import {
  execInSandbox,
  execInSandboxOrThrow,
  shellQuote,
  type AcquireSpec,
  type SandboxDescriptor,
} from "@onlyne/compute-core"
import {
  MemoryStorage,
  OnlyneNode,
  type DeliveryPlan,
  type Entry,
  type Json,
  type Plugins,
  type ThreadRef,
  type WorkRef,
} from "@onlyne/lib"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  SandboxBrowserController,
  type SandboxBrowserAction,
  type SandboxObservation,
} from "./sandbox-ui.ts"
import {
  WorkerAgentHost,
  defaultRelayPath,
  type AcpFront,
  type WorkerAgentStatus,
} from "./worker-agent.ts"

export type { SandboxBrowserAction, SandboxObservation, AxNodeSummary } from "./sandbox-ui.ts"
export type { AcpFront, WorkerAgentConfig, WorkerAgentStatus } from "./worker-agent.ts"

/** Initial prompt for a worker agent. It names the workspace and the submission rules. */
function workerPrompt(title: string, description: string): string {
  return [
    `Task: ${title}`,
    "",
    description.trim(),
    "",
    "Work inside /workspace in this sandbox. Build the deliverable there and keep it runnable.",
    "Leave the files the bot should review in /workspace.",
  ].join("\n")
}

export type TaskState =
  | "DISPATCHED"
  | "WORKING"
  | "SUBMITTED"
  | "REVIEWING"
  | "ACCEPTED"
  | "REJECTED"

export interface ArtifactFile {
  path: string
  content: string
}

export interface ArtifactBundle {
  taskId: string
  summary: string
  files: ArtifactFile[]
  timestamp: number
}

export interface TaskRecord {
  id: string
  title: string
  description: string
  workerId: string
  state: TaskState
  dispatchedAt: number
  workerLease?: SandboxDescriptor
  reviewLease?: SandboxDescriptor
  submittedBundle?: ArtifactBundle
  reviewObservations: number
  lastObservation?: SandboxObservation
  rejectionReason?: string
  acceptedAt?: number
  /** Sandbox-resident agent for this worker; absent when the task runs scripts only. */
  workerAgent?: WorkerAgentState
}

export interface WorkerAgentState {
  stateDir: string
  phase: string
  sessionId?: string
  agentPid?: number
  /** Why the launch failed; the task continues on the script path. */
  error?: string
  /** Pane command that opens the ACP front on this worker. */
  front?: AcpFront
}

export interface BdflEngineOptions {
  botId?: string
  storageDir?: string
  sandboxImage?: string
  /** Hub Onlyne node ID (default: urn:onlyne:hub:tern-bot) */
  hubNodeId?: string
  /** Hub base URL for Onlyne wire protocol (default: http://127.0.0.1:18412/onlyne/v3 from hub.json) */
  hubBaseUrl?: string
  /** Agent CLI argv run inside each new worker sandbox, e.g. ["omp", "acp"]. */
  workerAgentCommand?: string[]
  /** Extra environment for the worker agent CLI. */
  workerAgentEnv?: Record<string, string>
  /** Host HOME template; default `~/.config/tern-bot/sandbox-cfg`. */
  sandboxConfigRoot?: string
}

const RECORD_PLAN: DeliveryPlan = { response: "none", execution: "existing" }
const HUB_NODE_ID_DEFAULT = "urn:onlyne:hub:tern-bot"

/**
 * The running hub's Onlyne endpoint, published by the tern plugin into its data directory.
 * A bot cannot guess a port, so a missing file is an error rather than a fallback URL.
 */
export function readHubEndpoint(): string {
  const fromEnv = process.env.TERN_BOT_HUB_ENDPOINT
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv

  const candidates: string[] = []
  const pluginData = process.env.TERN_PLUGIN_DATA
  if (pluginData !== undefined && pluginData.length > 0) candidates.push(join(pluginData, "hub.json"))
  candidates.push(
    join(homedir(), "Library", "Application Support", "Tern", "plugin-data", "tern-bot", "hub.json"),
    join(homedir(), ".config", "tern-bot", "hub-data", "hub.json"),
    join(homedir(), ".config", "tern-bot", "hub.json"),
  )

  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { endpoint?: string }
      if (typeof raw.endpoint === "string" && raw.endpoint.length > 0) return raw.endpoint
    } catch {
      // try the next location
    }
  }
  throw new Error(`No running tern-bot hub: no endpoint in ${candidates.join(", ")}`)
}
const COMPUTE_PLAN: DeliveryPlan = { response: "await", execution: "existing" }
const COMPUTE_TIMEOUT_MS = 120_000
/** Minimum gap between resident status reads for one worker; each read is a container exec. */
const AGENT_POLL_INTERVAL_MS = 5_000

export class BdflEngine {
  readonly #botId: string
  readonly #actorUrn: string
  readonly #storageDir: string
  readonly #sandboxImage: string
  readonly #hubNodeId: string
  readonly #hubBaseUrl: string
  #nodeInstance?: OnlyneNode
  #resolvedHubUrl?: string
  #listener?: { stop(force?: boolean): void; port?: number }
  #selfBaseUrl = ""
  readonly #tasks = new Map<string, TaskRecord>()
  readonly #controllers = new Map<string, SandboxBrowserController>()
  readonly #workerAgents = new Map<string, WorkerAgentHost>()
  readonly #agentPolledAt = new Map<string, number>()
  readonly #workerAgentCommand: string[] | undefined
  readonly #workerAgentEnv: Record<string, string> | undefined
  readonly #sandboxConfigRoot: string | undefined
  #ledgerThread?: ThreadRef
  #seq = 0

  constructor(opts?: BdflEngineOptions) {
    this.#botId = opts?.botId ?? "bot-1"
    this.#actorUrn = `urn:onlyne:agent:${this.#botId}`
    this.#storageDir = opts?.storageDir ?? join(process.cwd(), ".tern-bot")
    this.#sandboxImage = opts?.sandboxImage ?? "tern-bot-sandbox:dev"
    this.#hubNodeId = opts?.hubNodeId ?? HUB_NODE_ID_DEFAULT
    this.#hubBaseUrl = opts?.hubBaseUrl ?? ""
    this.#workerAgentCommand = opts?.workerAgentCommand
    this.#workerAgentEnv = opts?.workerAgentEnv
    this.#sandboxConfigRoot = opts?.sandboxConfigRoot

    mkdirSync(join(this.#storageDir, "bundles"), { recursive: true })
    mkdirSync(join(this.#storageDir, "screenshots"), { recursive: true })

    const plugins: Plugins = {
      authenticate: async () => ({ actor: this.#actorUrn }),
      inboundThread: async () => true,
      mayAdmit: async () => true,
      // Every peer id this bot addresses is the hub: the bot owns its threads and the hub
      // stores nothing of its own, so replies reach this node by reconcile, not by push.
      resolve: async (id) => ({
        node_id: id,
        base_url: this.#hubUrl,
        headers: { "Onlyne-Actor": this.#actorUrn },
      }),
      decide: () => {
        throw new Error("Direct ledger admission needs no model judge")
      },
      storage: new MemoryStorage(),
      maintenanceClock: {
        setTimer: (ms: number, run: () => void) => {
          const handle = setTimeout(run, ms)
          handle.unref?.()
          return handle
        },
        clearTimer: (handle: unknown) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>)
        },
      },
      runtime: {
        supports: async () => true,
        inject: async (_entry: Entry, ctx?: string) => ({
          context: ctx ?? "main",
          consumed: true,
          outcome: "consumed" as const,
        }),
        notify: () => undefined,
      },
    }

    this.#plugins = plugins
  }

  readonly #plugins: Plugins

  /** Resolved on first use so constructing an engine needs no running hub. */
  get #hubUrl(): string {
    if (this.#resolvedHubUrl === undefined) {
      this.#resolvedHubUrl = this.#hubBaseUrl.length > 0 ? this.#hubBaseUrl : readHubEndpoint()
    }
    return this.#resolvedHubUrl
  }

  get #node(): OnlyneNode {
    if (this.#nodeInstance === undefined) {
      this.#nodeInstance = new OnlyneNode({
        node_id: this.#actorUrn,
        base_url: this.#hubUrl,
        instance_id: crypto.randomUUID(),
        now: () => Date.now(),
        id: () => crypto.randomUUID(),
        authentication: ["none"],
        plugins: this.#plugins,
      })
      // Local loop only: it replays this bot's own ledger records; wire calls are plain POSTs.
      this.#nodeInstance.client.runMaintenance()
    }
    return this.#nodeInstance
  }

  /** The reply polls read the hub's thread, so the bot never needs an inbound port of its own. */
  get baseUrl(): string {
    return this.#hubUrl
  }

  stop(): void {
    this.#nodeInstance?.client.stopMaintenance()
  }

  /**
   * One request over the wire protocol's reply-authority route (`POST /onlyne/v3/messages`).
   * That route makes the hub own the landing, which keeps the answer in a thread this bot can
   * read; the alternative — a locally initiated thread — needs the hub to reach back into this
   * process, and a bot process has no inbound port.
   */
  async #converse(
    deliveryKind: string,
    msg: string,
    work: WorkRef,
    data: Record<string, Json>,
    replyKind: string,
  ): Promise<Json> {
    const deadline = new Date(Date.now() + COMPUTE_TIMEOUT_MS).toISOString()
    const response = await fetch(`${this.#hubUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "Onlyne-Actor": this.#actorUrn },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        retry_until: deadline,
        target_endpoint: this.#hubNodeId,
        plan: RECORD_PLAN,
        message: {
          id: crypto.randomUUID(),
          sender: this.#actorUrn,
          delivery_kind: deliveryKind,
          msg,
          meta: { work, data },
        },
      }),
      signal: AbortSignal.timeout(COMPUTE_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`${deliveryKind} refused: ${response.status} ${await response.text()}`)
    }
    const receipt = (await response.json()) as { thread_ref: { owner: string; id: string } }
    const thread = receipt.thread_ref
    return await this.#awaitReply(thread, work.unit, replyKind)
  }

  /** Polls one hub-owned thread until the reply carrying this work unit lands. */
  async #awaitReply(
    thread: { owner: string; id: string },
    workUnit: string,
    replyKind: string,
  ): Promise<Json> {
    const started = Date.now()
    const path = `${this.#hubUrl}/threads/${encodeURIComponent(thread.owner)}/${encodeURIComponent(thread.id)}/messages?attention=thread`
    while (Date.now() - started < COMPUTE_TIMEOUT_MS) {
      const response = await fetch(path, {
        headers: { "Onlyne-Actor": this.#actorUrn },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined)
      if (response?.ok === true) {
        const page = (await response.json()) as {
          items: Array<{ message: { delivery_kind: string; msg: string; meta?: { work?: WorkRef } } }>
        }
        for (const item of page.items) {
          if (item.message.delivery_kind !== replyKind) continue
          if (item.message.meta?.work?.unit !== workUnit) continue
          return JSON.parse(item.message.msg) as Json
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error(`No ${replyKind} for ${workUnit} within ${COMPUTE_TIMEOUT_MS}ms`)
  }

  get botId(): string {
    return this.#botId
  }

  /** Append one entry to this bot's Onlyne ledger. The bot is always the author. */
  async #admitLedger(
    deliveryKind: string,
    msg: string,
    meta: Record<string, Json>,
  ): Promise<void> {
    const receipt = await this.#node.messages.admit(
      { actor: this.#actorUrn },
      {
        target_endpoint: this.#actorUrn,
        idempotency_key: crypto.randomUUID(),
        retry_until: new Date(Date.now() + 60_000).toISOString(),
        plan: RECORD_PLAN,
        message: {
          id: crypto.randomUUID(),
          sender: this.#actorUrn,
          delivery_kind: deliveryKind,
          msg,
          meta: {
            ...meta,
            ...(this.#ledgerThread ? { thread: this.#ledgerThread } : {}),
          },
        },
      },
    )
    if (!this.#ledgerThread) {
      this.#ledgerThread = receipt.thread_ref
    }
  }

  /** Every audited record this bot wrote into its own ledger thread. */
  async ledgerEntries(): Promise<Entry[]> {
    if (this.#ledgerThread === undefined) return []
    const snapshot = await this.#node.messages.snapshot({ actor: this.#actorUrn }, this.#ledgerThread)
    return snapshot.entries
  }

  /**
   * One compute call over the wire protocol: the request carries `meta.work`, the hub answers
   * with `compute-result` on the thread this bot owns, and the await resolves when this node's
   * own reconcile pulls that reply in.
   */
  async #sendCompute(
    operation: string,
    meta: Record<string, unknown>,
    workRef: WorkRef,
  ): Promise<Json> {
    const payload = await this.#converse(
      "compute",
      `compute.${operation}`,
      workRef,
      { ...(meta as Record<string, Json>), operation },
      "compute-result",
    )
    const failure = payload as { ok?: boolean; error?: { code: string; message: string } }
    if (failure.ok === false && failure.error !== undefined) {
      throw new Error(`Compute ${operation} failed: ${failure.error.code}: ${failure.error.message}`)
    }
    return payload
  }

  /** Create a WorkRef for a task operation. */
  #makeWorkRef(taskId: string, operation: string): WorkRef {
    return {
      unit: `${this.#botId}.${taskId}.${operation}`,
      parent: taskId,
      attempt: 1,
    }
  }

  /**
   * 1. Dispatch a task: provision an isolated worker sandbox via Hub
   *    ComputeBrokerService and record the task dispatch in the Onlyne ledger.
   */
  async dispatch(
    title: string,
    description: string,
    opts?: { workerScript?: string; files?: ArtifactFile[] },
  ): Promise<TaskRecord> {
    this.#seq += 1
    const taskId = `task-${this.#seq}`
    const workerId = `worker-${this.#seq}`

    const spec: AcquireSpec = {
      name: `${this.#botId}-${workerId}`,
      purpose: `Worker sandbox for ${taskId}: ${title}`,
      container: {
        image: this.#sandboxImage,
        workdir: "/workspace",
      },
      network: {
        nat_ports: [
          { name: "desktop", container_port: 6080, protocol: "tcp" },
          { name: "cdp", container_port: 9223, protocol: "tcp" },
          { name: "http", container_port: 8080, protocol: "tcp" },
        ],
      },
      lease: {
        ttl_ms: 30 * 60 * 1000,
      },
    }

    const workRef = this.#makeWorkRef(taskId, "dispatch")
    const result = await this.#sendCompute("acquire", { ...spec, meta: { taskId, workerId } }, workRef)
    const workerLease = result as unknown as SandboxDescriptor

    const record: TaskRecord = {
      id: taskId,
      title,
      description,
      workerId,
      state: "WORKING",
      dispatchedAt: Date.now(),
      workerLease,
      reviewObservations: 0,
    }
    this.#tasks.set(taskId, record)

    await this.#admitLedger("task.dispatch", description, {
      taskId,
      title,
      workerId,
      leaseId: workerLease.lease_id,
      containerId: workerLease.allocated?.container_id ?? "",
    })

    if (opts?.files) {
      await this.#writeFilesToSandbox(workerLease, opts.files)
    }
    // A script run is one-shot: it produces the bundle and there is nothing left to watch.
    if (opts?.workerScript) {
      await execInSandboxOrThrow(workerLease, ["/bin/sh", "-c", opts.workerScript], {
        cwd: "/workspace",
        what: `Worker script in ${workerLease.name}`,
      })
      const collected = await this.#collectWorkspaceFiles(workerLease)
      return await this.submitArtifact(taskId, {
        summary: `Worker ${workerId} completed build in sandbox ${workerLease.name}`,
        files: collected,
      })
    }
    if (this.#workerAgentCommand !== undefined) {
      record.workerAgent = await this.#launchWorkerAgent(record, workerLease, title, description)
    }

    return { ...record }
  }

  /**
   * Starts the worker's resident agent. A launch failure is recorded on the task and the
   * sandbox stays usable for scripts, so a broken CLI never loses a provisioned lease.
   */
  async #launchWorkerAgent(
    record: TaskRecord,
    workerLease: SandboxDescriptor,
    title: string,
    description: string,
  ): Promise<WorkerAgentState> {
    const host = new WorkerAgentHost(
      workerLease,
      record.workerId,
      this.#sandboxConfigRoot === undefined ? undefined : { sandboxConfigRoot: this.#sandboxConfigRoot },
    )
    this.#workerAgents.set(record.id, host)
    const state: WorkerAgentState = { stateDir: host.stateDir, phase: "starting" }
    try {
      const handle = await host.launch({
        command: this.#workerAgentCommand ?? [],
        ...(this.#workerAgentEnv === undefined ? {} : { env: this.#workerAgentEnv }),
        prompt: workerPrompt(title, description),
      })
      state.phase = handle.phase
      if (handle.sessionId !== undefined) state.sessionId = handle.sessionId
      if (handle.agentPid !== undefined) state.agentPid = handle.agentPid
      const botDir = this.#botId.replaceAll(/[^A-Za-z0-9._-]/g, "_")
      const frontDir = join(this.#storageDir, "workers", botDir, record.workerId)
      state.front = host.acpFront(frontDir, join(frontDir, "tern-config"), defaultRelayPath())
    } catch (error) {
      state.phase = "failed"
      state.error = error instanceof Error ? error.message : String(error)
    }
    return state
  }

  /** Live resident status for one worker, read from the sandbox on demand. */
  async workerAgentStatus(taskId: string): Promise<WorkerAgentStatus | undefined> {
    const host = this.#workerAgents.get(taskId)
    if (host === undefined) return undefined
    return await host.status().catch((error: unknown) => ({
      phase: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
    }))
  }

  /**
   * Reads each working worker's resident status and turns a finished background task into a
   * submission, so a worker that never has a frontend still delivers.
   */
  async refreshWorkerAgents(): Promise<void> {
    const now = Date.now()
    for (const task of this.#tasks.values()) {
      if (task.state !== "WORKING" || task.workerAgent === undefined) continue
      if (now - (this.#agentPolledAt.get(task.id) ?? 0) < AGENT_POLL_INTERVAL_MS) continue
      this.#agentPolledAt.set(task.id, now)
      const status = await this.workerAgentStatus(task.id)
      if (status === undefined) continue
      Object.assign(task.workerAgent, status)
      if (status.phase !== "idle" || task.workerLease === undefined) continue
      const prompt = status.lastPrompt
      if (prompt?.origin !== "control" || prompt.state !== "done" || prompt.stopReason !== "end_turn") continue
      const files = await this.#collectWorkspaceFiles(task.workerLease)
      // An empty /workspace is not a deliverable: the task stays WORKING and review stays closed.
      if (files.length === 0) continue
      await this.submitArtifact(task.id, {
        summary: `Worker ${task.workerId} completed ${task.title}`,
        files,
      })
    }
  }

  /**
   * Execute a command inside the worker's isolated sandbox container and
   * automatically harvest `/workspace` files as an ArtifactBundle submission.
   */
  async runWorkerCommand(taskId: string, script: string, summary?: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    const workerLease = task.workerLease
    if (!workerLease) {
      throw new Error(`Task ${taskId} has no running worker sandbox`)
    }
    await execInSandboxOrThrow(workerLease, ["/bin/sh", "-c", script], {
      cwd: "/workspace",
      what: `Worker command in ${workerLease.name}`,
    })
    const files = await this.#collectWorkspaceFiles(workerLease)
    return await this.submitArtifact(taskId, {
      summary: summary ?? `Worker ${task.workerId} produced ${files.length} file(s)`,
      files,
    })
  }

  /**
   * 2. Submit an ArtifactBundle from the worker.
   */
  async submitArtifact(
    taskId: string,
    bundle: { summary: string; files: ArtifactFile[] },
  ): Promise<TaskRecord> {
    const task = this.#require(taskId)
    if (task.state !== "WORKING" && task.state !== "DISPATCHED" && task.state !== "SUBMITTED" && task.state !== "REJECTED") {
      throw new Error(`Cannot submit artifact for task ${taskId} in state ${task.state}`)
    }

    // Also mirror submitted files into the worker container's /workspace if it wasn't written there yet
    if (task.workerLease !== undefined && bundle.files.length > 0) {
      await this.#writeFilesToSandbox(task.workerLease, bundle.files)
    }

    const artifactBundle: ArtifactBundle = {
      taskId,
      summary: bundle.summary,
      files: bundle.files,
      timestamp: Date.now(),
    }
    task.submittedBundle = artifactBundle
    task.state = "SUBMITTED"

    const bundlePath = join(this.#storageDir, "bundles", `${taskId}.json`)
    writeFileSync(bundlePath, JSON.stringify(artifactBundle, null, 2))

    await this.#admitLedger(
      "task.submission",
      bundle.summary,
      {
        taskId,
        workerId: task.workerId,
        filesCount: bundle.files.length,
        bundlePath,
      },
    )

    return { ...task }
  }

  /**
   * 3. Start review: provision (or reuse) the Bot's dedicated review sandbox VM,
   *    unpack the submitted ArtifactBundle into `/workspace`, and start an HTTP
   *    server on port 8080 inside the review sandbox so the Bot's Chromium can
   *    open `http://127.0.0.1:8080`.
   */
  async review(taskId: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    if (task.state === "WORKING" && task.submittedBundle) {
      task.state = "SUBMITTED"
    }
    if (task.state !== "SUBMITTED") {
      throw new Error(`Task ${taskId} must be SUBMITTED before review, got ${task.state}`)
    }
    if (!task.submittedBundle) {
      throw new Error(`Task ${taskId} has no submitted ArtifactBundle`)
    }

    const reviewSpec: AcquireSpec = {
      name: `${this.#botId}-review-${taskId}`,
      purpose: `BDFL Review sandbox for ${taskId}`,
      container: {
        image: this.#sandboxImage,
        workdir: "/workspace",
      },
      network: {
        nat_ports: [
          { name: "desktop", container_port: 6080, protocol: "tcp" },
          { name: "cdp", container_port: 9223, protocol: "tcp" },
          { name: "http", container_port: 8080, protocol: "tcp" },
        ],
      },
      lease: {
        ttl_ms: 30 * 60 * 1000,
      },
    }

    const workRef = this.#makeWorkRef(taskId, "review")
    const result = await this.#sendCompute("acquire", { ...reviewSpec, meta: { taskId, review: true } }, workRef)
    const reviewLease = result as unknown as SandboxDescriptor
    task.reviewLease = reviewLease
    task.state = "REVIEWING"

    // Write bundle files into the review sandbox's /workspace (served on :8080 by entrypoint)
    await this.#writeFilesToSandbox(reviewLease, task.submittedBundle.files)

    await this.#admitLedger("task.review_started", `Reviewing ${taskId}`, {
      taskId,
      reviewLeaseId: reviewLease.lease_id,
      desktopUrl: reviewLease.connection?.portal_urls?.desktop ?? "",
      cdpEndpoint: reviewLease.connection?.endpoints?.cdp ?? "",
    })

    return { ...task }
  }

  /**
   * 4. Execute a Browser/Computer Use action inside the Bot's review sandbox.
   *    Every call returns the live AX tree with `[ref=eN]` tags AND the PNG
   *    screenshot with `[ref=eN]` bounding boxes painted on top.
   */
  async browserUse(taskId: string, action: SandboxBrowserAction): Promise<SandboxObservation> {
    const task = this.#require(taskId)
    if (task.state !== "REVIEWING" || !task.reviewLease) {
      throw new Error(
        `Task ${taskId} must be in REVIEWING state with an active review sandbox (current: ${task.state})`,
      )
    }

    const cdpEndpoint = task.reviewLease.connection?.endpoints?.cdp
    if (!cdpEndpoint) {
      throw new Error(`Review sandbox ${task.reviewLease.lease_id} exposed no CDP endpoint`)
    }

    let controller = this.#controllers.get(taskId)
    if (!controller) {
      controller = new SandboxBrowserController({
        cdpEndpoint,
        screenshotDir: join(this.#storageDir, "screenshots", taskId),
      })
      this.#controllers.set(taskId, controller)
    }

    const observation = await controller.execute(action)
    task.reviewObservations += 1
    task.lastObservation = observation

    await this.#admitLedger(
      "sandbox.observation",
      `[${action.op}] ${observation.title} (${observation.nodes.length} AX nodes)`,
      {
        taskId,
        op: action.op,
        url: observation.url,
        nodesCount: observation.nodes.length,
        screenshotPath: observation.screenshotPath,
      },
    )

    return observation
  }

  /**
   * 5. Accept (merge) the verified deliverable after at least one real sandbox
   *    observation, optionally exporting the verified files to `exportDir`, and
   *    destroy the temporary sandboxes.
   */
  async accept(taskId: string, exportDir?: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    if (task.state !== "REVIEWING" || !task.reviewLease) {
      throw new Error(`Task ${taskId} must be in REVIEWING state before accept, got ${task.state}`)
    }
    if (task.reviewObservations === 0) {
      throw new Error(
        `Invariant violation: cannot accept task ${taskId} without at least one sandbox browser/computer observation`,
      )
    }

    // Verify review lease is still running
    const liveStatus = (await this.#sendCompute(
      "status",
      { lease_id: task.reviewLease.lease_id },
      this.#makeWorkRef(task.id, "status"),
    )) as unknown as SandboxDescriptor
    if (liveStatus.state !== "running") {
      throw new Error(
        `Invariant violation: review sandbox ${task.reviewLease.lease_id} is ${liveStatus.state}, not running`,
      )
    }

    if (exportDir && task.submittedBundle) {
      mkdirSync(exportDir, { recursive: true })
      for (const file of task.submittedBundle.files) {
        const fullPath = join(exportDir, file.path)
        mkdirSync(join(fullPath, ".."), { recursive: true })
        writeFileSync(fullPath, file.content)
      }
    }

    // Reclaim sandboxes via Hub ComputeBrokerService
    await this.#sendCompute("destroy", { lease_id: task.reviewLease.lease_id }, this.#makeWorkRef(task.id, "destroy.review"))
    await this.#stopWorkerAgent(task.id)
    if (task.workerLease) {
      await this.#sendCompute("destroy", { lease_id: task.workerLease.lease_id }, this.#makeWorkRef(task.id, "destroy.worker"))
    }

    task.state = "ACCEPTED"
    task.acceptedAt = Date.now()

    await this.#admitLedger(
      "task.accepted",
      `Task ${taskId} verified (${task.reviewObservations} observation(s)) and accepted`,
      {
        taskId,
        observations: task.reviewObservations,
        exportDir: exportDir ?? "",
      },
    )

    return { ...task }
  }

  /**
   * Reject the deliverable back to WORKING with feedback and release the review sandbox.
   */
  async reject(taskId: string, reason: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    if (task.state !== "REVIEWING") {
      throw new Error(`Task ${taskId} must be in REVIEWING state to reject, got ${task.state}`)
    }

    if (task.reviewLease) {
      await this.#sendCompute("destroy", { lease_id: task.reviewLease.lease_id }, this.#makeWorkRef(task.id, "destroy.review"))
      task.reviewLease = undefined
    }
    this.#controllers.delete(taskId)

    task.state = "REJECTED"
    task.rejectionReason = reason

    await this.#admitLedger("task.feedback", reason, {
      taskId,
      reason,
    })

    return { ...task }
  }

  /**
   * List all tasks for the board.
   */
  status(): TaskRecord[] {
    return Array.from(this.#tasks.values(), (t) => ({ ...t }))
  }

  /**
   * List all active compute leases from the Hub ComputeBrokerService.
   */
  async leases(): Promise<SandboxDescriptor[]> {
    const res = await this.#sendCompute("status", {}, this.#makeWorkRef("status", "list"))
    const rows = Array.isArray(res) ? res : [res]
    return rows as unknown as SandboxDescriptor[]
  }

  /**
   * Destroy all remaining sandboxes owned by this engine.
   */
  async destroyAll(): Promise<void> {
    for (const taskId of this.#workerAgents.keys()) {
      await this.#stopWorkerAgent(taskId)
    }
    const all = await this.leases()
    for (const l of all) {
      if (l.state !== "destroyed") {
        await this.#sendCompute("destroy", { lease_id: l.lease_id }, this.#makeWorkRef("destroy", "all")).catch(() => undefined)
      }
    }
  }

  /**
   * Writes the bundle into `/workspace` over the lease's own transport. The script is plain
   * POSIX shell plus base64: a sandbox image is not assumed to carry python or tar.
   */
  async #writeFilesToSandbox(lease: SandboxDescriptor, files: ArtifactFile[]): Promise<void> {
    const script: string[] = ["set -e", "if [ ! -d /workspace ]; then sudo mkdir -p /workspace && sudo chown $(id -u):$(id -g) /workspace; fi"]
    for (const file of files) {
      const target = `/workspace/${file.path.replace(/^\/+/, "")}`
      const dir = target.slice(0, target.lastIndexOf("/"))
      if (dir.length > 0) script.push(`mkdir -p ${shellQuote(dir)}`)
      const encoded = Buffer.from(file.content, "utf8").toString("base64")
      script.push(`base64 -d > ${shellQuote(target)} <<'ONLYNE_FILE_EOF'`)
      for (let i = 0; i < encoded.length; i += 76) script.push(encoded.slice(i, i + 76))
      script.push("ONLYNE_FILE_EOF")
    }

    await execInSandboxOrThrow(lease, ["/bin/sh", "-c", script.join("\n")], {
      what: `Writing ${files.length} file(s) into ${lease.name}`,
    })
  }

  /** Every regular file under `/workspace`, read back as text, over the lease's transport. */
  async #collectWorkspaceFiles(lease: SandboxDescriptor): Promise<ArtifactFile[]> {
    const script = [
      "cd /workspace || exit 0",
      "find . -type f ! -name '.*' | while IFS= read -r f; do",
      "  printf '%s\\t' \"${f#./}\"",
      "  base64 -w0 \"$f\" 2>/dev/null || base64 \"$f\" | tr -d '\\n'",
      "  printf '\\n'",
      "done",
    ].join("\n")

    const result = await execInSandbox(lease, ["/bin/sh", "-c", script])
    if (result.code !== 0) return []

    const files: ArtifactFile[] = []
    for (const line of result.stdout.split("\n")) {
      const tab = line.indexOf("\t")
      if (tab <= 0) continue
      const path = line.slice(0, tab)
      try {
        files.push({ path, content: Buffer.from(line.slice(tab + 1), "base64").toString("utf8") })
      } catch {
        // a file that is not valid base64 is skipped rather than corrupting the bundle
      }
    }
    return files
  }

  #require(taskId: string): TaskRecord {
    const task = this.#tasks.get(taskId)
    if (!task) throw new Error(`Unknown task: ${taskId}`)
    return task
  }

  /** Ends a worker's resident agent before its sandbox goes away. */
  async #stopWorkerAgent(taskId: string): Promise<void> {
    const host = this.#workerAgents.get(taskId)
    if (host === undefined) return
    this.#workerAgents.delete(taskId)
    await host.stop().catch(() => undefined)
  }
}