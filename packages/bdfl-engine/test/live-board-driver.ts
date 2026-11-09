/**
 * Live Board Driver — Drives the live bot daemon so the Tern companion
 * board updates in real time through the full lifecycle:
 *
 *   1. Dispatch task  -> Board shows worker-1 WORKING + 1 lease RUNNING
 *   2. Worker submits -> Board shows worker-1 SUBMITTED (needs review badge)
 *   3. Open review    -> Board shows worker-1 REVIEWING + 2 leases RUNNING
 *   4. Browser Use    -> Real Chromium navigation + AX [ref=eN] screenshot
 *   5. Accept task    -> Board shows task ACCEPTED, temporary sandboxes cleaned up
 */

import { BdflEngine } from "../src/index.ts"
import { join } from "node:path"

const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Worker Release v1.0</title></head>
<body style="font-family: -apple-system, system-ui; padding: 40px; background: #0f141c; color: #f0f6fc">
  <h1 style="color: #58a6ff">Personal Bot Showcase</h1>
  <p id="desc" style="color: #8b949e">Worker sandbox executed autonomously inside isolated Debian VM.</p>
  <div style="margin-top: 24px">
    <button id="btn-verify" style="padding: 10px 20px; background: #238636; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer" onclick="document.getElementById('desc').textContent='Verification Passed: Ready for Production Merge!'; document.getElementById('desc').style.color='#3fb950'">Verify Component</button>
  </div>
</body></html>`

async function main() {
  console.log("=== Starting Live Board Demonstration ===")
  const engine = new BdflEngine({
    botId: "bot-1",
    storageDir: join(process.cwd(), ".tern-bot"),
  })

  try {
    // 1. Dispatch
    console.log("\n[1/5] Dispatching task to isolated worker sandbox...")
    const task = await engine.dispatch(
      "Deploy Status Showcase",
      "Implement the showcase landing page with verification button",
      {
        files: [{ path: "index.html", content: PAGE_HTML }],
      },
    )
    console.log(`  -> Task ${task.id} WORKING in container ${task.workerLease?.allocated?.container_id?.slice(0, 12)}`)
    await delay(3500)

    // 2. Submit deliverable
    console.log("\n[2/5] Worker submitting ArtifactBundle deliverable...")
    await engine.submitArtifact(task.id, {
      summary: "Showcase landing page bundle with interactive verification script",
      files: [{ path: "index.html", content: PAGE_HTML }],
    })
    console.log(`  -> Task ${task.id} SUBMITTED`)
    await delay(3500)

    // 3. Start Review
    console.log("\n[3/5] Bot provisioning dedicated Review sandbox and serving on :8080...")
    const reviewTask = await engine.review(task.id)
    console.log(`  -> Review sandbox RUNNING (desktop: ${reviewTask.reviewLease?.connection?.portal_urls?.desktop})`)
    await delay(3500)

    // 4. Browser Use
    console.log("\n[4/5] Bot driving Chromium in review sandbox (AX tree + [ref=eN] visual boxes)...")
    const navObs = await engine.browserUse(task.id, {
      op: "navigate",
      url: "http://127.0.0.1:8080/index.html",
    })
    console.log(`  -> Navigated to ${navObs.url} (${navObs.nodes.length} AX nodes)`)
    console.log(`  -> Screenshot saved: ${navObs.screenshotPath}`)

    const btn = navObs.nodes.find((n) => n.name.includes("Verify") || n.role === "button")
    if (btn) {
      console.log(`  -> Clicking [ref=${btn.ref}] "${btn.name}"...`)
      const clickObs = await engine.browserUse(task.id, {
        op: "click",
        ref: btn.ref,
      })
      console.log(`  -> Click complete. Fresh screenshot: ${clickObs.screenshotPath}`)
    }
    await delay(3500)

    // 5. Accept
    console.log("\n[5/5] Bot accepting deliverable and exporting to example/dist/...")
    const exportDir = join(process.cwd(), "example", "dist")
    const accepted = await engine.accept(task.id, exportDir)
    console.log(`  -> Task ${accepted.id} ACCEPTED (${accepted.reviewObservations} observations)`)
    console.log(`  -> Files exported to ${exportDir}`)
    console.log(`  -> Cleaned up all sandbox containers`)

    console.log("\n=== Live Board Demonstration Complete ===")
  } finally {
    await engine.destroyAll().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error("Live demonstration failed:", err)
  process.exit(1)
})
