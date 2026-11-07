/**
 * The Bot's BDFL loop, as modelled by design/behavior/INTENT.md.
 *
 * WORKING → PR_SUBMITTED → REVIEW → MERGED, or REVIEW → WORKING on feedback.
 * The one invariant the type carries: `everReviewed` never goes back to false,
 * so `merge` can refuse a PR that never passed through REVIEW.
 */

import { LeaseManager, MockDriver } from "@tern-bot/sandbox-broker"

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
  instructions?: string
  lastFeedback?: string
  mergedCommitMessage?: string
}

export class BdflEngine {
  readonly #leases: LeaseManager
  readonly #botId: string
  readonly #records = new Map<string, PrRecord>()
  #seq = 0

  constructor(opts?: { leases?: LeaseManager; botId?: string }) {
    this.#leases = opts?.leases ?? new LeaseManager(new MockDriver())
    this.#botId = opts?.botId ?? "bot-1"
  }

  async dispatch(issueId: string, branch: string, instructions: string): Promise<PrRecord> {
    this.#seq += 1
    const prId = `pr-${this.#seq}`
    const workerId = `worker-${this.#seq}`
    const workerLease = await this.#leases.acquire({
      botId: this.#botId,
      kind: "worker",
      ttlSecs: 7200,
      spec: { name: `${this.#botId}-${workerId}`, branch, issueId },
    })
    const record: PrRecord = {
      id: prId,
      issueId,
      branch,
      workerId,
      workerSandboxId: workerLease.id,
      state: "WORKING",
      everReviewed: false,
      instructions,
    }
    this.#records.set(prId, record)
    return { ...record }
  }

  async submitPr(prId: string): Promise<PrRecord> {
    const rec = this.#require(prId)
    if (rec.state !== "WORKING" && rec.state !== "FEEDBACK" && rec.state !== "OPEN") {
      throw new Error(`cannot submit PR ${prId} from state ${rec.state}`)
    }
    rec.state = "PR_SUBMITTED"
    return { ...rec }
  }

  async review(prId: string): Promise<void> {
    const rec = this.#require(prId)
    if (rec.state === "WORKING") {
      rec.state = "PR_SUBMITTED"
    }
    if (rec.state !== "PR_SUBMITTED") {
      throw new Error(`PR ${prId} must be PR_SUBMITTED before review, got ${rec.state}`)
    }
    const reviewLease = await this.#leases.acquire({
      botId: this.#botId,
      kind: "main",
      ttlSecs: 3600,
      spec: { name: `${this.#botId}-review-${prId}`, branch: rec.branch },
    })
    rec.reviewLeaseId = reviewLease.id
    rec.everReviewed = true
    rec.state = "REVIEW"
  }

  async merge(prId: string, commitMessage?: string): Promise<void> {
    const rec = this.#require(prId)
    if (rec.state !== "REVIEW" || !rec.everReviewed || !rec.reviewLeaseId) {
      throw new Error(`invariant violation: PR ${prId} cannot be merged without active REVIEW and everReviewed=true`)
    }
    const lease = await this.#leases.query(rec.reviewLeaseId)
    if (!lease || lease.leaseState !== "RUNNING") {
      throw new Error(`invariant violation: review sandbox lease ${rec.reviewLeaseId} is not RUNNING`)
    }
    await this.#leases.release(rec.reviewLeaseId)
    await this.#leases.release(rec.workerSandboxId)
    rec.reviewLeaseId = undefined
    rec.state = "MERGED"
    rec.mergedCommitMessage = commitMessage ?? `Merge branch '${rec.branch}' (${prId})`
  }

  async reject(prId: string, feedback: string): Promise<void> {
    const rec = this.#require(prId)
    if (rec.state !== "REVIEW" || !rec.reviewLeaseId) {
      throw new Error(`PR ${prId} must be in REVIEW to reject, got ${rec.state}`)
    }
    await this.#leases.release(rec.reviewLeaseId)
    rec.reviewLeaseId = undefined
    rec.lastFeedback = feedback
    rec.state = "WORKING"
  }

  status(): PrRecord[] {
    return Array.from(this.#records.values(), (r) => ({ ...r }))
  }

  #require(prId: string): PrRecord {
    const rec = this.#records.get(prId)
    if (!rec) throw new Error(`unknown PR: ${prId}`)
    return rec
  }
}
