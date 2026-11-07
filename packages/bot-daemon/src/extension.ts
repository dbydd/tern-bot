/**
 * OMP Extension entrypoint loaded by `bin/omp-bot` (`--extension=...`).
 *
 * Wires the three loose component packages into any OMP session started via `omp-bot`:
 *   1. `@tern-bot/tavern-harness` -> `before_agent_start` (stable prefix),
 *      `session.compacting` (frozen infix in `preserveData`), and `context` (Author's Note at depth D).
 *   2. `@tern-bot/sandbox-broker` + `@tern-bot/bdfl-engine` -> `bdfl_dispatch`, `bdfl_review`,
 *      `bdfl_merge`, `bdfl_reject`, and `bdfl_status` tools.
 *   3. `@tern-bot/tern-plugin` -> TSP `NativeNode` status and board descriptors.
 */

import { describeBotBoard, describeWindowMeter } from "@tern-bot/tern-plugin"
import { startBotDaemon, type BotDaemon } from "./index.ts"

export interface BeforeAgentStartLikeEvent {
  prompt?: string
  systemPrompt?: string[]
}

export interface ContextLikeMessage {
  role: string
  content: unknown
  synthetic?: boolean
  timestamp?: number
}

export interface ContextLikeEvent {
  messages?: ContextLikeMessage[]
}

export interface ExtensionCommandUI {
  notify?(message: string, level?: "info" | "warning" | "error"): void
}

export interface ExtensionCommandCtx {
  ui?: ExtensionCommandUI
}

export interface ExtensionLikeAPI {
  on(event: string, handler: (event: Record<string, unknown>, ctx?: ExtensionCommandCtx) => unknown): void
  registerCommand?(
    name: string,
    spec: {
      description: string
      handler: (args: string, ctx?: ExtensionCommandCtx) => Promise<unknown>
    },
  ): void
}

export default function ternBotExtension(pi: ExtensionLikeAPI): void {
  let daemonPromise: Promise<BotDaemon> | null = null

  const getDaemon = (): Promise<BotDaemon> => {
    if (!daemonPromise) {
      const botId = process.env.TERN_BOT_ID ?? "bot-1"
      const worktree = process.cwd()
      daemonPromise = startBotDaemon({ botId, worktree }).then((d) => {
        d.harness.registerLoreEntry({
          id: "bdfl-merge-gate",
          keys: ["merge", "pr", "review", "sandbox"],
          content:
            "Invariant inv_no_unverified_merge: PR branches must pass verification inside a RUNNING review sandbox before merge.",
          cooldownTurns: 2,
        })
        return d
      })
    }
    return daemonPromise
  }

  // 1. Stable Prefix: appended once per turn preparation via before_agent_start (preserves Prefix Cache)
  pi.on("before_agent_start", async (event: BeforeAgentStartLikeEvent) => {
    const d = await getDaemon()
    if (typeof event.prompt === "string" && event.prompt.trim().length > 0) {
      d.harness.ingestMessage(event.prompt)
    }
    const activePrs = d.bdfl.status()
    d.harness.setAuthorNote(
      `<current-env>bot=${d.botId} active_prs=${activePrs.length} pending_review=${activePrs.filter((p) => p.state === "PR_SUBMITTED" || p.state === "REVIEW").length}</current-env>`,
      2,
    )
    const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : []
    return {
      systemPrompt: [...base, d.harness.formatForSystemPrompt().join("\n")],
    }
  })

  // 2. Frozen Infix: persisted into CompactionEntry.preserveData during compaction
  pi.on("session.compacting", async () => {
    const d = await getDaemon()
    const payload = d.harness.buildCompactionPayload()
    return {
      context: [payload.summary],
      preserveData: payload.preserveData,
    }
  })

  // 3. Rolling Suffix & Depth-D Author's Note: only the tail note is injected per call
  pi.on("context", async (event: ContextLikeEvent) => {
    const d = await getDaemon()
    d.harness.assemblePrompt()
    if (!Array.isArray(event.messages) || event.messages.length === 0) return undefined
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

  // 4. Register `/bot` status command if host supports commands
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("bot", {
      description: "Show Tern-Bot BDFL board, active sandboxes, and short-context token meter",
      handler: async (_args: string, ctx?: ExtensionCommandCtx) => {
        const d = await getDaemon()
        const prs = d.bdfl.status()
        const assembly = d.harness.assemblePrompt()
        const meterNode = describeWindowMeter({
          prefix: assembly.prefixTokens,
          infix: assembly.infixTokens,
          suffix: assembly.suffixTokens + assembly.authorNoteTokens,
          total: 8192,
        })
        const boardNode = describeBotBoard([
          {
            botId: d.botId,
            state: prs.some((p) => p.state === "PR_SUBMITTED")
              ? "waiting"
              : prs.some((p) => p.state === "WORKING" || p.state === "REVIEW")
                ? "working"
                : "idle",
            workers: prs.map((p) => ({
              workerId: p.workerId,
              branch: p.branch,
              state: p.state,
              elapsedSecs: 60,
              needsReview: p.state === "PR_SUBMITTED" || p.state === "REVIEW",
            })),
            leases: [],
          },
        ])
        ctx?.ui?.notify?.(
          `[${d.botId}] Context: ${assembly.totalTokens}/8192 tok · PRs: ${prs.length}`,
          "info",
        )
        return { meterNode, boardNode }
      },
    })
  }
}
