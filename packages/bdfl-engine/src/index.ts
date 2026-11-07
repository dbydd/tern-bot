/**
 * The Bot's BDFL loop, as modelled by design/behavior/INTENT.md.
 *
 * WORKING → PR_SUBMITTED → REVIEW → MERGED, or REVIEW → WORKING on feedback.
 * The one invariant the type carries: `everReviewed` never goes back to false,
 * so `merge` can refuse a PR that never passed through REVIEW.
 *
 * Bodies throw: this is the interface skeleton, the engine lands separately.
 */

export type PrState = "OPEN" | "WORKING" | "PR_SUBMITTED" | "REVIEW" | "MERGED" | "FEEDBACK"

export interface PrRecord {
  id: string
  issueId: string
  branch: string
  workerId: string
  workerSandboxId: string
  state: PrState
  reviewLeaseId?: string
  everReviewed: boolean
}

export class BdflEngine {
  dispatch(issueId: string, branch: string, instructions: string): Promise<PrRecord> {
    throw new Error("not implemented")
  }

  review(prId: string): Promise<void> {
    throw new Error("not implemented")
  }

  merge(prId: string, commitMessage?: string): Promise<void> {
    throw new Error("not implemented")
  }

  reject(prId: string, feedback: string): Promise<void> {
    throw new Error("not implemented")
  }

  status(): PrRecord[] {
    throw new Error("not implemented")
  }
}
