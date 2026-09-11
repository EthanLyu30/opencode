export * as ToolCatalogVersion from "./catalog-version"

import type { Tool } from "./tool"

const namespace = /^@opencode\/location-tool\/[a-z][a-z0-9-]*@[1-9][0-9]*$/
const versions = new WeakMap<Tool.AnyTool, string>()

/**
 * Internal authority for shipped Location tools only. This is deliberately not
 * part of the application/plugin registration surface. A semantic executor
 * change must bump the declared version before release.
 */
export function trusted<T extends Tool.AnyTool>(tool: T, version: string): T {
  if (!namespace.test(version)) throw new TypeError("Trusted Location tool catalog version is invalid")
  const existing = versions.get(tool)
  if (existing !== undefined && existing !== version) {
    throw new TypeError("Trusted Location tool catalog version is immutable")
  }
  versions.set(tool, version)
  return tool
}

/** @internal Read only by ToolRegistry while materializing an executable catalog. */
export function get(tool: Tool.AnyTool): string | undefined {
  return versions.get(tool)
}
