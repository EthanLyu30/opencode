import type { RunState } from "./state"
import type { RunRecord } from "./schema"
import type { Service as RunStoreService } from "./store"

export class Scheduler {
  readonly #store: RunStoreService
  readonly #ownerID: string
  readonly #leaseMs: number
  readonly #now: () => number

  constructor(input: {
    readonly store: RunStoreService
    readonly ownerID: string
    readonly leaseMs: number
    readonly now?: () => number
  }) {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.ownerID) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs <= 0
    ) {
      throw new TypeError("TASK24_SCHEDULER_AUTHORITY_INVALID")
    }
    this.#store = input.store
    this.#ownerID = input.ownerID
    this.#leaseMs = input.leaseMs
    this.#now = input.now ?? Date.now
  }

  async claimNext(campaignID: string): Promise<RunRecord | undefined> {
    return this.#store.claimNextRun(campaignID, this.#ownerID, this.#now(), this.#leaseMs)
  }

  renew(runID: string): boolean {
    return this.#store.renewLease(runID, this.#ownerID, this.#now(), this.#leaseMs)
  }

  advance(runID: string, state: RunState): RunRecord {
    this.#assertOwned(runID)
    return this.#store.transition(runID, state, new Date(this.#now()).toISOString())
  }

  async cancel(runID: string, terminateAndSettle: () => Promise<void>): Promise<void> {
    this.#assertOwned(runID)
    this.#store.transition(runID, "canceling", new Date(this.#now()).toISOString())
    await terminateAndSettle()
    this.#store.transition(runID, "canceled", new Date(this.#now()).toISOString())
    this.#store.completeCancellation(runID)
    this.#store.releaseLease(runID, this.#ownerID)
  }

  release(runID: string): boolean {
    return this.#store.releaseLease(runID, this.#ownerID)
  }

  #assertOwned(runID: string): void {
    const lease = this.#store.lease(runID)
    if (!lease || lease.ownerID !== this.#ownerID || lease.expiresAt <= this.#now()) {
      throw new TypeError("TASK24_SCHEDULER_LEASE_LOST")
    }
  }
}
