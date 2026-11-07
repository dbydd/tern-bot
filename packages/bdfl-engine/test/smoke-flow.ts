import { startBotDaemon } from "../../bot-daemon/src/index.ts"
import { describeBotBoard, describeWindowMeter } from "../../tern-plugin/src/index.ts"

async function main(): Promise<void> {
  const daemon = await startBotDaemon({
    botId: "bot-alpha",
    worktree: process.cwd(),
  })

  try {
    // 1. Dispatch issue to worker
    const pr = await daemon.bdfl.dispatch(
      "issue-42",
      "fix/auth-bug",
      "Fix JWT token expiry check in middleware",
    )
    console.log("[smoke-flow] 1. Dispatched:", JSON.stringify(pr))

    // 2. Verify unverified merge is rejected (inv_no_unverified_merge)
    let blockedUnverified = false
    try {
      await daemon.bdfl.merge(pr.id)
    } catch {
      blockedUnverified = true
    }
    if (!blockedUnverified) {
      throw new Error("expected unverified merge to throw")
    }
    console.log("[smoke-flow] 2. Unverified merge blocked as required by inv_no_unverified_merge")

    // 3. Submit PR -> Start Review -> Reject (round 1 feedback)
    await daemon.bdfl.submitPr(pr.id)
    await daemon.bdfl.review(pr.id)
    await daemon.bdfl.reject(pr.id, "Add unit test for expired token")
    const afterReject = daemon.bdfl.status().find((r) => r.id === pr.id)
    if (afterReject?.state !== "WORKING" || !afterReject.everReviewed) {
      throw new Error(`unexpected state after reject: ${JSON.stringify(afterReject)}`)
    }
    console.log("[smoke-flow] 3. First review rejected -> returned to WORKING:", JSON.stringify(afterReject))

    // 4. Re-submit -> Review -> Expire review sandbox via tick -> Verify merge is blocked when sandbox STOPPED
    await daemon.bdfl.submitPr(pr.id)
    await daemon.bdfl.review(pr.id)
    await daemon.leases.tick(4000)
    let blockedExpiredSandbox = false
    try {
      await daemon.bdfl.merge(pr.id)
    } catch {
      blockedExpiredSandbox = true
    }
    if (!blockedExpiredSandbox) {
      throw new Error("expected merge on expired review sandbox to throw")
    }
    console.log("[smoke-flow] 4. Merge on expired STOPPED review sandbox blocked")

    // 5. Return to WORKING, submit & review in fresh RUNNING sandbox, then merge cleanly
    await daemon.bdfl.reject(pr.id, "Re-running verification in fresh sandbox")
    await daemon.bdfl.submitPr(pr.id)
    await daemon.bdfl.review(pr.id)
    await daemon.bdfl.merge(pr.id, "feat(auth): validate JWT exp claim (#42)")
    const finalRecord = daemon.bdfl.status().find((r) => r.id === pr.id)
    if (finalRecord?.state !== "MERGED") {
      throw new Error(`expected MERGED, got ${JSON.stringify(finalRecord)}`)
    }
    console.log("[smoke-flow] 5. Verified & merged cleanly:", JSON.stringify(finalRecord))

    // 6. Verify Tern TSP NativeNode descriptors
    daemon.harness.ingestMessage("Check status of PR #42 and orbstack sandbox")
    const assembly = daemon.harness.assemblePrompt()
    const meter = describeWindowMeter({
      prefix: assembly.prefixTokens,
      infix: assembly.infixTokens,
      suffix: assembly.suffixTokens + assembly.authorNoteTokens,
      total: 8192,
    })
    const board = describeBotBoard([
      {
        botId: daemon.botId,
        state: "idle",
        workers: [
          {
            workerId: finalRecord.workerId,
            branch: finalRecord.branch,
            state: finalRecord.state,
            elapsedSecs: 120,
            needsReview: false,
          },
        ],
        leases: [],
      },
    ])
    console.log("[smoke-flow] 6. TSP NativeNode meter & board:", JSON.stringify({ meterK: meter.k, boardK: board.k }))
  } finally {
    await daemon.stop()
  }
}

await main()
