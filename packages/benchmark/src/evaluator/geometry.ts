export interface DomBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DomSample {
  readonly index: number
  readonly tag: string
  readonly id: string
  readonly role: string | null
  readonly testID: string | null
  readonly box: DomBox
  readonly style: Readonly<Record<string, string>>
}

export function geometryScore(reference: readonly unknown[], candidate: readonly unknown[]): number {
  const expected = decodeDom(reference)
  const actual = new Map(decodeDom(candidate).map((item) => [identity(item), item]))
  if (expected.length === 0) throw new TypeError("TASK24_GEOMETRY_EMPTY")
  let earned = 0
  for (const item of expected) {
    const compared = actual.get(identity(item))
    if (!compared) continue
    earned += boxScore(item.box, compared.box)
  }
  return round((earned / expected.length) * 100)
}

export function decodeDom(values: readonly unknown[]): readonly DomSample[] {
  if (values.length === 0 || values.length > 2_000) throw new TypeError("TASK24_DOM_INVALID")
  const identities = new Set<string>()
  const result = values.map((value) => {
    if (!isRecord(value) || !isRecord(value.box) || !isRecord(value.style)) throw new TypeError("TASK24_DOM_INVALID")
    if (
      !safeInteger(value.index) ||
      !text(value.tag, 1, 64) ||
      !text(value.id, 0, 256) ||
      (value.role !== null && !text(value.role, 0, 128)) ||
      (value.testID !== null && !text(value.testID, 0, 256))
    ) {
      throw new TypeError("TASK24_DOM_INVALID")
    }
    const box = decodeBox(value.box)
    const style = decodeStyle(value.style)
    const item: DomSample = {
      index: value.index,
      tag: value.tag,
      id: value.id,
      role: value.role,
      testID: value.testID,
      box,
      style,
    }
    const key = identity(item)
    if (identities.has(key)) throw new TypeError("TASK24_DOM_DUPLICATE")
    identities.add(key)
    return Object.freeze(item)
  })
  return Object.freeze(result)
}

function boxScore(reference: DomBox, candidate: DomBox): number {
  return (
    (["x", "y", "width", "height"] as const).reduce((sum, key) => {
      const tolerance = Math.max(8, Math.abs(reference[key]) * 0.05)
      return sum + Math.max(0, 1 - Math.abs(reference[key] - candidate[key]) / tolerance)
    }, 0) / 4
  )
}

function decodeBox(value: Record<string, unknown>): DomBox {
  const keys = Object.keys(value).toSorted().join(",")
  if (keys !== "height,width,x,y") throw new TypeError("TASK24_DOM_INVALID")
  return Object.freeze({
    x: coordinate(value.x),
    y: coordinate(value.y),
    width: coordinate(value.width),
    height: coordinate(value.height),
  })
}

function coordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new TypeError("TASK24_DOM_INVALID")
  }
  return value
}

function decodeStyle(value: Record<string, unknown>): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z-]{1,64}$/.test(key) || !text(item, 0, 512)) throw new TypeError("TASK24_DOM_INVALID")
    result[key] = item
  }
  return Object.freeze(result)
}

function identity(value: DomSample): string {
  return value.testID ? `test:${value.testID}` : value.id ? `id:${value.id}` : `index:${value.index}:${value.tag}`
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
