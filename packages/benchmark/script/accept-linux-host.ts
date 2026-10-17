import { runLinuxHostCommand } from "../src/sandbox/command"
const result = await runLinuxHostCommand(["accept", ...process.argv.slice(2)])
process.stdout.write(JSON.stringify(result.output) + "\n")
process.exitCode = result.exitCode
