import { linuxHostCommand } from "../src/sandbox/command"
process.exitCode = await linuxHostCommand(["accept", ...process.argv.slice(2)])
