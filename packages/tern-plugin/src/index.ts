/**
 * The board as OMP describes it to Tern over TSP.
 *
 * Rendering belongs to the terminal: this module only turns the broker's view
 * into NativeNodes, so the same tree lands in a Tern pane and in OMP's own
 * status surface. window.luau owns the pane, the layout and the link routes.
 */

import type { NativeNode } from "@oh-my-pi/pi-tui/native/node"

export interface BotBoardRow {
  botId: string
  state: "idle" | "working" | "waiting"
  workers: readonly WorkerRow[]
  leases: readonly LeaseRow[]
}

export interface WorkerRow {
  workerId: string
  branch: string
  state: string
  elapsedSecs: number
  needsReview: boolean
}

export interface LeaseRow {
  leaseId: string
  kind: "main" | "worker"
  state: string
  ttlRemainingSecs: number
}

/** The whole board, one card per bot. */
export function describeBotBoard(rows: readonly BotBoardRow[]): NativeNode {
  return {
    k: "col",
    p: { gap: "sm" },
    c: rows.map((row) => ({
      k: "card" as const,
      key: `bot-${row.botId}`,
      p: {
        head: row.botId,
        tone: row.state === "waiting" ? "warning" : row.state === "working" ? "accent" : "neutral",
      },
      c: [
        {
          k: "row" as const,
          p: { gap: "sm" },
          c: [
            {
              k: "badge" as const,
              p: {
                text: row.state.toUpperCase(),
                tone: row.state === "waiting" ? "warning" : row.state === "working" ? "info" : "muted",
              },
            },
            {
              k: "text" as const,
              p: { text: `${row.workers.length} workers · ${row.leases.length} leases`, tone: "muted" },
            },
          ],
        },
        ...row.workers.map((w) => describeWorker(w)),
      ],
    })),
  }
}

/** One worker row, clickable to open its sandbox desktop in a Tern browser pane. */
export function describeWorker(worker: WorkerRow): NativeNode {
  const mins = Math.max(0, Math.floor(worker.elapsedSecs / 60))
  return {
    k: "row",
    key: `worker-${worker.workerId}`,
    p: { gap: "sm" },
    c: [
      {
        k: "badge",
        p: {
          text: worker.needsReview ? `${worker.state} ★` : worker.state,
          tone: worker.needsReview ? "warning" : "info",
        },
      },
      {
        k: "text",
        p: { text: `${worker.workerId} (${worker.branch}) · ${mins}m` },
      },
      {
        k: "button",
        key: `spectate-${worker.workerId}`,
        p: { text: worker.needsReview ? "Review" : "Spectate", size: "sm" },
      },
    ],
  }
}

/** Context-window meter: the three segments as stacked parts of one track. */
export function describeWindowMeter(parts: {
  prefix: number
  infix: number
  suffix: number
  total: number
}): NativeNode {
  const used = parts.prefix + parts.infix + parts.suffix
  const denom = parts.total > 0 ? parts.total : 1
  const ratio = Math.min(1, used / denom)
  return {
    k: "col",
    p: { gap: "xs" },
    c: [
      {
        k: "meter",
        p: {
          value: ratio,
          parts: [
            { value: Math.min(1, parts.prefix / denom), label: "prefix" },
            { value: Math.min(1, parts.infix / denom), label: "infix" },
            { value: Math.min(1, parts.suffix / denom), label: "suffix" },
          ],
          thresholds: { warn: 0.75, bad: 0.9 },
          label: `Context ${used} / ${parts.total} tok`,
          tone: ratio > 0.85 ? "warning" : "success",
        },
      },
      {
        k: "text",
        p: {
          text: `prefix ${parts.prefix} · infix ${parts.infix} · suffix ${parts.suffix}`,
          tone: "muted",
        },
      },
    ],
  }
}
