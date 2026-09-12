export type Currency = "CNY" | "USD"

interface Reservation {
  readonly currency: Currency
  readonly amount: bigint
  settled?: bigint
}

export class ReservationBook {
  readonly #ceilings: Readonly<Record<Currency, bigint>>
  readonly #reservations = new Map<string, Reservation>()
  readonly #settled: Record<Currency, bigint> = { CNY: 0n, USD: 0n }
  readonly #reserved: Record<Currency, bigint> = { CNY: 0n, USD: 0n }

  constructor(ceilings: Readonly<Record<Currency, bigint>>) {
    if (ceilings.CNY < 0n || ceilings.USD < 0n) throw new TypeError("BROKER_BUDGET_INVALID")
    this.#ceilings = Object.freeze({ ...ceilings })
  }

  reserve(requestID: string, currency: Currency, amount: bigint): void {
    if (amount < 0n || this.#reservations.has(requestID)) throw new TypeError("BROKER_RESERVATION_INVALID")
    if (amount > this.snapshot(currency).available) throw new TypeError("BUDGET_RESERVATION_EXCEEDED")
    this.#reservations.set(requestID, { currency, amount })
    this.#reserved[currency] += amount
  }

  settle(requestID: string, actual: bigint): bigint {
    const reservation = this.#reservations.get(requestID)
    if (reservation === undefined || actual < 0n || actual > reservation.amount) {
      throw new TypeError("BROKER_SETTLEMENT_INVALID")
    }
    if (reservation.settled !== undefined) {
      if (reservation.settled !== actual) throw new TypeError("BROKER_SETTLEMENT_CONFLICT")
      return actual
    }
    reservation.settled = actual
    this.#reserved[reservation.currency] -= reservation.amount
    this.#settled[reservation.currency] += actual
    return actual
  }

  forfeit(requestID: string): bigint {
    const reservation = this.#reservations.get(requestID)
    if (reservation === undefined) throw new TypeError("BROKER_RESERVATION_NOT_FOUND")
    return this.settle(requestID, reservation.amount)
  }

  snapshot(currency: Currency): {
    readonly ceiling: bigint
    readonly reserved: bigint
    readonly settled: bigint
    readonly available: bigint
  } {
    const ceiling = this.#ceilings[currency]
    const reserved = this.#reserved[currency]
    const settled = this.#settled[currency]
    return Object.freeze({ ceiling, reserved, settled, available: ceiling - reserved - settled })
  }
}
