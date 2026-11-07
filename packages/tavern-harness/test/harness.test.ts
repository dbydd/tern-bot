import { describe, expect, test } from "bun:test"
import { TavernHarness } from "../src/index.ts"

describe("TavernHarness short-context & prefix-cache invariants", () => {
  test("30-turn rolling conversation stays strictly <= 8192 tokens and compacts into infix", () => {
    const harness = new TavernHarness({
      maxWindowTurns: 6,
      loreBudgetTokens: 400,
    })

    harness.registerLoreEntry({
      id: "orbstack-guide",
      keys: ["orbstack", "novnc"],
      content:
        "OrbStack VMs run Ubuntu 24.04 with Xvfb + x11vnc + websockify on port 6080 and shared SSH on port 32222.",
      cooldownTurns: 2,
    })

    harness.setAuthorNote("[Active Sandbox: ready, job: review_pr_14]", 2)

    for (let i = 1; i <= 30; i++) {
      const keyword = i % 5 === 0 ? "orbstack novnc check" : "routine status update"
      harness.ingestMessage(
        `Turn ${i} (${keyword}): Operator message with payload ${"x".repeat(280)}`,
      )
      const assembly = harness.assemblePrompt()
      expect(assembly.totalTokens).toBeLessThanOrEqual(8192)
      expect(assembly.prefixTokens).toBeGreaterThan(0)
      expect(assembly.suffixTokens).toBeGreaterThan(0)
    }

    expect(harness.getHistory().length).toBeLessThanOrEqual(6)
    expect(harness.getInfixSummary().length).toBeGreaterThan(0)

    const compaction = harness.buildCompactionPayload()
    expect(compaction.summary.length).toBeGreaterThan(0)
    expect(compaction.preserveData.turnCounter).toBe(30)
    expect(compaction.hindsightRetain.intent).toContain("retain compacted session state")
  })

  test("Lorebook matches keywords, enforces cooldown, and stays silent when unmatched", () => {
    const harness = new TavernHarness()
    harness.registerLoreEntry({
      id: "pr-gate",
      keys: ["merge", "pull request"],
      content: "Never merge without a RUNNING review sandbox lease.",
      cooldownTurns: 3,
    })

    harness.ingestMessage("hello world")
    expect(harness.matchLorebook("unrelated chat topic")).toEqual([])

    const firstHit = harness.matchLorebook("please merge this pull request")
    expect(firstHit.length).toBe(1)
    expect(firstHit[0]?.entryId).toBe("pr-gate")

    // Immediately on the same turn (within cooldown window), should not re-trigger
    const cooledHit = harness.matchLorebook("please merge this pull request")
    expect(cooledHit.length).toBe(0)
  })

  test("Author's Note injects at configured depth from the end of the rolling window", () => {
    const harness = new TavernHarness({ maxWindowTurns: 6 })
    harness.setAuthorNote("URGENT: check sandbox TTL", 2)

    harness.ingestMessage("msg-1")
    harness.ingestMessage("msg-2")
    harness.ingestMessage("msg-3")
    harness.ingestMessage("msg-4")

    const windowMsgs = harness.assembleWindowMessages()
    // 4 history messages + 1 injected author note at index (4 - 2 = 2)
    expect(windowMsgs.length).toBe(5)
    expect(windowMsgs[2]?.perCallInjected).toBe(true)
    expect(windowMsgs[2]?.content).toContain("URGENT: check sandbox TTL")
  })
})
