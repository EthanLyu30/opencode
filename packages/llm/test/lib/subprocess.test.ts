import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawnWithoutDotenv } from "./subprocess"

test("recorded-test child launcher does not load a dotenv canary from its working directory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-child-noenv-"))
  try {
    await fs.writeFile(path.join(directory, ".env.local"), "OPENCODE_CHILD_DOTENV_CANARY=must-not-load\n", {
      flag: "wx",
    })
    await fs.writeFile(
      path.join(directory, "probe.ts"),
      'console.log(process.env.OPENCODE_CHILD_DOTENV_CANARY ?? "absent")',
      { flag: "wx" },
    )
    const child = spawnWithoutDotenv(["probe.ts"], {
      cwd: directory,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: directory, TMP: directory },
    })
    const [exit, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exit).toBe(0)
    expect(output.trim()).toBe("absent")
    expect(errors).toBe("")
  } finally {
    const resolved = await fs.realpath(directory)
    if (resolved.toLowerCase() !== path.resolve(directory).toLowerCase() || path.dirname(directory) !== os.tmpdir())
      throw new Error("Noenv fixture ownership changed")
    for (const file of ["probe.ts", ".env.local"]) await fs.unlink(path.join(directory, file))
    await fs.rmdir(directory)
  }
})
