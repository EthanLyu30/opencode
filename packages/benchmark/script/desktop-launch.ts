import { runDesktopLaunchCommand } from "../src/sandbox/desktop/command"
const result = await runDesktopLaunchCommand(process.argv.slice(2))
process.stdout.write(JSON.stringify(result.output) + "\n")
process.exitCode = result.exitCode
