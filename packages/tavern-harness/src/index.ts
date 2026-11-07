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
 *
 * All bodies throw: this is the interface skeleton, the engine lands separately.
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
}

/** What `session.compacting` persists across turns without recomputing it. */
export interface CompactionPayload {
  summary: string
  preserveData: Record<string, unknown>
}

export class TavernHarness {
  configure(budget: WindowBudget): void {
    throw new Error("not implemented")
  }

  ingestMessage(msg: string): void {
    throw new Error("not implemented")
  }

  matchLorebook(queryTerm: string): LoreMatch[] {
    throw new Error("not implemented")
  }

  assemblePrompt(): PromptAssembly {
    throw new Error("not implemented")
  }

  compactHistory(summary: string): string {
    throw new Error("not implemented")
  }

  /** Stable prefix: rendered once per session into `systemPrompt`. */
  formatForSystemPrompt(): string[] {
    throw new Error("not implemented")
  }

  /** Frozen infix: the structured state compaction carries in `preserveData`. */
  buildCompactionPayload(): CompactionPayload {
    throw new Error("not implemented")
  }
}
