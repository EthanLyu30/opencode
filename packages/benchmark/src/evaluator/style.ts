import { decodeDom } from "./geometry"

const scoredProperties = Object.freeze([
  "background-color",
  "border-radius",
  "color",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "gap",
  "line-height",
  "opacity",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "position",
])

export function styleScore(reference: readonly unknown[], candidate: readonly unknown[]): number {
  const expected = decodeDom(reference)
  const actual = new Map(decodeDom(candidate).map((item) => [identity(item), item]))
  let comparisons = 0
  let matches = 0
  for (const item of expected) {
    const compared = actual.get(identity(item))
    for (const property of scoredProperties) {
      if (!(property in item.style)) continue
      comparisons++
      if (compared && normalize(item.style[property] ?? "") === normalize(compared.style[property] ?? "")) matches++
    }
  }
  if (comparisons === 0) throw new TypeError("TASK24_STYLE_EMPTY")
  return round((matches / comparisons) * 100)
}

function identity(value: ReturnType<typeof decodeDom>[number]): string {
  return value.testID ? `test:${value.testID}` : value.id ? `id:${value.id}` : `index:${value.index}:${value.tag}`
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
