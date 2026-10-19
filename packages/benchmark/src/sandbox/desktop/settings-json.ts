import { Schema } from "effect"

/** Decode keys before accepting JSON: normal decoders discard duplicate members. */
export function parseDesktopSettingsJson(bytes: Uint8Array, maxBytes: number): unknown {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    bytes.length > maxBytes ||
    (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191)
  )
    throw new TypeError("TASK24_DESKTOP_SETTINGS_JSON_LIMIT")
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  let pos = 0
  const fail = (): never => {
    throw new TypeError("TASK24_DESKTOP_SETTINGS_JSON")
  }
  const space = () => {
    while (/[ \t\r\n]/.test(text[pos] ?? "!")) pos++
  }
  const string = (): string => {
    if (text[pos] !== '"') return fail()
    const start = pos++
    while (pos < text.length) {
      const c = text[pos++]!
      if (c === '"')
        return Schema.decodeUnknownSync(Schema.String)(
          Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text.slice(start, pos)),
        )
      if (c.charCodeAt(0) < 32) return fail()
      if (c !== "\\") continue
      const escaped = text[pos++]
      if (escaped === "u") {
        if (!/^[a-fA-F0-9]{4}$/.test(text.slice(pos, pos + 4))) return fail()
        pos += 4
        continue
      }
      if (!escaped || !'"\\/bfnrt'.includes(escaped)) return fail()
    }
    return fail()
  }
  const value = (depth: number): void => {
    space()
    const c = text[pos]
    if (c === '"') {
      string()
      return
    }
    if (c === "{" || c === "[") {
      if (depth >= 32) throw new TypeError("TASK24_DESKTOP_SETTINGS_JSON_DEPTH")
      pos++
      space()
      const close = c === "{" ? "}" : "]",
        keys = new Set<string>()
      if (text[pos] === close) {
        pos++
        return
      }
      while (pos < text.length) {
        if (c === "{") {
          space()
          const key = string().toLowerCase()
          if (keys.has(key)) throw new TypeError("TASK24_DESKTOP_SETTINGS_JSON_DUPLICATE")
          keys.add(key)
          space()
          if (text[pos++] !== ":") return fail()
        }
        value(depth + 1)
        space()
        if (text[pos] === close) {
          pos++
          return
        }
        if (text[pos++] !== ",") return fail()
      }
      return fail()
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(pos))?.[0]
    if (!token || (!["true", "false", "null"].includes(token) && !Number.isFinite(Number(token)))) return fail()
    pos += token.length
  }
  value(0)
  space()
  if (pos !== text.length) fail()
  return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text)
}
