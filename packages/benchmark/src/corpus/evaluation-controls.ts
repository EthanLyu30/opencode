import { safePath } from "./evaluation-profile"

/** Text-only patch application during private corpus authoring, never a scoring rule. */
export function applyControlPatch(
  files: Readonly<Record<string, Uint8Array>>,
  patch: string,
): Readonly<Record<string, Uint8Array>> {
  const lines = patch.replace(/\r\n/g, "\n").split("\n"),
    changed: Record<string, Uint8Array> = {}
  let index = 0
  while (index < lines.length) {
    if (!lines[index]!.startsWith("--- ")) {
      index++
      continue
    }
    const oldName = lines[index++]!.slice(4).split("\t")[0]!
    const next = lines[index++]!
    if (!next.startsWith("+++ ")) throw new TypeError("TASK24_CONTROL_PATCH_HEADER")
    const newName = next.slice(4).split("\t")[0]!
    if (!newName.startsWith("b/") || (oldName !== "/dev/null" && !oldName.startsWith("a/")))
      throw new TypeError("TASK24_CONTROL_PATCH_PATH")
    const name = safePath(newName.slice(2))
    if ((oldName !== "/dev/null" && oldName.slice(2) !== name) || changed[name])
      throw new TypeError("TASK24_CONTROL_PATCH_PATH")
    if (/(?:^|\/)(?:\.git|\.env|node_modules)(?:[/.]|$)/i.test(name)) throw new TypeError("TASK24_CONTROL_PATCH_PATH")
    const input = files[name]
    if ((oldName !== "/dev/null" && !input) || (oldName === "/dev/null" && input))
      throw new TypeError("TASK24_CONTROL_PATCH_SOURCE")
    const original = input ? new TextDecoder("utf-8", { fatal: true }).decode(input) : ""
    const source = original.split("\n")
    if (source.at(-1) === "") source.pop()
    const output: string[] = []
    let cursor = 0,
      hunks = 0
    while (index < lines.length && !lines[index]!.startsWith("diff --git") && !lines[index]!.startsWith("--- ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]!)
      if (!match) {
        index++
        continue
      }
      hunks++
      index++
      let start = Math.max(0, Number(match[1]) - 1)
      const oldCount = Number(match[2] ?? 1),
        newCount = Number(match[4] ?? 1),
        before: string[] = [],
        after: string[] = []
      let removed = 0,
        added = 0
      while (removed < oldCount || added < newCount) {
        const line = lines[index++]
        if (line === undefined) throw new TypeError("TASK24_CONTROL_PATCH_TRUNCATED")
        if (line.startsWith("\\ No newline")) continue
        const kind = line[0],
          text = line.slice(1)
        if (kind === " " || kind === "-") {
          before.push(text)
          removed++
        }
        if (kind === " " || kind === "+") {
          after.push(text)
          added++
        }
        if (![" ", "-", "+"].includes(kind ?? "") || removed > oldCount || added > newCount)
          throw new TypeError("TASK24_CONTROL_PATCH_HUNK")
      }
      const matches = (at: number) =>
        at >= cursor && at + before.length <= source.length && before.every((line, i) => source[at + i] === line)
      if (!matches(start)) {
        const locations = source.map((_, at) => at).filter(matches)
        if (!before.length || locations.length !== 1) throw new TypeError("TASK24_CONTROL_PATCH_CONTEXT")
        start = locations[0]!
      }
      output.push(...source.slice(cursor, start), ...after)
      cursor = start + oldCount
    }
    if (!hunks) throw new TypeError("TASK24_CONTROL_PATCH_EMPTY")
    output.push(...source.slice(cursor))
    changed[name] = Buffer.from(output.join("\n") + "\n")
  }
  if (!Object.keys(changed).length) throw new TypeError("TASK24_CONTROL_PATCH_EMPTY")
  return changed
}
