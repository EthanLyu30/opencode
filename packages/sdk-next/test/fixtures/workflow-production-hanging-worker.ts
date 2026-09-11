const resultPath = process.argv[3]
const mode = process.argv[4]

if (!resultPath) throw new Error("Missing result path")

if (mode === "spawn-pipe-descendant") {
  const descendant = Bun.spawn(
    [process.execPath, import.meta.path, process.argv[2] ?? "", resultPath, "pipe-descendant"],
    {
      detached: true,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  descendant.unref()
  process.exit(0)
}

if (mode === "pipe-descendant") {
  process.stdout.write("descendant stdout remains open\n")
  process.stderr.write("descendant stderr remains open\n")
  await Bun.sleep(750)
  await Bun.write(resultPath, "descendant exited")
  process.exit(0)
}

process.stdout.write("o".repeat(128 * 1024))
process.stderr.write("e".repeat(128 * 1024))
await Bun.sleep(750)
await Bun.write(resultPath, "completed")
