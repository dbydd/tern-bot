/**
 * Running a command inside a leased sandbox.
 *
 * The published `@onlyne/compute-core@3.2.0` does not export these helpers yet, so this
 * module mirrors its exec transport until that ships. A lease does not promise a
 * container: the Docker driver hands back a container id, the OrbStack machine driver
 * hands back a machine name. `DirectConnection` is where a provider states how to reach
 * it, so every caller execs through here instead of hard-coding `docker exec`.
 */

import type { DirectConnection, SandboxDescriptor } from "@onlyne/compute-core"

export interface ExecOptions {
  /** Bytes written to the command's stdin. */
  stdin?: string | Uint8Array
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** POSIX single-quote quoting: the only thing a remote shell must not reinterpret. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function quoteArgv(argv: ReadonlyArray<string>): string {
  return argv.map(shellQuote).join(" ")
}

function splitEndpoint(endpoint: string): { host: string; port: number } {
  const at = endpoint.lastIndexOf(":")
  if (at === -1) return { host: endpoint, port: 22 }
  const port = Number(endpoint.slice(at + 1))
  return { host: endpoint.slice(0, at), port: Number.isFinite(port) ? port : 22 }
}

/**
 * The argv that reaches `command` on a sandbox, or a throw when the provider states no
 * transport — guessing between ssh and docker would send a command to the wrong machine.
 */
function transportArgv(
  connection: DirectConnection | undefined,
  containerId: string | undefined,
  command: string,
): string[] {
  const transport = connection?.exec_transport
  if (transport === "ssh" && connection?.ssh_endpoint !== undefined) {
    const endpoint = connection.ssh_endpoint
    const user = connection.auth?.user ?? "root"
    const argv = [
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "BatchMode=yes",
    ]
    if (connection.auth?.private_key !== undefined) {
      argv.push("-i", connection.auth.private_key)
    }
    if (endpoint.includes("@") && !endpoint.includes(":")) {
      // A full destination, e.g. `machine@orb` through a proxy alias: the user travels in it.
      argv.push(`${user}@${endpoint}`, "--", command)
      return argv
    }
    const { host, port } = splitEndpoint(endpoint)
    argv.push("-p", String(port))
    argv.push(`${user}@${host}`, "--", command)
    return argv
  }
  if (transport === "docker_exec" || (transport === undefined && containerId !== undefined)) {
    if (containerId === undefined) {
      throw new Error("Lease declares docker_exec but allocated no container id")
    }
    return ["docker", "exec", "-i", containerId, "/bin/sh", "-c", command]
  }
  throw new Error(
    `Sandbox exposes no exec transport (exec_transport=${String(transport)}, container=${containerId ?? "none"})`,
  )
}

export async function execInSandbox(
  lease: Pick<SandboxDescriptor, "connection" | "allocated">,
  argv: ReadonlyArray<string>,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const containerId = lease.allocated?.container_id
  const command = options.cwd === undefined
    ? quoteArgv(argv)
    : `cd ${shellQuote(options.cwd)} && ${quoteArgv(argv)}`
  const shellArgv = transportArgv(lease.connection, containerId, command)

  const proc = Bun.spawn(shellArgv, {
    stdin: options.stdin === undefined
      ? "ignore"
      : typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    timer = setTimeout(() => proc.kill(), options.timeoutMs)
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  return { code, stdout, stderr }
}

/** Same as `execInSandbox`, but a non-zero exit is an error the caller must handle. */
export async function execInSandboxOrThrow(
  lease: Pick<SandboxDescriptor, "connection" | "allocated">,
  argv: ReadonlyArray<string>,
  options: ExecOptions & { what: string },
): Promise<ExecResult> {
  const result = await execInSandbox(lease, argv, options)
  if (result.code !== 0) {
    throw new Error(`${options.what} failed (exit ${result.code}): ${result.stderr.trim()}`)
  }
  return result
}
