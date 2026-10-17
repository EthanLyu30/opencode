import { servePublicMcp, callPublicToolPipe } from "../src/sandbox/mcp-server"
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== "--pipe") throw new TypeError("TASK24_MCP_ARGUMENTS")
const capability = process.env.TASK24_PUBLIC_TOOL_CAPABILITY
if (!capability) throw new TypeError("TASK24_MCP_CAPABILITY")
const pipe = args[1]!
const call = (name: string) => (parameters: unknown) => callPublicToolPipe({ pipe, capability, name, parameters })
await servePublicMcp({
  capability,
  host: {
    read: call("read"),
    write: call("write"),
    check: call("check"),
    preview: call("preview"),
    capture: call("capture"),
  },
})
