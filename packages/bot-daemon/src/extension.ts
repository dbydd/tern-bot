/**
 * OMP extension installed under `~/.config/tern-bot/extensions/tern-bot/`.
 *
 * 1. Tavern Harness Prefix/Infix/Suffix integration:
 *    - `before_agent_start`: formatForSystemPrompt() appended to systemPrompt
 *    - `session.compacting`: buildCompactionPayload() saved to preserveData
 *    - `context`: Author's Note injected at depth D
 *
 * 2. Real BDFL & Sandbox Tools registered into OMP:
 *    - `bdfl_dispatch`: provision worker sandbox via Onlyne ComputeBrokerService
 *    - `bdfl_review`: provision Bot review sandbox & serve bundle on 8080
 *    - `sandbox_browser`: drive Chromium over CDP with automatic [ref=eN]
 *      bounding-box visual overlay and AX text tree injection on EVERY step
 *    - `bdfl_accept`: verify & accept deliverable, export files, release sandboxes
 *    - `bdfl_status`: live status of tasks, Onlyne compute leases, and ledger
 */

import { startBotDaemon, type BotDaemon } from "./index.ts"

export interface ExtensionCommandUI {
  notify?(message: string, level?: "info" | "warning" | "error"): void
}

export interface ExtensionCommandCtx {
  ui?: ExtensionCommandUI
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
  details?: Record<string, unknown>
}

// Minimal shape of the ExtensionAPI provided by OMP at runtime
export interface ExtensionLikeAPI {
  on(event: string, handler: (event: any, ctx?: any) => any): void
  setSessionName?(name: string): Promise<void>
  getSessionName?(): Promise<string>
  zod?: any
  registerCommand?(
    name: string,
    spec: {
      description: string
      handler: (args: string, ctx?: ExtensionCommandCtx) => Promise<unknown>
    },
  ): void
  registerTool?(spec: {
    name: string
    label?: string
    description: string
    parameters?: any
    execute: (
      toolCallId: string,
      params: any,
      onUpdate?: any,
      ctx?: any,
      signal?: AbortSignal,
    ) => Promise<ToolResult>
  }): void
}

export default function ternBotExtension(pi: ExtensionLikeAPI): void {
  let daemonPromise: Promise<BotDaemon> | null = null

  // OMP injects its schema builder as `pi.zod`.
  const z = pi.zod

  const getDaemon = (): Promise<BotDaemon> => {
    if (!daemonPromise) {
      const botId = process.env.TERN_BOT_ID ?? "bot-1"
      daemonPromise = startBotDaemon({ botId }).then((d) => {
        d.harness.registerLoreEntry({
          id: "bdfl-merge-gate",
          keys: ["accept", "merge", "task", "review", "sandbox"],
          content:
            "Rule: A task deliverable cannot be accepted without at least one observation inside the live review sandbox.",
          cooldownTurns: 2,
        })
        return d
      })
    }
    return daemonPromise
  }

  // Bring the daemon up with the session: its status server is what makes the
  // Tern board appear, so it must not wait for the first tool call.
  pi.on("session_start", async () => {
    await getDaemon()
    const botId = process.env.TERN_BOT_ID
    if (botId && typeof pi.setSessionName === "function") {
      await pi.setSessionName(`Bot: ${botId}`).catch(() => undefined)
    }
  })
  pi.on("input", async () => {
    const botId = process.env.TERN_BOT_ID
    if (botId && typeof pi.setSessionName === "function") {
      await pi.setSessionName(`Bot: ${botId}`).catch(() => undefined)
    }
  })

  // 1. Stable Prefix
  pi.on("before_agent_start", async (event: any) => {
    const d = await getDaemon()
    if (typeof event?.prompt === "string" && event.prompt.trim().length > 0) {
      d.harness.ingestMessage(event.prompt)
    }
    const tasks = d.bdfl.status()
    d.harness.setAuthorNote(
      `<current-env>bot=${d.botId} active_tasks=${tasks.length} pending_review=${
        tasks.filter((t) => t.state === "SUBMITTED" || t.state === "REVIEWING").length
      }</current-env>`,
      2,
    )
    const base = Array.isArray(event?.systemPrompt) ? event.systemPrompt : []
    return {
      systemPrompt: [...base, d.harness.formatForSystemPrompt().join("\n")],
    }
  })

  // 2. Frozen Infix
  pi.on("session.compacting", async () => {
    const d = await getDaemon()
    const payload = d.harness.buildCompactionPayload()
    return {
      context: [payload.summary],
      preserveData: payload.preserveData,
    }
  })

  // 3. Rolling Suffix & Depth-D Author's Note
  pi.on("context", async (event: any) => {
    const d = await getDaemon()
    d.harness.assemblePrompt()
    if (!Array.isArray(event?.messages) || event.messages.length === 0) return undefined
    const windowMsgs = d.harness.assembleWindowMessages()
    const injected = windowMsgs.find((m) => m.perCallInjected)
    if (!injected) return undefined
    const copy = [...event.messages]
    const insertIdx = Math.max(0, copy.length - 2)
    copy.splice(insertIdx, 0, {
      role: "developer",
      content: injected.content,
      synthetic: true,
      timestamp: Date.now(),
    })
    return { messages: copy }
  })

  // 4. Register BDFL and Sandbox Computer Use Tools
  if (typeof pi.registerTool === "function") {
    // Tool: bdfl_dispatch
    pi.registerTool({
      name: "bdfl_dispatch",
      label: "Dispatch Task to Worker Sandbox",
      description:
        "Provisions an isolated worker sandbox via Onlyne ComputeBrokerService and dispatches a task. Optionally executes a worker build script inside the worker sandbox to produce the deliverable ArtifactBundle.",
      parameters: z?.object({
        title: z.string().describe("Short task title"),
        description: z.string().describe("What the worker must build or change"),
        workerScript: z
          .string()
          .optional()
          .describe("Shell command run inside the worker sandbox to produce the deliverable"),
      }),
      execute: async (_id, params: any) => {
        const d = await getDaemon()
        const title = String(params?.title ?? "Untitled Task")
        const description = String(params?.description ?? "")
        const workerScript = params?.workerScript ? String(params.workerScript) : undefined
        const task = await d.bdfl.dispatch(title, description, { workerScript })

        const container = task.workerLease?.allocated?.container_id?.slice(0, 12) ?? "none"
        const desktop = task.workerLease?.connection?.portal_urls?.desktop ?? "none"

        return {
          content: [
            {
              type: "text",
              text: [
                `Task dispatched: [${task.id}] "${task.title}"`,
                `Worker sandbox container: ${container}`,
                `Worker desktop stream (noVNC): ${desktop}`,
                `State: ${task.state}`,
                task.workerAgent
                  ? task.workerAgent.error === undefined
                    ? `Sandbox agent: ${task.workerAgent.phase}${
                        task.workerAgent.sessionId === undefined ? "" : ` · session ${task.workerAgent.sessionId}`
                      }`
                    : `Sandbox agent failed: ${task.workerAgent.error}`
                  : "Sandbox agent: not started",
                task.workerAgent?.front === undefined
                  ? "Worker session: unavailable"
                  : "Worker session: board → select the worker → 打开会话",
                task.submittedBundle
                  ? `ArtifactBundle auto-submitted: ${task.submittedBundle.files.length} file(s)`
                  : `Waiting for worker submission`,
              ].join("\n"),
            },
          ],
          details: { task },
        }
      },
    })

    // Tool: bdfl_review
    pi.registerTool({
      name: "bdfl_review",
      label: "Open Review Sandbox for Task",
      description:
        "Provisions the Bot's dedicated review sandbox VM, unpacks the task's ArtifactBundle into /workspace, and starts an HTTP server on port 8080. Ready for sandbox_browser verification.",
      parameters: z?.object({
        taskId: z.string().describe("Task id returned by bdfl_dispatch"),
      }),
      execute: async (_id, params: any) => {
        const d = await getDaemon()
        const taskId = String(params?.taskId ?? "")
        const task = await d.bdfl.review(taskId)

        const desktopUrl = task.reviewLease?.connection?.portal_urls?.desktop ?? ""
        const cdpEndpoint = task.reviewLease?.connection?.endpoints?.cdp ?? ""

        return {
          content: [
            {
              type: "text",
              text: [
                `Review sandbox ready for task ${task.id}:`,
                `- Review desktop stream: ${desktopUrl}`,
                `- Application local server: http://127.0.0.1:8080`,
                `- CDP endpoint: ${cdpEndpoint}`,
                `Use sandbox_browser to inspect the running deliverable.`,
              ].join("\n"),
            },
          ],
          details: { task },
        }
      },
    })

    // Tool: sandbox_browser
    pi.registerTool({
      name: "sandbox_browser",
      label: "Sandbox Browser Use with AX Label Overlay",
      description:
        "Drives Chromium in the Bot's review sandbox over CDP. Every step automatically paints [ref=eN] bounding-box labels on interactive elements, captures a PNG screenshot, and returns both the AX text tree and the visual screenshot image to the model context.",
      parameters: z?.object({
        taskId: z.string().describe("Task id currently in REVIEWING state"),
        op: z
          .enum(["observe", "navigate", "click", "type", "press"])
          .describe("Action to perform; every action ends with a fresh annotated screenshot"),
        url: z.string().optional().describe("Target URL when op is navigate"),
        ref: z.string().optional().describe("Element ref such as e3 when op is click or type"),
        text: z.string().optional().describe("Text to type when op is type"),
        submit: z.boolean().optional().describe("Submit the form after typing"),
        key: z.string().optional().describe("Key name such as Enter when op is press"),
      }),
      execute: async (_id, params: any) => {
        const d = await getDaemon()
        const taskId = String(params?.taskId ?? "")
        const op = String(params?.op ?? "observe")

        let action: any
        if (op === "navigate") {
          action = { op: "navigate", url: String(params.url) }
        } else if (op === "click") {
          action = { op: "click", ref: String(params.ref) }
        } else if (op === "type") {
          action = {
            op: "type",
            ref: String(params.ref),
            text: String(params.text),
            submit: Boolean(params.submit),
          }
        } else if (op === "press") {
          action = { op: "press", key: String(params.key) }
        } else {
          action = { op: "observe" }
        }

        const observation = await d.bdfl.browserUse(taskId, action)

        return {
          content: [
            {
              type: "text",
              text: [
                `Sandbox Browser Observation [${action.op}]:`,
                `Page: "${observation.title}" (${observation.url})`,
                `Interactive / Semantic Elements (${observation.nodes.length}):`,
                observation.axText,
                ``,
                `Screenshot saved to: ${observation.screenshotPath}`,
              ].join("\n"),
            },
            {
              type: "image",
              data: observation.screenshotBase64,
              mimeType: "image/png",
            },
          ],
          details: {
            url: observation.url,
            title: observation.title,
            nodeCount: observation.nodes.length,
            screenshotPath: observation.screenshotPath,
          },
        }
      },
    })

    // Tool: bdfl_accept
    pi.registerTool({
      name: "bdfl_accept",
      label: "Accept Verified Deliverable",
      description:
        "Verifies that the task was inspected in the live review sandbox, accepts the deliverable, optionally exports files to exportDir, and safely destroys the temporary sandbox containers.",
      parameters: z?.object({
        taskId: z.string().describe("Task id currently in REVIEWING state"),
        exportDir: z
          .string()
          .optional()
          .describe("Host directory the verified files are written into"),
      }),
      execute: async (_id, params: any) => {
        const d = await getDaemon()
        const taskId = String(params?.taskId ?? "")
        const exportDir = params?.exportDir ? String(params.exportDir) : undefined
        const task = await d.bdfl.accept(taskId, exportDir)

        return {
          content: [
            {
              type: "text",
              text: [
                `Task [${task.id}] ACCEPTED by BDFL.`,
                `Observations completed: ${task.reviewObservations}`,
                exportDir ? `Files exported to: ${exportDir}` : `Files retained in bundle store`,
                `Temporary sandboxes destroyed.`,
              ].join("\n"),
            },
          ],
          details: { task },
        }
      },
    })

    // Tool: bdfl_status
    pi.registerTool({
      name: "bdfl_status",
      label: "Check BDFL Tasks and Onlyne Leases",
      description:
        "Returns the current status of all tasks, active Onlyne compute sandbox leases, and audited Onlyne messages.",
      parameters: z?.object({}),
      execute: async () => {
        const d = await getDaemon()
        const tasks = d.bdfl.status()
        const leases = await d.bdfl.leases()
        const ledger = await d.bdfl.ledgerEntries()

        const taskLines = tasks.map(
          (t) =>
            `- [${t.id}] ${t.title} (state: ${t.state}, worker: ${t.workerId}, observations: ${t.reviewObservations})`,
        )
        const leaseLines = leases
          .filter((l) => l.state !== "destroyed")
          .map((l) => `- [${l.lease_id.slice(0, 12)}] ${l.name} (${l.state})`)

        return {
          content: [
            {
              type: "text",
              text: [
                `=== BDFL Tasks (${tasks.length}) ===`,
                ...(taskLines.length > 0 ? taskLines : ["(no tasks)"]),
                ``,
                `=== Active Onlyne Compute Leases (${leaseLines.length}) ===`,
                ...(leaseLines.length > 0 ? leaseLines : ["(no active leases)"]),
                ``,
                `Onlyne Ledger Messages: ${ledger.length} audited entries`,
              ].join("\n"),
            },
          ],
          details: { tasks, leases, ledgerCount: ledger.length },
        }
      },
    })
  }

  // 5. Palette Command: /bot
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("bot", {
      description: "Show Tern-Bot BDFL board, active sandboxes, and short-context token meter",
      handler: async (_args: string, ctx?: ExtensionCommandCtx) => {
        const d = await getDaemon()
        const tasks = d.bdfl.status()
        const assembly = d.harness.assemblePrompt()
        ctx?.ui?.notify?.(
          `[${d.botId}] Context: ${assembly.totalTokens}/8192 tok · Tasks: ${tasks.length}`,
          "info",
        )
        return { tasks, assembly }
      },
    })
  }
}
