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
  throw new Error("not implemented")
}

/** One worker row, clickable to open its sandbox desktop in a Tern browser pane. */
export function describeWorker(worker: WorkerRow): NativeNode {
  throw new Error("not implemented")
}

/** Context-window meter: the three segments as stacked parts of one track. */
export function describeWindowMeter(parts: {
  prefix: number
  infix: number
  suffix: number
  total: number
}): NativeNode {
  throw new Error("not implemented")
}
