import { servePublicMcp } from "../../src/sandbox/mcp-server"
import { sha256Bytes } from "../../src/hash"
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==",
  "base64",
)
await servePublicMcp({
  host: {
    read: async (raw) => {
      if (raw && typeof raw === "object" && "path" in raw && raw.path === "src/own") return { text: "own" }
      throw Error("denied")
    },
    write: async () => {
      throw Error("denied")
    },
    check: async () => {
      throw Error("denied")
    },
    preview: async () => {
      throw Error("denied")
    },
    capture: async () => {
      return {
        screenshotSha256: sha256Bytes(png),
        evidenceSha256: "a".repeat(64),
        identity: { previewID: "b".repeat(64), viewportID: "desktop", candidateSha256: "c".repeat(64) },
        image: { mimeType: "image/png", data: png.toString("base64"), bytes: png.length, sha256: sha256Bytes(png) },
      }
    },
  },
  capability: "a".repeat(64),
})
