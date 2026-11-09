/**
 * Registers the extension against a fake OMP API and reads the live board
 * status, so the tool surface and the status endpoint are verified without a
 * full interactive session.
 *
 *   bun run packages/bot-daemon/test/tools.ts
 */

import ternBotExtension from "../src/extension.ts"

interface RegisteredTool {
  name: string
  description: string
  hasParameters: boolean
}

const tools: RegisteredTool[] = []
const commands: string[] = []
const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>()

const fakeZod = {
  object: (shape: Record<string, unknown>) => ({ kind: "object", shape }),
  string: () => {
    const chain = {
      describe: (d: string) => ({ kind: "string", description: d }),
      optional: () => {
        const inner = {
          describe: (d: string) => ({ kind: "string?", description: d }),
          optional: () => inner,
        }
        return inner
      },
    }
    return chain
  },
  boolean: () => {
    const chain = {
      describe: (d: string) => ({ kind: "boolean", description: d }),
      optional: () => {
        const inner = {
          describe: (d: string) => ({ kind: "boolean?", description: d }),
          optional: () => inner,
        }
        return inner
      },
    }
    return chain
  },
  enum: (values: string[]) => {
    const chain = {
      describe: (d: string) => ({ kind: "enum", values, description: d }),
      optional: () => {
        const inner = {
          describe: (d: string) => ({ kind: "enum?", values, description: d }),
          optional: () => inner,
        }
        return inner
      },
    }
    return chain
  },
}

const pi = {
  zod: fakeZod,
  on(event: string, handler: (e: unknown, ctx?: unknown) => unknown) {
    handlers.set(event, handler)
  },
  registerTool(spec: { name: string; description: string; parameters?: unknown }) {
    tools.push({
      name: spec.name,
      description: spec.description,
      hasParameters: spec.parameters !== undefined,
    })
  },
  registerCommand(name: string) {
    commands.push(name)
  },
}

ternBotExtension(pi as never)

console.log("Registered tools:")
for (const tool of tools) {
  console.log(`  · ${tool.name}  params=${tool.hasParameters}`)
}
console.log(`Registered commands: ${commands.join(", ") || "(none)"}`)
console.log(`Event hooks: ${[...handlers.keys()].join(", ")}`)

const expected = ["bdfl_dispatch", "bdfl_review", "sandbox_browser", "bdfl_accept", "bdfl_status"]
const missing = expected.filter((name) => !tools.some((t) => t.name === name))
if (missing.length > 0) {
  console.error(`Missing tools: ${missing.join(", ")}`)
  process.exit(1)
}
const noParams = tools.filter((t) => !t.hasParameters && t.name !== "bdfl_status")
if (noParams.length > 0) {
  console.error(`Tools without parameters: ${noParams.map((t) => t.name).join(", ")}`)
  process.exit(1)
}

// A real session start must bring the status server up by itself.
await handlers.get("session_start")?.(undefined)

const res = await fetch("http://127.0.0.1:18412/status")
const body = (await res.json()) as { bots: unknown[] }
console.log(`\n/status -> ${res.status}, bots=${body.bots.length}`)
console.log(JSON.stringify(body, null, 2).slice(0, 600))

if (body.bots.length === 0) {
  console.error("board reported no bots")
  process.exit(1)
}

console.log("\nTOOL SURFACE VERIFIED")
process.exit(0)
