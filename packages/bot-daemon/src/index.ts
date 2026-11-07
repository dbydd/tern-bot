/**
 * The aggregate runtime: one OMP session (bot), one Onlyne inbox, one lease
 * book over the shared sandbox-broker.
 *
 * TODO: start, in order:
 *   1. the Onlyne companion (omp-onlyne already ships one; connect, do not reimplement)
 *   2. this bot's TavernHarness on the OMP session hooks (before_agent_start /
 *      session.compacting / context)
 *   3. BdflEngine over the shared LeaseManager, exposing the `bdfl_*` tools
 *   4. `bdfl_status` as a TSP surface for the Tern board
 * Every bot on the machine shares the broker daemon but holds its own Onlyne
 * identity and its own git worktree (REQ-12).
 */

import { BdflEngine } from "@tern-bot/bdfl-engine"
import { LeaseManager, MockDriver, type SandboxDriver } from "@tern-bot/sandbox-broker"
import { TavernHarness, type WindowBudget } from "@tern-bot/tavern-harness"

export interface BotDaemonOptions {
  botId: string
  /** git worktree this bot owns; never shared with another bot. */
  worktree: string
  driver?: SandboxDriver
  budget?: WindowBudget
  tickIntervalMs?: number
}

export interface BotDaemon {
  readonly botId: string
  readonly leases: LeaseManager
  readonly bdfl: BdflEngine
  readonly harness: TavernHarness
  stop(): Promise<void>
}

export async function startBotDaemon(options: BotDaemonOptions): Promise<BotDaemon> {
  if (!options.botId.trim()) throw new Error("botId is required")
  if (!options.worktree.trim()) throw new Error("worktree is required")

  const driver = options.driver ?? new MockDriver()
  const leases = new LeaseManager(driver)
  const harness = new TavernHarness(options.budget ? { budget: options.budget } : undefined)
  const bdfl = new BdflEngine({ leases, botId: options.botId })

  const intervalMs = options.tickIntervalMs ?? 0
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          void leases.tick(Math.max(1, Math.round(intervalMs / 1000)))
        }, intervalMs)
      : undefined

  return {
    botId: options.botId,
    leases,
    bdfl,
    harness,
    async stop(): Promise<void> {
      clearInterval(timer)
    },
  }
}
