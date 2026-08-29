export namespace Slug {
  const ADJECTIVES = [
    "brave",
    "calm",
    "clever",
    "cosmic",
    "crisp",
    "curious",
    "eager",
    "gentle",
    "glowing",
    "happy",
    "hidden",
    "jolly",
    "kind",
    "lucky",
    "mighty",
    "misty",
    "neon",
    "nimble",
    "playful",
    "proud",
    "quick",
    "quiet",
    "shiny",
    "silent",
    "stellar",
    "sunny",
    "swift",
    "tidy",
    "witty",
  ] as const

  const NOUNS = [
    "cabin",
    "cactus",
    "canyon",
    "circuit",
    "comet",
    "eagle",
    "engine",
    "falcon",
    "forest",
    "garden",
    "harbor",
    "island",
    "knight",
    "lagoon",
    "meadow",
    "moon",
    "mountain",
    "nebula",
    "orchid",
    "otter",
    "panda",
    "pixel",
    "planet",
    "river",
    "rocket",
    "sailor",
    "squid",
    "star",
    "tiger",
    "wizard",
    "wolf",
  ] as const

  export function create(identity?: string) {
    if (identity !== undefined) {
      let hash = 2166136261
      for (let index = 0; index < identity.length; index++) {
        hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619) >>> 0
      }
      const adjective = ADJECTIVES[hash % ADJECTIVES.length]
      const noun = NOUNS[(Math.imul(hash, 2246822519) >>> 0) % NOUNS.length]
      return `${adjective}-${noun}`
    }
    return [
      ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
      NOUNS[Math.floor(Math.random() * NOUNS.length)],
    ].join("-")
  }
}
