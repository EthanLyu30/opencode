import { privateFixture } from "./private"
export function guardrailFixture(modules: readonly string[]): Readonly<Record<string, string>> {
  const files = privateFixture(modules)
  return { ".task24/smoke.test.ts": files[".task24/smoke.test.ts"]! }
}
