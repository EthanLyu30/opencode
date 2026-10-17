import { servePublicMcp } from "../../src/sandbox/mcp-server"
await servePublicMcp({
  host: {
    read: async () => {
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
      throw Error("denied")
    },
  },
  capability: "a".repeat(64),
})
