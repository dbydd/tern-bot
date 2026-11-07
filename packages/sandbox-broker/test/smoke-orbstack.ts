import { LeaseManager, MockDriver, OrbstackDriver } from "../src/index.ts"

async function main(): Promise<void> {
  const hasOrbctl = Bun.which("orbctl") !== null
  console.log(`[smoke-orbstack] orbctl available: ${hasOrbctl}`)

  // 1. Deterministic LeaseManager + TTL safety verification
  const mock = new MockDriver()
  const mockLeases = new LeaseManager(mock)
  const l1 = await mockLeases.acquire({
    botId: "bot-smoke",
    kind: "main",
    ttlSecs: 60,
    spec: { name: "tern-bot-mock-vm" },
  })
  if (l1.leaseState !== "RUNNING") {
    throw new Error(`expected RUNNING lease, got ${l1.leaseState}`)
  }
  const viewBefore = await mockLeases.describe(l1.id)
  console.log("[smoke-orbstack] active resource view:", JSON.stringify(viewBefore))

  await mockLeases.tick(65)
  const viewAfter = await mockLeases.describe(l1.id)
  if (!viewAfter || viewAfter.state !== "STOPPED" || viewAfter.ports !== null) {
    throw new Error(`expected expired STOPPED lease with null ports, got ${JSON.stringify(viewAfter)}`)
  }
  console.log("[smoke-orbstack] TTL expiration & reclaim verified:", JSON.stringify(viewAfter))

  // 2. Real OrbStack VM smoke test when orbctl is installed
  if (hasOrbctl && process.env.SKIP_REAL_ORBSTACK !== "1") {
    const vmName = `tern-bot-smoke-${Date.now().toString(36)}`
    const driver = new OrbstackDriver()
    const leases = new LeaseManager(driver)
    console.log(`[smoke-orbstack] creating real OrbStack VM '${vmName}' via LeaseManager...`)
    const lease = await leases.acquire({
      botId: "bot-smoke",
      kind: "main",
      ttlSecs: 120,
      spec: { name: vmName, image: "ubuntu:24.04" },
    })
    try {
      const execRes = await driver.exec(vmName, ["sh", "-c", "uname -s -m"])
      const stream = await leases.describe(lease.id)
      console.log(
        `[smoke-orbstack] VM exec: "${execRes.stdout.trim()}" (exit ${execRes.exitCode})`,
      )
      console.log(`[smoke-orbstack] stream descriptor:`, JSON.stringify(stream))
    } finally {
      await leases.tick(180)
      const after = await leases.query(lease.id)
      console.log(`[smoke-orbstack] VM reclaimed via TTL tick, final state: ${after?.leaseState}`)
    }
  }
}

await main()
