/**
 * Contract: design/contract/ternBot.ompSession.tavernHarness.vdmsl
 *
 * The three segments map onto three OMP hooks, and the mapping is the point:
 *
 * - prefix      `formatForSystemPrompt()` → `before_agent_start` appends it to `systemPrompt`.
 *               Never re-synthesised per call, so the provider prefix cache stays valid.
 * - infix       `buildCompactionPayload()` → `session.compacting` writes it into the
 *               CompactionEntry's `preserveData`. Regenerated only when compaction runs.
 * - suffix      `assemblePrompt()` → the `context` hook truncates the rolling history.
 * - author note `assemblePrompt()` also places the note at the configured depth (REQ-6).
 *
 * Anything the `context` hook synthesises per call is tagged `kPerCallContextMessage`
 * by OMP and skipped by prefix caching, so the pre-call path must stay a truncation,
 * not a re-serialisation of history.
 */

export interface Ratio {
  num: number
  den: number
}

export interface WindowBudget {
  totalTokens: number
  prefixRatio: Ratio
  infixRatio: Ratio
  suffixRatio: Ratio
  authorNoteRatio: Ratio
}

export interface PromptAssembly {
  prefixTokens: number
  infixTokens: number
  suffixTokens: number
  authorNoteTokens: number
  totalTokens: number
}

export interface LoreMatch {
  entryId: string
  tokens: number
  content?: string
}

export interface CharacterCard {
  name: string
  description: string
  personality: string
  systemPrompt: string
  postHistoryInstructions?: string
}

export interface LoreEntry {
  id: string
  keys: string[]
  secondaryKeys?: string[]
  content: string
  cooldownTurns?: number
  alwaysActive?: boolean
}

export interface AuthorNoteConfig {
  text: string
  depth: number
}

export interface HindsightRetainRequest {
  intent: string
  content: string
  target?: string
}

/** What `session.compacting` persists across turns without recomputing it. */
export interface CompactionPayload {
  summary: string
  preserveData: Record<string, unknown>
  hindsightRetain: HindsightRetainRequest
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return Math.max(1, Math.ceil(trimmed.length / 4))
}

export class TavernHarness {
  #budget: WindowBudget = {
    totalTokens: 8192,
    prefixRatio: { num: 25, den: 100 },
    infixRatio: { num: 20, den: 100 },
    suffixRatio: { num: 50, den: 100 },
    authorNoteRatio: { num: 5, den: 100 },
  }
  #card: CharacterCard = {
    name: "Tern-Bot",
    description: "Personal Assistant & Project BDFL",
    personality: "Pragmatic, concise, architecture-first",
    systemPrompt: "Coordinate work via isolated sandboxes and Git PR reviews; never write business code directly in main.",
  }
  #lorebook = new Map<string, LoreEntry>()
  #cooldownUntilTurn = new Map<string, number>()
  #history: string[] = []
  #infixSummary = ""
  #authorNote: AuthorNoteConfig = { text: "", depth: 2 }
  #turnCounter = 0
  #maxWindowTurns = 12
  #loreBudgetTokens = 600

  constructor(opts?: {
    budget?: WindowBudget
    card?: CharacterCard
    loreEntries?: LoreEntry[]
    authorNote?: AuthorNoteConfig
    maxWindowTurns?: number
    loreBudgetTokens?: number
  }) {
    if (opts?.budget) this.configure(opts.budget)
    if (opts?.card) this.#card = { ...opts.card }
    if (opts?.loreEntries) {
      for (const entry of opts.loreEntries) this.registerLoreEntry(entry)
    }
    if (opts?.authorNote) this.#authorNote = { ...opts.authorNote }
    if (opts?.maxWindowTurns !== undefined && opts.maxWindowTurns > 0) {
      this.#maxWindowTurns = opts.maxWindowTurns
    }
    if (opts?.loreBudgetTokens !== undefined && opts.loreBudgetTokens > 0) {
      this.#loreBudgetTokens = opts.loreBudgetTokens
    }
  }

  setCharacterCard(card: CharacterCard): void {
    this.#card = { ...card }
  }

  registerLoreEntry(entry: LoreEntry): void {
    this.#lorebook.set(entry.id, { ...entry })
  }

  setAuthorNote(text: string, depth = 2): void {
    this.#authorNote = { text, depth: Math.max(1, depth) }
  }

  getHistory(): readonly string[] {
    return this.#history
  }

  getInfixSummary(): string {
    return this.#infixSummary
  }

  configure(budget: WindowBudget): void {
    if (budget.totalTokens <= 0) {
      throw new Error(`totalTokens must be positive, got ${budget.totalTokens}`)
    }
    for (const [name, r] of [
      ["prefixRatio", budget.prefixRatio],
      ["infixRatio", budget.infixRatio],
      ["suffixRatio", budget.suffixRatio],
      ["authorNoteRatio", budget.authorNoteRatio],
    ] as const) {
      if (r.den <= 0 || r.num < 0 || r.num > r.den) {
        throw new Error(`invalid ${name}: ${r.num}/${r.den}`)
      }
    }
    const sum =
      budget.prefixRatio.num / budget.prefixRatio.den +
      budget.infixRatio.num / budget.infixRatio.den +
      budget.suffixRatio.num / budget.suffixRatio.den +
      budget.authorNoteRatio.num / budget.authorNoteRatio.den
    if (sum > 1 + 1e-9) {
      throw new Error(`window budget ratios exceed 1.0: ${sum}`)
    }
    this.#budget = {
      totalTokens: budget.totalTokens,
      prefixRatio: { ...budget.prefixRatio },
      infixRatio: { ...budget.infixRatio },
      suffixRatio: { ...budget.suffixRatio },
      authorNoteRatio: { ...budget.authorNoteRatio },
    }
  }

  ingestMessage(msg: string): void {
    if (msg.trim().length === 0) {
      throw new Error("ingestMessage requires non-empty message")
    }
    this.#turnCounter += 1
    this.#history.push(msg)
    const suffixBudget = Math.floor(
      (this.#budget.totalTokens * this.#budget.suffixRatio.num) / this.#budget.suffixRatio.den,
    )
    while (
      this.#history.length > this.#maxWindowTurns ||
      (this.#history.length > 1 && this.#historyTokens() > suffixBudget)
    ) {
      const evicted = this.#history.splice(0, Math.max(1, Math.floor(this.#history.length / 2)))
      const rolled = evicted.map((m) => m.slice(0, 120)).join(" | ")
      const combined = this.#infixSummary ? `${this.#infixSummary} || ${rolled}` : rolled
      this.compactHistory(combined)
    }
  }

  matchLorebook(queryTerm: string): LoreMatch[] {
    if (queryTerm.trim().length === 0) {
      throw new Error("matchLorebook requires non-empty queryTerm")
    }
    const q = queryTerm.toLowerCase()
    const matches: LoreMatch[] = []
    let usedTokens = 0
    for (const entry of this.#lorebook.values()) {
      const cooldownUntil = this.#cooldownUntilTurn.get(entry.id) ?? 0
      if (!entry.alwaysActive && cooldownUntil > this.#turnCounter) continue
      const primaryHit = entry.keys.some((k) => q.includes(k.toLowerCase()))
      if (!primaryHit && !entry.alwaysActive) continue
      if (
        entry.secondaryKeys &&
        entry.secondaryKeys.length > 0 &&
        !entry.secondaryKeys.some((k) => q.includes(k.toLowerCase()))
      ) {
        continue
      }
      const tokens = estimateTokens(entry.content)
      if (usedTokens + tokens > this.#loreBudgetTokens) continue
      usedTokens += tokens
      if (entry.cooldownTurns && entry.cooldownTurns > 0) {
        this.#cooldownUntilTurn.set(entry.id, this.#turnCounter + entry.cooldownTurns)
      }
      matches.push({ entryId: entry.id, tokens, content: entry.content })
    }
    return matches
  }

  assemblePrompt(): PromptAssembly {
    const total = this.#budget.totalTokens
    const prefixCap = Math.floor((total * this.#budget.prefixRatio.num) / this.#budget.prefixRatio.den)
    const infixCap = Math.floor((total * this.#budget.infixRatio.num) / this.#budget.infixRatio.den)
    const suffixCap = Math.floor((total * this.#budget.suffixRatio.num) / this.#budget.suffixRatio.den)
    const noteCap = Math.floor(
      (total * this.#budget.authorNoteRatio.num) / this.#budget.authorNoteRatio.den,
    )

    const prefixRaw = estimateTokens(this.formatForSystemPrompt().join("\n"))
    const latestQuery = this.#history[this.#history.length - 1] ?? this.#card.name
    const loreMatches = this.matchLorebook(latestQuery)
    const loreTokens = loreMatches.reduce((acc, m) => acc + m.tokens, 0)

    const prefixTokens = Math.min(prefixCap, prefixRaw)
    const infixTokens = Math.min(infixCap, estimateTokens(this.#infixSummary))
    const suffixTokens = Math.min(suffixCap, this.#historyTokens())
    const authorNoteTokens = Math.min(noteCap, estimateTokens(this.#authorNote.text) + loreTokens)
    const totalTokens = Math.min(
      this.#budget.totalTokens,
      prefixTokens + infixTokens + suffixTokens + authorNoteTokens,
    )
    return {
      prefixTokens,
      infixTokens,
      suffixTokens,
      authorNoteTokens,
      totalTokens,
    }
  }

  /**
   * Assembles the rolling message window with the Author's Note injected at
   * `depth` from the end (e.g. depth=2 inserts right before the last 2 messages).
   */
  assembleWindowMessages(): Array<{ role: "user" | "developer"; content: string; perCallInjected?: boolean }> {
    const rows: Array<{ role: "user" | "developer"; content: string; perCallInjected?: boolean }> =
      this.#history.map((content) => ({ role: "user", content }))
    const latestQuery = this.#history[this.#history.length - 1] ?? ""
    const lore = latestQuery ? this.matchLorebook(latestQuery) : []
    const loreBlock = lore.length > 0 ? lore.map((l) => `[Lore:${l.entryId}] ${l.content ?? ""}`).join("\n") : ""
    const noteParts = [this.#authorNote.text.trim(), loreBlock].filter((s) => s.length > 0)
    if (noteParts.length > 0) {
      const insertIdx = Math.max(0, rows.length - this.#authorNote.depth)
      rows.splice(insertIdx, 0, {
        role: "developer",
        content: `<author-note>\n${noteParts.join("\n")}\n</author-note>`,
        perCallInjected: true,
      })
    }
    return rows
  }

  compactHistory(summary: string): string {
    if (summary.trim().length === 0) {
      throw new Error("compactHistory requires non-empty summary")
    }
    const infixCap = Math.floor(
      (this.#budget.totalTokens * this.#budget.infixRatio.num) / this.#budget.infixRatio.den,
    )
    const maxChars = Math.max(64, infixCap * 4)
    this.#infixSummary = summary.length > maxChars ? summary.slice(summary.length - maxChars) : summary
    return this.#infixSummary
  }

  /** Stable prefix: rendered once per session into `systemPrompt`. */
  formatForSystemPrompt(): string[] {
    const lines = [
      `# Character: ${this.#card.name}`,
      this.#card.description,
      `Personality: ${this.#card.personality}`,
      this.#card.systemPrompt,
    ]
    if (this.#card.postHistoryInstructions) {
      lines.push(this.#card.postHistoryInstructions)
    }
    return lines
  }

  /** Frozen infix: the structured state compaction carries in `preserveData`. */
  buildCompactionPayload(): CompactionPayload {
    const summary = this.#infixSummary || "Initial session state (no evicted turns yet)."
    return {
      summary,
      preserveData: {
        botName: this.#card.name,
        turnCounter: this.#turnCounter,
        infixSummary: summary,
        budgetTotalTokens: this.#budget.totalTokens,
      },
      hindsightRetain: {
        intent: `retain compacted session state for ${this.#card.name} at turn ${this.#turnCounter}`,
        content: summary,
      },
    }
  }

  #historyTokens(): number {
    return this.#history.reduce((sum, m) => sum + estimateTokens(m), 0)
  }
}
