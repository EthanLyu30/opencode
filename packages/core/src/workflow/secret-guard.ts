export * as WorkflowSecretGuard from "./secret-guard"

import { Schema } from "effect"
import { Workflow } from "@opencode-ai/schema/workflow"

export class UnsafePersistenceError extends Schema.TaggedErrorClass<UnsafePersistenceError>()(
  "Workflow.UnsafePersistenceError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

const sensitiveKey =
  /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|set-cookie|provider[-_]?response[-_]?body)$/i
const sensitiveQuery = /^(token|key|signature|sig|credential|x-amz-signature)$/i

const sensitiveValue = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/
const bearerReplace = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
const apiKeyReplace = /\bsk-[A-Za-z0-9_-]{8,}\b/g

export function assertSafe(value: unknown, path = "$"): void {
  walk(value, path, new Set())
}

function walk(value: unknown, path: string, active: Set<object>): void {
  if (value === null || typeof value === "boolean") return
  if (typeof value === "number") {
    if (Number.isFinite(value)) return
    throw unsafe(path, "Non-finite numbers cannot be persisted")
  }
  if (typeof value === "string") {
    try {
      const url = new URL(value)
      for (const [key] of url.searchParams) {
        if (sensitiveQuery.test(key)) {
          throw unsafe(`${path}.query.${key}`, `Sensitive query parameter "${key}" in URL`)
        }
      }
    } catch (error) {
      if (error instanceof UnsafePersistenceError) throw error
    }
    if (sensitiveValue.test(value)) {
      throw unsafe(path, "Sensitive value pattern detected")
    }
    return
  }
  if (typeof value !== "object") {
    throw unsafe(path, `Unsupported persisted value type: ${typeof value}`)
  }
  if (active.has(value)) {
    throw unsafe(path, "Cyclic values cannot be persisted")
  }
  active.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], `${path}[${i}]`, active)
    }
    active.delete(value)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw unsafe(path, "Only plain JSON objects can be persisted")
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    throw unsafe(path, "Symbol keys cannot be persisted")
  }
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key)) {
      throw unsafe(`${path}.${key}`, `Sensitive key "${key}"`)
    }
    if (key === "persistable" && item === false && Object.hasOwn(value, "reasoning_content")) {
      throw unsafe(path, "Reasoning content marked non-persistable cannot be persisted")
    }
    walk(item, `${path}.${key}`, active)
  }
  active.delete(value)
}

export function sanitizeText(text: string): string {
  return text.replaceAll(bearerReplace, "Bearer [REDACTED]").replaceAll(apiKeyReplace, "[REDACTED]")
}

export function sanitizeFailure(failure: Workflow.Failure): Workflow.Failure {
  return {
    category: failure.category,
    code: sanitizeText(failure.code),
    message: sanitizeText(failure.message),
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    ...(failure.ref === undefined ? {} : { ref: sanitizeText(failure.ref) }),
  }
}

function unsafe(path: string, message: string) {
  return new UnsafePersistenceError({ path, message })
}
