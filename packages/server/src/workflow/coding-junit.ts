export * as CodingJUnit from "./coding-junit"

/** Bounded, non-expanding parser for the pinned Bun JUnit dialect, not console-summary matching. */
export function parse(xml: string): {
  readonly observedTests: number
  readonly failedTests: number
  readonly skippedTests: number
} {
  if (
    !xml ||
    Buffer.byteLength(xml) > 256 * 1024 ||
    /<!DOCTYPE|<!ENTITY|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(xml)
  )
    throw new Error("Invalid bounded Bun JUnit report")
  const stack: string[] = []
  let offset = 0
  let root: Record<string, string> | undefined
  let ended = false
  let cases = 0
  let failures = 0
  let errors = 0
  let skipped = 0
  let current: { failure: boolean; error: boolean; skipped: boolean } | undefined
  const token =
    /<\?xml\s[^?]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/y
  const entities = (text: string) => {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) throw new Error("Invalid JUnit entity")
  }
  while (offset < xml.length) {
    token.lastIndex = offset
    const match = token.exec(xml)
    if (!match) throw new Error("Malformed JUnit XML")
    offset = token.lastIndex
    const text = match[0]
    if (text.startsWith("<?xml")) {
      if (root || offset !== text.length) throw new Error("Invalid XML declaration")
      continue
    }
    if (text.startsWith("<!--")) {
      if (text.slice(4, -3).includes("--")) throw new Error("Invalid XML comment")
      continue
    }
    if (text.startsWith("<![CDATA[")) {
      if (!stack.length) throw new Error("Unexpected JUnit CDATA")
      continue
    }
    if (!text.startsWith("<")) {
      entities(text)
      if (!stack.length && text.trim()) throw new Error("Trailing JUnit content")
      continue
    }
    const name = /^<\/?([A-Za-z][A-Za-z0-9_-]*)/.exec(text)![1]!
    if (text.startsWith("</")) {
      if (stack.pop() !== name) throw new Error("Unbalanced JUnit XML")
      if (name === "testcase") current = undefined
      if (!stack.length) ended = true
      continue
    }
    if (ended || stack.length >= 128) throw new Error("Multiple or deeply nested JUnit roots")
    const attrs: Record<string, string> = Object.create(null)
    for (const attribute of text.matchAll(/\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (Object.hasOwn(attrs, attribute[1]!)) throw new Error("Duplicate JUnit attribute")
      attrs[attribute[1]!] = attribute[2] ?? attribute[3]!
      entities(attrs[attribute[1]!]!)
    }
    if (!root) {
      if (name !== "testsuites") throw new Error("Missing Bun JUnit root")
      root = attrs
    } else if (!stack.length) throw new Error("Unexpected JUnit root")
    if (name === "testcase") {
      if (current || !["testsuite", "testsuites"].includes(stack.at(-1) ?? ""))
        throw new Error("Invalid JUnit testcase placement")
      cases++
      current = { failure: false, error: false, skipped: false }
    }
    if (name === "failure" || name === "error" || name === "skipped") {
      if (!current || stack.at(-1) !== "testcase" || current[name]) throw new Error("Invalid JUnit testcase state")
      current[name] = true
      if (name === "failure") failures++
      if (name === "error") errors++
      if (name === "skipped") skipped++
      if ((current.failure && current.error) || (current.skipped && (current.failure || current.error)))
        throw new Error("Contradictory JUnit testcase")
    }
    if (text.endsWith("/>")) {
      if (name === "testcase") current = undefined
      if (!stack.length) ended = true
    } else stack.push(name)
  }
  const count = (name: string, fallback?: number) => {
    const value = root?.[name]
    if (value === undefined && fallback !== undefined) return fallback
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid JUnit count")
    return Number(value)
  }
  if (
    !root ||
    !ended ||
    stack.length ||
    count("tests") !== cases ||
    count("failures", 0) !== failures ||
    count("errors", 0) !== errors ||
    count("skipped", 0) !== skipped
  )
    throw new Error("JUnit totals contradict actual cases")
  return { observedTests: cases - skipped, failedTests: failures + errors, skippedTests: skipped }
}
