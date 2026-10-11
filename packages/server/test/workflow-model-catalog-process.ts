import type { Subprocess } from "bun"

export async function stopOwnedProbe(child: Subprocess<"ignore", "pipe", "pipe">, workerPID?: number) {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (workerPID !== undefined && (!Number.isSafeInteger(workerPID) || workerPID <= 0 || workerPID === process.pid))
    throw new Error("Catalogue probe worker identity invalid")
  if (child.exitCode === null) {
    if (process.platform === "win32") {
      // This still-live handle owns the entire launcher tree; never infer worker death from wrapper exit.
      const killer = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          killer.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Catalogue probe termination deadline")), 5_000)
          }),
        ])
      } finally {
        clearTimeout(timer)
        if (killer.exitCode === null) killer.kill()
      }
    } else child.kill()
  }
  const limit = Date.now() + 5_000
  while (child.exitCode === null || (workerPID !== undefined && alive(workerPID))) {
    if (Date.now() >= limit) throw new Error("Catalogue probe worker did not exit")
    await Bun.sleep(10)
  }
  await child.exited
}
