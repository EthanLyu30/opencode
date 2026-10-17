export function spawnWithoutDotenv(
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) {
  return Bun.spawn([process.execPath, "--no-env-file", ...args], { ...options, stdout: "pipe", stderr: "pipe" })
}
