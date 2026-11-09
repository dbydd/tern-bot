/**
 * Host-side control of a sandbox-resident ACP agent.
 *
 * The resident (`sandbox/worker.py`) owns the child agent's stdin/stdout and its one
 * ACP session. A Tern front pane holds only a connector to that resident, so closing
 * the pane detaches and leaves the agent working; reopening attaches again.
 *
 * Everything here runs on the host and talks to the resident through the lease's own
 * exec transport (`@onlyne/compute-core`). The resident keeps its files under
 * `/tmp/tern-bot` so `/workspace` stays the artifact tree.
 */

import { execInSandbox, shellQuote, type SandboxDescriptor } from "@onlyne/compute-core"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const RESIDENT_DIR = "/tmp/tern-bot"
const RESIDENT_SCRIPT = `${RESIDENT_DIR}/worker.py`
/** The one custom agent id the front pane resolves; see `acpFrontEntry`. */
export const ACP_FRONT_AGENT_ID = "tern-bot-worker"
/**
 * Host directory holding the HOME template every sandbox agent receives. Its contents
 * are a HOME tree (`.omp/agent`, `.claude`, `.config/...`), kept separate from the Bot's
 * own omp configuration.
 */
export const SANDBOX_CFG_ENV = "TERN_BOT_SANDBOX_CFG"
const SANDBOX_CFG_DEFAULT = join(homedir(), ".config", "tern-bot", "sandbox-cfg")

export interface WorkerAgentConfig {
  /** argv of the agent CLI, run inside the sandbox, e.g. `["omp", "acp"]`. */
  command: string[]
  /** Extra environment for the agent CLI. */
  env?: Record<string, string>
  /** Working directory for the agent, default `/workspace`. */
  cwd?: string
  /** Initial task prompt, submitted by the resident without a frontend attached. */
  prompt?: string
}

export interface WorkerAgentStatus {
  pid?: number
  agentPid?: number
  sessionId?: string
  phase?: "starting" | "working" | "idle" | "waiting_input" | "failed" | "exited"
  error?: string
  pendingFrontendPermissionCount?: number
  activePromptOrigin?: "frontend" | "control" | null
  lastPrompt?: {
    origin: "frontend" | "control"
    state: "done" | "error"
    stopReason?: string
    error?: unknown
  }
}

export interface WorkerAgentHandle {
  /** Sandbox path of the resident state directory. */
  stateDir: string
  pid?: number
  agentPid?: number
  sessionId?: string
  phase: string
}

/** Host directory holding the front's target file and its isolated Tern config. */
export interface AcpFront {
  settingsDir: string
  targetFile: string
  /** Environment + command a pane runs to open the front. */
  paneCommand: string
}

export class WorkerAgentHost {
  readonly #lease: Pick<SandboxDescriptor, "connection" | "allocated">
  readonly #stateDir: string
  readonly #sandboxConfigRoot: string

  constructor(
    lease: Pick<SandboxDescriptor, "connection" | "allocated">,
    workerId: string,
    opts?: { sandboxConfigRoot?: string },
  ) {
    this.#lease = lease
    this.#stateDir = `${RESIDENT_DIR}/state/${sanitize(workerId)}`
    this.#sandboxConfigRoot = opts?.sandboxConfigRoot ?? process.env[SANDBOX_CFG_ENV] ?? SANDBOX_CFG_DEFAULT
  }

  get stateDir(): string {
    return this.#stateDir
  }

  /**
   * Exports the HOME template, uploads the resident and starts it detached. The launch
   * returns once the socket and status file exist; a bad agent command or a failed
   * handshake surfaces here instead of as a pane that opens on nothing.
   */
  async launch(config: WorkerAgentConfig): Promise<WorkerAgentHandle> {
    const scriptSource = readFileSync(defaultResidentPath(), "utf8")
    const configPath = `${RESIDENT_DIR}/worker.json`
    const home = await this.#exportHome()
    const env = { HOME: home, XDG_CONFIG_HOME: `${home}/.config`, ...config.env }
    const payload = {
      command: config.command,
      cwd: config.cwd ?? "/workspace",
      prompt: config.prompt ?? "",
      stateDir: this.#stateDir,
      env,
    }

    const script = [
      "set -e",
      `mkdir -p ${shellQuote(`${RESIDENT_DIR}/state`)}`,
      heredoc(RESIDENT_SCRIPT, scriptSource),
      heredoc(configPath, `${JSON.stringify(payload, null, 2)}\n`),
      `python3 ${RESIDENT_SCRIPT} launch --config ${shellQuote(configPath)}`,
    ].join("\n")

    const result = await execInSandbox(this.#lease, ["/bin/sh", "-c", script])
    if (result.code !== 0) {
      throw new Error(`Worker agent launch failed (exit ${result.code}): ${tail(result.stderr, result.stdout)}`)
    }

    const receipt = parseReceipt(result.stdout)
    if (receipt === undefined) {
      throw new Error(`Worker agent launch returned no receipt: ${tail(result.stdout, result.stderr)}`)
    }
    if (receipt.error !== undefined) {
      throw new Error(`Worker agent launch failed: ${String(receipt.error)}`)
    }
    const pid = asNumber(receipt.pid)
    const agentPid = asNumber(receipt.agentPid)
    const sessionId = asString(receipt.sessionId)
    return {
      stateDir: this.#stateDir,
      ...(pid === undefined ? {} : { pid }),
      ...(agentPid === undefined ? {} : { agentPid }),
      ...(sessionId === undefined ? {} : { sessionId }),
      phase: asString(receipt.phase) ?? "starting",
    }
  }

  /**
   * Exports the host template into the sandbox's own HOME and returns that HOME.
   *
   * The template is a HOME tree, so `.omp/agent`, `.claude` and `.config/...` land at
   * their normal places and no agent CLI needs a special-case directory. Regular file
   * bytes and modes travel in one tar stream over stdin — symlinks are materialized
   * because a host absolute link means nothing inside the container — so no config
   * content ever reaches argv, logs or error text. A missing template is created empty
   * rather than silently handing the agent the host's global configuration.
   */
  async #exportHome(): Promise<string> {
    const home = await this.#remoteHome()
    const template = this.#sandboxConfigRoot
    mkdirSync(template, { recursive: true })

    const archive = Bun.spawn(["tar", "-chf", "-", "-C", template, "."], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [bytes, stderr, code] = await Promise.all([
      new Response(archive.stdout).bytes(),
      new Response(archive.stderr).text(),
      archive.exited,
    ])
    if (code !== 0) {
      throw new Error(
        `Sandbox config archive from ${template} failed (exit ${code}): ${tarDiagnostic(stderr)}`,
      )
    }

    const entries = readdirSync(template)
    const script = [
      "set -e",
      "umask 077",
      `mkdir -p ${shellQuote(home)}`,
      `tar -xf - -C ${shellQuote(home)}`,
      ...(entries.length === 0
        ? []
        : [`chmod -R go-rwx -- ${entries.map((name) => shellQuote(`${home}/${name}`)).join(" ")}`]),
    ].join("\n")
    const result = await execInSandbox(this.#lease, ["/bin/sh", "-c", script], { stdin: bytes })
    if (result.code !== 0) {
      throw new Error(
        `Sandbox config extraction into ${home} failed (exit ${result.code}): ${tarDiagnostic(result.stderr)}`,
      )
    }
    return home
  }

  async #remoteHome(): Promise<string> {
    const result = await execInSandbox(this.#lease, ["/bin/sh", "-c", 'printf %s "$HOME"'])
    const home = result.stdout.trim()
    if (result.code !== 0 || home.length === 0) {
      throw new Error(`Sandbox home is unknown: ${tail(result.stderr, result.stdout)}`)
    }
    if (!home.startsWith("/")) throw new Error(`Sandbox home is not an absolute path: ${home}`)
    return home
  }

  async status(): Promise<WorkerAgentStatus> {
    return await this.#request("tern-bot/status")
  }

  /** Submits a further prompt to the same resident session; no frontend needed. */
  async prompt(text: string): Promise<WorkerAgentStatus> {
    return await this.#request("tern-bot/prompt", { text })
  }

  /** Ends the resident and its agent. Only an explicit worker lifecycle calls this. */
  async stop(): Promise<void> {
    await this.#request("tern-bot/stop")
  }

  async #request<T>(method: string, params?: unknown): Promise<T> {
    const args = [
      "python3",
      RESIDENT_SCRIPT,
      "request",
      "--state-dir",
      this.#stateDir,
      "--method",
      method,
      ...(params === undefined ? [] : ["--params", JSON.stringify(params)]),
    ]
    const result = await execInSandbox(this.#lease, args)
    const body = parseReceipt(result.stdout)
    if (body === undefined) {
      throw new Error(`Worker agent ${method} returned no JSON: ${tail(result.stdout, result.stderr)}`)
    }
    if (result.code !== 0 || (body.error !== undefined && body.error !== null)) {
      throw new Error(`Worker agent ${method} failed: ${String(body.error ?? tail(result.stderr, result.stdout))}`)
    }
    return body as T
  }

  /**
   * Writes what a front pane needs: a target file naming the sandbox-side connector
   * argv, and an isolated Tern config directory declaring the one custom ACP agent.
   * `TERN_CONFIG_DIR` keeps the user's settings.json untouched.
   */
  acpFront(hostDir: string, settingsDir: string, relayPath: string): AcpFront {
    mkdirSync(hostDir, { recursive: true })
    mkdirSync(settingsDir, { recursive: true })
    const targetFile = join(hostDir, "acp-target.json")
    writeFileSync(targetFile, `${JSON.stringify({ argv: this.connectorArgv() }, null, 2)}\n`)
    writeFileSync(join(settingsDir, "settings.json"), `${JSON.stringify(acpFrontSettings(relayPath), null, 2)}\n`)
    const paneCommand = [
      `TERNBOT_WORKER_ACP=${shellQuote(targetFile)}`,
      `TERN_CONFIG_DIR=${shellQuote(settingsDir)}`,
      `tern acp ${ACP_FRONT_AGENT_ID}`,
    ].join(" ")
    return { settingsDir, targetFile, paneCommand }
  }

  /** argv of the sandbox-side ACP connector, which the host relay execs. */
  connectorArgv(): string[] {
    const endpoint = this.#lease.connection
    const containerId = this.#lease.allocated?.container_id
    const remote = ["python3", RESIDENT_SCRIPT, "connect", "--state-dir", this.#stateDir]

    if (endpoint?.exec_transport === "ssh" && endpoint.ssh_endpoint !== undefined) {
      const user = endpoint.auth?.user ?? "root"
      const argv = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "BatchMode=yes",
      ]
      if (endpoint.auth?.private_key !== undefined) argv.push("-i", endpoint.auth.private_key)
      const sshEndpoint = endpoint.ssh_endpoint
      if (sshEndpoint.includes("@") && !sshEndpoint.includes(":")) {
        argv.push(`${user}@${sshEndpoint}`, "--", remote.map(shellQuote).join(" "))
        return argv
      }
      const at = sshEndpoint.lastIndexOf(":")
      const host = at === -1 ? sshEndpoint : sshEndpoint.slice(0, at)
      const port = at === -1 ? 22 : Number(sshEndpoint.slice(at + 1)) || 22
      argv.push("-p", String(port), `${user}@${host}`, "--", remote.map(shellQuote).join(" "))
      return argv
    }
    if (containerId === undefined) {
      throw new Error(
        `Sandbox exposes no ACP connector transport (exec_transport=${String(endpoint?.exec_transport)}, container=none)`,
      )
    }
    return ["docker", "exec", "-i", containerId, ...remote]
  }
}

/** The minimal `settings.json` a front config directory needs: one custom ACP agent. */
export function acpFrontSettings(relayPath: string): { agents: { custom: Array<Record<string, unknown>> } } {
  return {
    agents: {
      custom: [
        {
          id: ACP_FRONT_AGENT_ID,
          name: "Tern Bot Worker",
          command: relayPath,
          args: [],
          env: {},
        },
      ],
    },
  }
}

/** Absolute path of the shipped relay, resolved from this module's own location. */
export function defaultRelayPath(): string {
  return fileURLToPath(new URL("../bin/worker-acp", import.meta.url))
}

/** Absolute path of the shipped sandbox resident. */
export function defaultResidentPath(): string {
  return fileURLToPath(new URL("../sandbox/worker.py", import.meta.url))
}

function sanitize(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_") || "worker"
}

/** Shell heredoc for one file. */
function heredoc(target: string, content: string, marker = "TERNBOT_FILE_EOF"): string {
  return `cat > ${shellQuote(target)} <<'${marker}'\n${content}\n${marker}`
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function parseReceipt(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      // not the receipt line
    }
  }
  return undefined
}

function tail(primary: string, secondary: string): string {
  const text = `${primary.trim()}\n${secondary.trim()}`.trim()
  return text.length > 2000 ? text.slice(-2000) : text
}

/** Prefixes of the tools our export script runs; each reports paths and reasons only. */
const DIAGNOSTIC_PREFIXES = ["tar:", "mkdir:", "chmod:", "sh:", "-sh:"]

/**
 * The path-and-reason lines of a failed archive or extraction, with the archive bytes
 * kept out of the error text.
 */
function tarDiagnostic(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => DIAGNOSTIC_PREFIXES.some((prefix) => line.startsWith(prefix)))
  return lines.length === 0 ? "(no diagnostic)" : lines.slice(0, 20).join("; ")
}
