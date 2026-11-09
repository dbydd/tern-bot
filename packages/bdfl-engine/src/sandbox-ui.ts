/**
 * Sandbox Browser / Computer Use runtime with Accessibility (AX) tree
 * extraction and visual `[ref=eN]` bounding-box annotation.
 *
 * Every action (`navigate`, `click`, `type`, `press`, `observe`) against the
 * Bot's sandbox VM automatically:
 *   1. Walks the live DOM / accessibility semantics to assign `[ref=e1..eN]`
 *      handles to interactive and landmark elements.
 *   2. Paints a transient `[ref=eN]` visual overlay onto the viewport.
 *   3. Captures a PNG screenshot of the annotated screen via Chromium CDP.
 *   4. Removes the overlay so the page stays clean.
 *   5. Returns both the formatted AX text tree and the annotated PNG image
 *      (base64 + saved file path) so the OMP model sees the exact screen state
 *      after every single step.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface AxNodeSummary {
  ref: string
  role: string
  name: string
  value?: string
  bounds: { x: number; y: number; width: number; height: number }
}

export interface SandboxObservation {
  url: string
  title: string
  axText: string
  nodes: AxNodeSummary[]
  screenshotPath: string
  screenshotBase64: string
}

export type SandboxBrowserAction =
  | { op: "navigate"; url: string }
  | { op: "observe" }
  | { op: "click"; ref: string }
  | { op: "type"; ref: string; text: string; submit?: boolean }
  | { op: "press"; key: string }

interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

/**
 * Minimal Promise-based CDP client over Bun's native WebSocket.
 */
class CdpSession {
  readonly #ws: WebSocket
  #seq = 0
  readonly #pending = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >()

  private constructor(ws: WebSocket) {
    this.#ws = ws
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number
          result?: unknown
          error?: { message?: string }
        }
        if (typeof msg.id === "number") {
          const waiter = this.#pending.get(msg.id)
          if (waiter) {
            this.#pending.delete(msg.id)
            if (msg.error) {
              waiter.reject(new Error(msg.error.message ?? "CDP error"))
            } else {
              waiter.resolve(msg.result)
            }
          }
        }
      } catch {
        // ignore malformed event frames
      }
    })
  }

  static async connect(cdpHttpEndpoint: string): Promise<CdpSession> {
    const deadline = Date.now() + 15_000
    let wsUrl: string | undefined

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${cdpHttpEndpoint}/json/list`, {
          headers: { Host: "127.0.0.1:9222" },
        })
        if (res.ok) {
          const targets = (await res.json()) as CdpTarget[]
          const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
          if (page?.webSocketDebuggerUrl) {
            // Rewrite container-internal host:port to the mapped host endpoint
            const parsedEndpoint = new URL(cdpHttpEndpoint)
            const parsedWs = new URL(page.webSocketDebuggerUrl)
            parsedWs.hostname = parsedEndpoint.hostname
            parsedWs.port = parsedEndpoint.port
            wsUrl = parsedWs.toString()
            break
          }
        }
      } catch {
        // Chromium still booting
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 250)
      await promise
    }

    if (!wsUrl) {
      throw new Error(`No debuggable page target at ${cdpHttpEndpoint}`)
    }

    const ws = new WebSocket(wsUrl)
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error(`CDP WebSocket failed: ${wsUrl}`)), {
      once: true,
    })
    await promise

    return new CdpSession(ws)
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.#seq += 1
    const id = this.#seq
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    this.#pending.set(id, { resolve, reject })
    this.#ws.send(JSON.stringify({ id, method, params }))
    return (await promise) as T
  }

  close(): void {
    try {
      this.#ws.close()
    } catch {
      // ignore
    }
  }
}

/**
 * In-page script that extracts semantic/interactive nodes, assigns `[ref=eN]`,
 * and paints the visual annotation boxes onto the page before the screenshot.
 */
const ANNOTATE_AND_COLLECT_JS = `(() => {
  const existing = document.getElementById("__tern_bot_ax_overlay__");
  if (existing) existing.remove();

  const selector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[role='tab']",
    "[role='checkbox']",
    "[role='textbox']",
    "[onclick]",
    "h1",
    "h2",
    "h3",
    "[data-testid]",
    "[id]"
  ].join(",");

  const rawElements = Array.from(document.querySelectorAll(selector));
  const seen = new Set();
  const nodes = [];

  const overlay = document.createElement("div");
  overlay.id = "__tern_bot_ax_overlay__";
  overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;";
  document.documentElement.appendChild(overlay);

  let idx = 0;
  for (const el of rawElements) {
    if (seen.has(el)) continue;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) continue;

    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

    const tag = el.tagName.toLowerCase();
    const explicitRole = el.getAttribute("role");
    let role = explicitRole || tag;
    if (tag === "a") role = "link";
    else if (tag === "input") role = el.getAttribute("type") || "textbox";

    // Filter out generic container divs that only matched because of [id]
    const isInteractive = ["a", "button", "input", "select", "textarea"].includes(tag) || Boolean(explicitRole);
    const isHeading = ["h1", "h2", "h3"].includes(tag);
    const hasLeafText = el.children.length === 0 && (el.textContent || "").trim().length > 0;
    if (!isInteractive && !isHeading && !hasLeafText) continue;

    idx += 1;
    const ref = "e" + idx;
    el.setAttribute("data-tern-ref", ref);

    const ariaLabel = el.getAttribute("aria-label") || "";
    const placeholder = el.getAttribute("placeholder") || "";
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    const name = ariaLabel || text || placeholder || el.getAttribute("id") || tag;
    const value = "value" in el && typeof el.value === "string" && el.value.length > 0 ? el.value : undefined;

    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    nodes.push({ ref, role, name, value, bounds });

    // Paint bounding box + badge
    const box = document.createElement("div");
    const color = isInteractive ? "#ff3b30" : "#0a84ff";
    box.style.cssText = [
      "position:fixed",
      "left:" + bounds.x + "px",
      "top:" + bounds.y + "px",
      "width:" + bounds.width + "px",
      "height:" + bounds.height + "px",
      "border:2px solid " + color,
      "background:" + (isInteractive ? "rgba(255,59,48,0.08)" : "rgba(10,132,255,0.06)"),
      "box-sizing:border-box",
      "border-radius:4px",
      "pointer-events:none"
    ].join(";");

    const tagBadge = document.createElement("span");
    tagBadge.textContent = ref;
    tagBadge.style.cssText = [
      "position:absolute",
      "top:-18px",
      "left:-2px",
      "background:" + color,
      "color:#fff",
      "font:bold 11px/14px monospace",
      "padding:1px 5px",
      "border-radius:3px",
      "white-space:nowrap"
    ].join(";");
    if (bounds.y < 20) {
      tagBadge.style.top = "0px";
    }
    box.appendChild(tagBadge);
    overlay.appendChild(box);
  }

  return {
    url: location.href,
    title: document.title || "(untitled)",
    nodes
  };
})()`

const REMOVE_OVERLAY_JS = `(() => {
  const existing = document.getElementById("__tern_bot_ax_overlay__");
  if (existing) existing.remove();
})()`

export class SandboxBrowserController {
  readonly #cdpEndpoint: string
  readonly #screenshotDir: string
  #step = 0

  constructor(opts: { cdpEndpoint: string; screenshotDir: string }) {
    this.#cdpEndpoint = opts.cdpEndpoint
    this.#screenshotDir = opts.screenshotDir
    mkdirSync(this.#screenshotDir, { recursive: true })
  }

  async execute(action: SandboxBrowserAction): Promise<SandboxObservation> {
    const session = await CdpSession.connect(this.#cdpEndpoint)
    try {
      await session.send("Page.enable")
      await session.send("Runtime.enable")

      if (action.op === "navigate") {
        await session.send("Page.navigate", { url: action.url })
        await this.#settle(600)
      } else if (action.op === "click") {
        const clicked = await this.#evalJson<{ ok: boolean; reason?: string }>(
          session,
          `(() => {
            const el = document.querySelector('[data-tern-ref=${JSON.stringify(action.ref)}]');
            if (!el) return { ok: false, reason: "Element " + ${JSON.stringify(action.ref)} + " not found; run observe first" };
            el.scrollIntoView({ block: "center", inline: "center" });
            const rect = el.getBoundingClientRect();
            el.focus?.();
            el.click?.();
            return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`,
        )
        if (!clicked.ok) {
          throw new Error(clicked.reason ?? `Failed to click ${action.ref}`)
        }
        await this.#settle(350)
      } else if (action.op === "type") {
        const typed = await this.#evalJson<{ ok: boolean; reason?: string }>(
          session,
          `(() => {
            const el = document.querySelector('[data-tern-ref=${JSON.stringify(action.ref)}]');
            if (!el) return { ok: false, reason: "Element " + ${JSON.stringify(action.ref)} + " not found; run observe first" };
            el.focus?.();
            if ("value" in el) {
              el.value = ${JSON.stringify(action.text)};
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
              el.textContent = ${JSON.stringify(action.text)};
            }
            if (${Boolean(action.submit)} && el.form) {
              el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
            }
            return { ok: true };
          })()`,
        )
        if (!typed.ok) {
          throw new Error(typed.reason ?? `Failed to type into ${action.ref}`)
        }
        await this.#settle(350)
      } else if (action.op === "press") {
        await session.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: action.key,
          text: action.key === "Enter" ? "\r" : undefined,
        })
        await session.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: action.key,
        })
        await this.#settle(300)
      }

      // Always collect AX nodes + paint visual `[ref=eN]` overlay + capture screenshot
      const collected = await this.#evalJson<{
        url: string
        title: string
        nodes: AxNodeSummary[]
      }>(session, ANNOTATE_AND_COLLECT_JS)

      // Let the overlay paint one frame
      await this.#settle(80)

      const shot = await session.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
      })

      await this.#evalJson(session, REMOVE_OVERLAY_JS)

      this.#step += 1
      const filename = `step-${String(this.#step).padStart(3, "0")}.png`
      const screenshotPath = join(this.#screenshotDir, filename)
      writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"))

      const axLines = [
        `page "${collected.title}" url=${collected.url}`,
        ...collected.nodes.map((n) => {
          const valPart = n.value !== undefined ? ` value=${JSON.stringify(n.value)}` : ""
          return `  [ref=${n.ref}] ${n.role} ${JSON.stringify(n.name)}${valPart} @(${n.bounds.x},${n.bounds.y},${n.bounds.width}x${n.bounds.height})`
        }),
      ]

      return {
        url: collected.url,
        title: collected.title,
        axText: axLines.join("\n"),
        nodes: collected.nodes,
        screenshotPath,
        screenshotBase64: shot.data,
      }
    } finally {
      session.close()
    }
  }

  async #evalJson<T>(session: CdpSession, expression: string): Promise<T> {
    const res = await session.send<{
      result?: { value?: T }
      exceptionDetails?: { text?: string }
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`In-page eval failed: ${res.exceptionDetails.text ?? "unknown"}`)
    }
    return res.result?.value as T
  }

  async #settle(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, ms)
    await promise
  }
}
