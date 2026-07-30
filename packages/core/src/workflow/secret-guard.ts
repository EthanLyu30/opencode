export * as WorkflowSecretGuard from "./secret-guard"

export class UnsafePersistenceError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message)
  }
}

const sensitiveKey = /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|set-cookie)$/i
const sensitiveQuery = /^(token|key|signature|sig|credential|x-amz-signature)$/i

const sensitiveValue = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,})/g
const bearerReplace = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
const apiKeyReplace = /\bsk-[A-Za-z0-9_-]{8,}\b/g

export function assertSafe(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return
  if (typeof value === "string") {
    // Check query params in URLs
    try {
      const url = new URL(value)
      for (const [key] of url.searchParams) {
        if (sensitiveQuery.test(key)) {
          throw new UnsafePersistenceError(`${path}.query.${key}`, `Sensitive query parameter "${key}" in URL`)
        }
      }
    } catch (e) {
      if (e instanceof UnsafePersistenceError) throw e
      // Not a URL, fall through to plain string checks
    }
    if (sensitiveValue.test(value)) {
      throw new UnsafePersistenceError(path, "Sensitive value pattern detected")
    }
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertSafe(value[i], `${path}[${i}]`)
    }
    return
  }
  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (sensitiveKey.test(key)) {
        throw new UnsafePersistenceError(`${path}.${key}`, `Sensitive key "${key}"`)
      }
      assertSafe(val, `${path}.${key}`)
    }
  }
}

export function sanitizeText(text: string): string {
  return text.replaceAll(bearerReplace, "Bearer [REDACTED]").replaceAll(apiKeyReplace, "[REDACTED]")
}

export function sanitizeFailure(failure: { category: string; code: string; message: string; retryAfterMs?: number; ref?: string }): {
  category: string
  code: string
  message: string
  retryAfterMs?: number
  ref?: string
} {
  return {
    category: failure.category,
    code: failure.code,
    message: sanitizeText(failure.message),
    retryAfterMs: failure.retryAfterMs,
    ref: failure.ref,
  }
}
