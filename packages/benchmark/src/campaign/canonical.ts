function plainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n")
  if (typeof value === "bigint") return value.toString(10)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("CANONICAL_JSON_NON_FINITE_NUMBER")
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== "object") throw new TypeError("CANONICAL_JSON_UNSUPPORTED_VALUE")
  if (seen.has(value)) throw new TypeError("CANONICAL_JSON_CYCLE")

  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => normalize(item, seen))
    if (!plainObject(value)) throw new TypeError("CANONICAL_JSON_NON_PLAIN_OBJECT")

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      if (item === undefined) throw new TypeError("CANONICAL_JSON_UNDEFINED")
      result[key] = normalize(item, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet()))
}
