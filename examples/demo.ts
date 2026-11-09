/**
 * examples/demo.ts
 *
 * End-to-end BDFL flow driver that writes live status to the HTTP server so
 * the Tern-Bot board panel updates in real time.
 *
 * Run:  bun run examples/demo.ts
 *
 * The script drives the full lifecycle automatically, pausing 6 s between
 * steps (long enough for the panel's 5 s poll to pick up each change):
 *
 *   Step 1 — Bot starts, daemon registers → panel shows 1 bot, IDLE
 *   Step 2 — dispatch("issue-1") → worker-1 WORKING, lease RUNNING
 *   Step 3 — submitPr("pr-1")   → worker-1 PR_SUBMITTED (waiting badge)
 *   Step 4 — startReview("pr-1") → worker-1 REVIEW, review lease RUNNING
 *   Step 5 — merge("pr-1")      → PR MERGED, both leases released
 *   Step 6 — dispatch("issue-2") → worker-2 WORKING (second task)
 *   Step 7 — feedback("pr-2")   → worker-2 back to FEEDBACK
 *   Step 8 — stop              → all leases released, board empty
 */

import { startBotDaemon } from "../packages/bot-daemon/src/index.ts"

const STEP_MS = 6500 // slightly longer than the 5 s panel poll

const GREEN = "\x1b[32m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"
const RESET = "\x1b[0m"

function banner(step: number, total: number, msg: string) {
  console.log(`\n${CYAN}[${step}/${total}]${RESET} ${msg}`)
}

function ok(msg: string) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

async function main() {
  const total = 8

  console.log(`\n${YELLOW}═══ Tern-Bot BDFL Demo ════════════════════════════════${RESET}`)
  console.log(`  Watch the right-side board panel update every ~5 s.\n`)

  // Step 1: start daemon
  banner(1, total, "Starting bot-daemon (MockDriver) …")
  const daemon = await startBotDaemon({
    botId: "demo-bot",
    worktree: process.cwd(),
    tickIntervalMs: 2000,
  })
  ok(`daemon started  bot=${daemon.botId}  HTTP → 127.0.0.1:18412`)
  ok("Panel should show: 1 bot · IDLE")
  await wait(STEP_MS)

  // Step 2: dispatch first task
  banner(2, total, "Dispatching task → issue-1 (add dark-mode feature) …")
  const pr1 = await daemon.bdfl.dispatch("issue-1", "feat/dark-mode", "Implement dark mode toggle")
  ok(`PR record: id=${pr1.id}  workerId=${pr1.workerId}  state=${pr1.state}`)
  ok("Panel should show: worker-1 WORKING, 1 lease RUNNING")
  await wait(STEP_MS)

  // Step 3: submit PR
  banner(3, total, "Worker submits PR …")
  const submitted = await daemon.bdfl.submitPr(pr1.id)
  ok(`state → ${submitted.state}`)
  ok("Panel should show: worker-1 PR_SUBMITTED (warning badge) + [Review] button")
  await wait(STEP_MS)

  // Step 4: start review in sandbox
  banner(4, total, "Bot opens review sandbox …")
  await daemon.bdfl.review(pr1.id)
  const afterReview = daemon.bdfl.status().find((p) => p.id === pr1.id)!
  ok(`state → ${afterReview.state}  reviewLeaseId=${afterReview.reviewLeaseId}`)
  ok("Panel should show: worker-1 REVIEW, 2 leases RUNNING")
  await wait(STEP_MS)

  // Step 5: merge
  banner(5, total, "Merging PR after successful sandbox review …")
  await daemon.bdfl.merge(pr1.id, "feat(ui): add dark mode toggle (#1)")
  const afterMerge = daemon.bdfl.status().find((p) => p.id === pr1.id)!
  ok(`state → ${afterMerge.state}`)
  ok("Panel should show: worker-1 MERGED, leases released → 0 leases")
  await wait(STEP_MS)

  // Step 6: second task
  banner(6, total, "Dispatching second task → issue-2 (fix login bug) …")
  const pr2 = await daemon.bdfl.dispatch("issue-2", "fix/login-crash", "Fix crash on empty password")
  ok(`PR record: id=${pr2.id}  workerId=${pr2.workerId}  state=${pr2.state}`)
  ok("Panel should show: worker-2 WORKING")
  await wait(STEP_MS)

  // Step 7: feedback loop
  banner(7, total, "Bot sends feedback back to worker …")
  await daemon.bdfl.submitPr(pr2.id)
  await daemon.bdfl.review(pr2.id)
  await daemon.bdfl.reject(pr2.id, "Tests are missing for the empty-password path")
  const afterFeedback = daemon.bdfl.status().find((p) => p.id === pr2.id)!
  ok(`state → ${afterFeedback.state}  lastFeedback="${afterFeedback.lastFeedback}"`)
  ok("Panel should show: worker-2 FEEDBACK")
  await wait(STEP_MS)

  // Step 8: stop
  banner(8, total, "Stopping daemon …")
  await daemon.stop()
  ok("Daemon stopped, HTTP server closed.")
  ok("Panel should revert to: No Bots / No bot-daemon reporting.")

  console.log(`\n${YELLOW}═══ Demo complete ══════════════════════════════════════${RESET}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
