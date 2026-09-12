const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\bCANARY_[A-Z0-9_]+\b/g,
] as const
const sensitiveKey =
  /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|prompt|source|tool|output|body)$/i

export function redactText(input: string): string {
  return secretPatterns.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), input)
}

export function sanitizeUnknown(input: unknown, seen = new Set<object>()): unknown {
  if (typeof input === "string") return redactText(input)
  if (input === null || typeof input !== "object") return input
  if (seen.has(input)) return "[REDACTED:CYCLE]"
  seen.add(input)
  try {
    if (Array.isArray(input)) return input.map((value) => sanitizeUnknown(value, seen))
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      result[key] = sensitiveKey.test(key) ? "[REDACTED]" : sanitizeUnknown(value, seen)
    }
    return result
  } finally {
    seen.delete(input)
  }
}

export function assertNoCanaries(values: readonly string[], canaries: readonly string[]): void {
  for (const value of values) {
    for (const canary of canaries) {
      if (value.includes(canary)) throw new TypeError("BROKER_CANARY_LEAK_DETECTED")
    }
  }
}
