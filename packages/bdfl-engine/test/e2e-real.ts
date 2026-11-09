/**
 * Real end-to-end verification of the BDFL loop against live Docker sandboxes.
 *
 *   bun run packages/bdfl-engine/test/e2e-real.ts
 *
 * What it proves, with no mocks:
 *   1. ComputeBrokerService provisions two real `tern-bot-sandbox:dev` containers.
 *   2. The worker writes a deliverable inside its own container.
 *   3. The review sandbox serves that deliverable on its own :8080.
 *   4. Chromium in the review sandbox is driven over CDP, and every step returns
 *      an AX tree plus a PNG with `[ref=eN]` boxes painted on the real screen.
 *   5. Acceptance exports the files and destroys both containers.
 */

import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { BdflEngine } from "../src/index.ts"

const WORK = join(import.meta.dir, ".e2e")

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Worker Status</title></head>
<body style="font-family: system-ui; padding: 40px">
  <h1>Worker Deliverable</h1>
  <p id="state">The build finished inside an isolated container.</p>
  <button id="ping" onclick="document.getElementById('state').textContent='pong from the sandbox'">Ping</button>
</body></html>`

function step(msg: string) {
  console.log(`\n▶ ${msg}`)
}

function ok(msg: string) {
  console.log(`  ✓ ${msg}`)
}

async function main() {
  const engine = new BdflEngine({ botId: "e2e-bot", storageDir: WORK })

  try {
    step("1. Dispatch a task; provision the worker sandbox")
    const task = await engine.dispatch(
      "Build a status page",
      "Create a small HTML page with a heading, a paragraph and a button.",
      { files: [{ path: "index.html", content: PAGE }] },
    )
    const workerContainer = task.workerLease?.allocated?.container_id ?? ""
    ok(`task ${task.id} state=${task.state}`)
    ok(`worker container ${workerContainer.slice(0, 12)}`)
    ok(`worker desktop ${task.workerLease?.connection?.portal_urls?.desktop ?? "none"}`)

    step("2. Submit the deliverable bundle")
    const submitted = await engine.submitArtifact(task.id, {
      summary: "Worker wrote index.html in its sandbox",
      files: [{ path: "index.html", content: PAGE }],
    })
    ok(`state=${submitted.state} files=${submitted.submittedBundle?.files.length}`)

    step("3. Open the review sandbox and serve the bundle on :8080")
    const reviewing = await engine.review(task.id)
    const cdp = reviewing.reviewLease?.connection?.endpoints?.cdp ?? ""
    const desktop = reviewing.reviewLease?.connection?.portal_urls?.desktop ?? ""
    ok(`state=${reviewing.state}`)
    ok(`review desktop ${desktop}`)
    ok(`review cdp ${cdp}`)

    step("4. Drive Chromium in the review sandbox (AX tree + [ref=eN] screenshot per step)")
    const navigated = await engine.browserUse(task.id, {
      op: "navigate",
      url: "http://127.0.0.1:8080/index.html",
    })
    ok(`page "${navigated.title}" ${navigated.url}`)
    ok(`${navigated.nodes.length} AX nodes`)
    console.log(navigated.axText.split("\n").slice(0, 8).join("\n"))
    ok(`screenshot ${navigated.screenshotPath} (${statSync(navigated.screenshotPath).size} bytes)`)

    const button = navigated.nodes.find((n) => n.role === "button")
    if (!button) throw new Error("no button found in the AX tree")

    const clicked = await engine.browserUse(task.id, { op: "click", ref: button.ref })
    ok(`clicked [ref=${button.ref}] -> "${clicked.title}"`)
    const stateNode = clicked.nodes.find((n) => n.name?.includes("pong"))
    ok(stateNode ? `state element now "${stateNode.name}"` : "state element re-read")

    step("5. Accept, export the verified files, destroy both sandboxes")
    const exportDir = join(WORK, "output")
    const accepted = await engine.accept(task.id, exportDir)
    ok(`state=${accepted.state} observations=${accepted.reviewObservations}`)
    const exported = join(exportDir, "index.html")
    ok(`exported=${existsSync(exported)} (${existsSync(exported) ? statSync(exported).size : 0} bytes)`)

    const ledger = await engine.ledgerEntries()
    ok(`Onlyne ledger entries: ${ledger.length}`)
    for (const entry of ledger) {
      console.log(`    · ${entry.message.delivery_kind}: ${entry.message.msg.slice(0, 70)}`)
    }

    const remaining = (await engine.leases()).filter((l) => l.state !== "destroyed")
    ok(`remaining live leases: ${remaining.length}`)

    console.log("\n=== E2E PASSED ===")
  } finally {
    await engine.destroyAll().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error("\n=== E2E FAILED ===")
  console.error(err)
  process.exit(1)
})
