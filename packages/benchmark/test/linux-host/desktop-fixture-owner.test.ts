import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("committed fixtures accept a fresh run owner without impersonating the implementation run", async () => {
  const parent = process.env.TMPDIR!
  const fresh = await fs.mkdtemp(path.join(parent, "owner-probe-"))
  try {
    // A sibling bprep1 root is needed by the existing fixed fixture contract; this own child
    // only supplies the independent marker because desktopFixture itself confines cleanup to mkdtemp.
    await fs.writeFile(
      path.join(fresh, "owner.json"),
      JSON.stringify({ nonce: "bprep2-0786b1f11abc", runOwner: crypto.randomUUID() }),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        'const {desktopFixture}=await import("./test/linux-host/desktop-fixture");const f=await desktopFixture();await f.close();console.log("fresh-owner-ok")',
      ],
      { cwd: process.cwd(), windowsHide: true, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: fresh } },
    )
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("fresh-owner-ok\n")
    expect(await new Response(child.stderr).text()).toBe("")
  } finally {
    if (!fresh.startsWith(parent + path.sep)) throw Error("CLEANUP_SCOPE")
    await fs.rm(fresh, { recursive: true })
  }
})
