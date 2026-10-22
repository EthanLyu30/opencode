import { servePublicMcp, callPublicToolPipe, callPublicToolLoopback } from "../src/sandbox/mcp-server"
const args = process.argv.slice(2)
if (args.length !== 2 || !["--pipe", "--loopback"].includes(args[0]!)) throw new TypeError("TASK24_MCP_ARGUMENTS")
const capability = process.env.TASK24_PUBLIC_TOOL_CAPABILITY
if (!capability) throw new TypeError("TASK24_MCP_CAPABILITY")
const endpoint = args[1]!
if (args[0] === "--loopback" && !/^[1-9][0-9]{0,4}$/.test(endpoint)) throw new TypeError("TASK24_MCP_ARGUMENTS")
const call = (name: string) => (parameters: unknown) =>
  args[0] === "--pipe"
    ? callPublicToolPipe({ pipe: endpoint, capability, name, parameters })
    : callPublicToolLoopback({ host: "127.0.0.1", port: Number(endpoint), capability, name, parameters })
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
