import { runDesktopLaunchCommand } from "../src/sandbox/desktop/command"
const controller = new AbortController()
const cancel = () => controller.abort()
process.on("SIGINT", cancel)
try {
  const result = await runDesktopLaunchCommand(process.argv.slice(2), controller.signal)
  process.stdout.write(JSON.stringify(result.output) + "\n")
  process.exitCode = result.exitCode
} finally {
  process.off("SIGINT", cancel)
}
