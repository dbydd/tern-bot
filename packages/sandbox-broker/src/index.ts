import { $ } from "bun"

/**
 * Contract: design/contract/sharedInfra.sandboxBroker.leaseManager.vdmsl
 *
 * Control plane only: acquisition, renewal, release and TTL expiry of a lease.
 * The data plane (SSH exec, noVNC streaming) goes straight to the sandbox and
 * never crosses Onlyne, so the driver below is the only place that talks to a
 * compute backend.
 */

export type LeaseState = "PROVISIONING" | "RUNNING" | "STOPPED" | "FAILED"
export type SandboxKind = "main" | "worker"

export interface AcquireRequest {
  botId: string
  kind: SandboxKind
  ttlSecs: number
  spec: Record<string, unknown>
}

export interface Lease {
  id: string
  botId: string
  kind: SandboxKind
  leaseState: LeaseState
  ttlSecs: number
  elapsedSecs: number
  ports: Record<string, number>
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface StreamEndpoint {
  novncUrl: string
  sshPort: number
}

export interface SandboxDriver {
  /** Returns the backend's sandbox id. */
  create(spec: Record<string, unknown>): Promise<string>
  exec(id: string, cmd: string[]): Promise<ExecResult>
  destroy(id: string): Promise<void>
  getStreamUrl(id: string): Promise<StreamEndpoint>
}

/** The shape an Onlyne RFC 0019 resource descriptor reports for one sandbox. */
export interface LeaseResourceView {
  id: string
  state: LeaseState
  ttlSeconds: number
  elapsedSeconds: number
  /** Null once the sandbox is gone; a stopped lease has no data plane. */
  ports: StreamEndpoint | null
}

interface Held {
  lease: Lease
  sandboxId: string | null
}

/**
 * Lease state machine over a driver. DESTROYED is not a state: the record ends
 * at STOPPED and stays queryable, while the sandbox behind it is gone.
 *
 * `tick` stops an expired lease and destroys its sandbox in the same pass: the
 * VDM box constrains the record, and an expired record without a reclaimed VM
 * is the orphan this state machine exists to prevent.
 */
export class LeaseManager {
  readonly #driver: SandboxDriver
  readonly #held = new Map<string, Held>()

  constructor(driver: SandboxDriver) {
    this.#driver = driver
  }

  async acquire(req: AcquireRequest): Promise<Lease> {
    if (req.ttlSecs <= 0) {
      throw new Error(`ttlSecs must be positive, got ${req.ttlSecs}`)
    }
    const lease: Lease = {
      id: `lease-${crypto.randomUUID().slice(0, 8)}`,
      botId: req.botId,
      kind: req.kind,
      leaseState: "PROVISIONING",
      ttlSecs: req.ttlSecs,
      elapsedSecs: 0,
      ports: {},
    }
    // The record exists as PROVISIONING while the backend boots, exactly the
    // window the VDM's acquire post describes; it becomes RUNNING when the
    // driver hands back a sandbox, and FAILED when it hands back nothing.
    const held: Held = { lease, sandboxId: null }
    this.#held.set(lease.id, held)
    try {
      held.sandboxId = await this.#driver.create(req.spec)
      lease.leaseState = "RUNNING"
    } catch (err) {
      lease.leaseState = "FAILED"
      throw err
    }
    return lease
  }

  async tick(deltaSecs: number): Promise<void> {
    for (const held of this.#held.values()) {
      if (held.lease.leaseState !== "RUNNING") continue
      held.lease.elapsedSecs += deltaSecs
      if (held.lease.elapsedSecs < held.lease.ttlSecs) continue
      held.lease.leaseState = "STOPPED"
      await this.#reclaim(held)
    }
  }

  async renew(id: string, extendSecs: number): Promise<boolean> {
    const held = this.#held.get(id)
    if (!held) {
      throw new Error(`unknown lease: ${id}`)
    }
    const { lease } = held
    if (lease.leaseState !== "RUNNING") return false
    lease.ttlSecs += extendSecs
    return true
  }

  async release(id: string): Promise<void> {
    const held = this.#held.get(id)
    if (!held) {
      throw new Error(`unknown lease: ${id}`)
    }
    if (held.lease.leaseState === "STOPPED" || held.lease.leaseState === "FAILED") return
    held.lease.leaseState = "STOPPED"
    await this.#reclaim(held)
  }

  async query(id: string): Promise<Lease | null> {
    return this.#held.get(id)?.lease ?? null
  }

  async describe(id: string): Promise<LeaseResourceView | null> {
    const held = this.#held.get(id)
    if (!held) return null
    const ports = held.sandboxId === null ? null : await this.#driver.getStreamUrl(held.sandboxId)
    return {
      id: held.lease.id,
      state: held.lease.leaseState,
      ttlSeconds: held.lease.ttlSecs,
      elapsedSeconds: held.lease.elapsedSecs,
      ports,
    }
  }

  async #reclaim(held: Held): Promise<void> {
    if (held.sandboxId === null) return
    await this.#driver.destroy(held.sandboxId)
    held.sandboxId = null
  }
}

/**
 * In-memory driver for tests and for machines without a backend: no VM, no
 * data plane. `getStreamUrl` answers a placeholder so lease plumbing can be
 * exercised without OrbStack installed.
 */
export class MockDriver implements SandboxDriver {
  readonly #live = new Set<string>()
  readonly calls: string[] = []

  async create(spec: Record<string, unknown>): Promise<string> {
    const id = typeof spec.name === "string" ? spec.name : `mock-${crypto.randomUUID().slice(0, 8)}`
    this.#live.add(id)
    this.calls.push(`create ${id}`)
    return id
  }

  async exec(id: string, cmd: string[]): Promise<ExecResult> {
    if (!this.#live.has(id)) throw new Error(`unknown sandbox: ${id}`)
    this.calls.push(`exec ${id} ${cmd.join(" ")}`)
    return { stdout: "", stderr: "", exitCode: 0 }
  }

  async destroy(id: string): Promise<void> {
    this.#live.delete(id)
    this.calls.push(`destroy ${id}`)
  }

  async getStreamUrl(id: string): Promise<StreamEndpoint> {
    if (!this.#live.has(id)) throw new Error(`unknown sandbox: ${id}`)
    return { novncUrl: `mock://${id}/vnc.html`, sshPort: 0 }
  }
}

/**
 * Local Docker containers, the fallback when OrbStack is not installed
 * (plan Assumption 1). The container image is expected to expose 6080 (noVNC)
 * and 22 (sshd); both are published to ephemeral loopback ports.
 */
export class DockerDriver implements SandboxDriver {
  readonly #docker: string
  readonly #image: string

  constructor(opts: { docker?: string; image?: string } = {}) {
    this.#docker = opts.docker ?? process.env.TERN_BOT_DOCKER ?? Bun.which("docker") ?? "docker"
    this.#image = opts.image ?? process.env.TERN_BOT_DOCKER_IMAGE ?? "ubuntu:24.04"
  }

  async create(spec: Record<string, unknown>): Promise<string> {
    const name = stringSpec(spec, "name") ?? `tern-bot-${crypto.randomUUID().slice(0, 8)}`
    const image = stringSpec(spec, "image") ?? this.#image
    const res =
      await $`${this.#docker} run -d --name ${name} -p 127.0.0.1::6080 -p 127.0.0.1::22 ${image} sleep infinity`
        .nothrow()
        .quiet()
    if (res.exitCode !== 0) {
      throw new Error(`docker run ${name} failed: ${res.stderr.toString().trim()}`)
    }
    return name
  }

  async exec(id: string, cmd: string[]): Promise<ExecResult> {
    const res = await $`${this.#docker} exec ${id} ${cmd}`.nothrow().quiet()
    return {
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      exitCode: res.exitCode,
    }
  }

  async destroy(id: string): Promise<void> {
    const res = await $`${this.#docker} rm -f ${id}`.nothrow().quiet()
    if (res.exitCode !== 0) {
      throw new Error(`docker rm ${id} failed: ${res.stderr.toString().trim()}`)
    }
  }

  async getStreamUrl(id: string): Promise<StreamEndpoint> {
    const novnc = await this.#publishedPort(id, 6080)
    if (novnc === null) {
      throw new Error(`container ${id} publishes no 6080 port`)
    }
    return {
      novncUrl: `http://127.0.0.1:${novnc}/vnc.html?autoconnect=1&view_only=true`,
      sshPort: (await this.#publishedPort(id, 22)) ?? 0,
    }
  }

  async #publishedPort(id: string, containerPort: number): Promise<number | null> {
    const res = await $`${this.#docker} port ${id} ${containerPort}`.nothrow().quiet()
    if (res.exitCode !== 0) return null
    const first = res.stdout.toString().trim().split("\n")[0] ?? ""
    const port = Number(first.slice(first.lastIndexOf(":") + 1))
    return Number.isInteger(port) && port > 0 ? port : null
  }
}

/**
 * OrbStack machines on this Mac.
 *
 * `create` is `orbctl create -a <arch> <distro> <name>`; the machine name is the
 * sandbox id. OrbStack does not give each machine its own SSH port: the one
 * gateway listens on localhost and the machine name is the SSH user, which is
 * why `getStreamUrl` reports that shared port rather than a per-sandbox one.
 */
export class OrbstackDriver implements SandboxDriver {
  readonly #orbctl: string
  readonly #image: string

  constructor(opts: { orbctl?: string; image?: string } = {}) {
    this.#orbctl =
      opts.orbctl ?? process.env.TERN_BOT_ORBCTL ?? Bun.which("orbctl") ?? "/opt/homebrew/bin/orbctl"
    this.#image = opts.image ?? "ubuntu:24.04"
  }

  async create(spec: Record<string, unknown>): Promise<string> {
    const name = stringSpec(spec, "name") ?? `tern-bot-${crypto.randomUUID().slice(0, 8)}`
    const distro = stringSpec(spec, "image") ?? this.#image
    const flags: string[] = []
    const arch = stringSpec(spec, "arch")
    if (arch) flags.push("-a", arch)
    for (const flag of ["cpus", "memory", "disk"] as const) {
      const value = stringSpec(spec, flag)
      if (value) flags.push(`--${flag}`, value)
    }
    if (spec.isolated === true) flags.push("--isolated")

    const res = await $`${this.#orbctl} create ${flags} ${distro} ${name}`.nothrow().quiet()
    if (res.exitCode !== 0) {
      throw new Error(`orbctl create ${name} failed: ${res.stderr.toString().trim()}`)
    }
    return name
  }

  async exec(id: string, cmd: string[]): Promise<ExecResult> {
    // --path=false: argv must reach Linux untouched; orbctl otherwise rewrites
    // absolute macOS paths into their /mnt/mac spellings.
    const res = await $`${this.#orbctl} run -m ${id} --path=false ${cmd}`.nothrow().quiet()
    return {
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      exitCode: res.exitCode,
    }
  }

  async destroy(id: string): Promise<void> {
    const res = await $`${this.#orbctl} delete -f ${id}`.nothrow().quiet()
    if (res.exitCode !== 0) {
      throw new Error(`orbctl delete ${id} failed: ${res.stderr.toString().trim()}`)
    }
  }

  async getStreamUrl(id: string): Promise<StreamEndpoint> {
    const novncPort = numberSpec(Bun.env["TERN_BOT_NOVNC_PORT"]) ?? 6080
    const info = await $`${this.#orbctl} info ${id} --format json`.nothrow().quiet()
    if (info.exitCode !== 0) {
      throw new Error(`orbctl info ${id} failed: ${info.stderr.toString().trim()}`)
    }
    const machine = JSON.parse(info.stdout.toString()) as { ip4?: string }
    if (!machine.ip4) {
      throw new Error(`orbctl info ${id} reported no ip4 address`)
    }
    return {
      novncUrl: `http://${machine.ip4}:${novncPort}/vnc.html?autoconnect=1&view_only=true`,
      sshPort: await orbstackSshPort(),
    }
  }
}

function stringSpec(spec: Record<string, unknown>, key: string): string | undefined {
  const value = spec[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberSpec(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Port of the shared OrbStack SSH gateway, from its generated ssh config. */
async function orbstackSshPort(): Promise<number> {
  const config = `${Bun.env["HOME"] ?? ""}/.orbstack/ssh/config`
  const text = await Bun.file(config)
    .text()
    .catch(() => "")
  const match = /^\s*Port\s+(\d+)\s*$/m.exec(text)
  return match ? Number(match[1]) : 32222
}
