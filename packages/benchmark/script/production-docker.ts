import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { callProductionCommandBridge, ProductionBridgeConnection } from "../src/sandbox/production-command-http"
import { canonicalJson } from "../src/campaign/canonical"

async function configIdentity(file: string) {
  if ((await fs.realpath(file)) !== file) throw Error("alias")
  const stat = await fs.lstat(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 1024n) throw Error("config")
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtime: String(stat.birthtimeNs),
    sha256: new Bun.CryptoHasher("sha256").update(await fs.readFile(file)).digest("hex"),
  }
}

// A private, standalone Docker CLI-shaped client; it never starts Docker/WSL
// locally and cannot select another controller endpoint from argv or env.
let stage = "CONFIG"
try {
  if (!/^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|toolchain)\\/.test(process.execPath)) throw Error("root")
  const file = path.join(path.dirname(process.execPath), "production-bridge.json")
  const identity = await configIdentity(file)
  if ((await fs.stat(file)).size > 1024) throw Error("config")
  const connection = Schema.decodeUnknownSync(ProductionBridgeConnection)(JSON.parse(await fs.readFile(file, "utf8")), {
    onExcessProperty: "error",
  })
  if (connection.expiresAt <= Date.now() || connection.expiresAt > Date.now() + 3600000) throw Error("expiry")
  const chunks: Uint8Array[] = []
  stage = "STDIN"
  let bytes = 0
  for await (const chunk of Bun.stdin.stream()) {
    bytes += chunk.length
    if (bytes > 8388608) throw Error("stdin")
    chunks.push(chunk)
  }
  if (canonicalJson(await configIdentity(file)) !== canonicalJson(identity)) throw Error("identity")
  stage = "REQUEST"
  const result = await callProductionCommandBridge({
    ...connection,
    argv: process.argv.slice(2),
    ...(bytes ? { stdin: Buffer.concat(chunks) } : {}),
  })
  if (canonicalJson(await configIdentity(file)) !== canonicalJson(identity)) throw Error("identity")
  stage = "OUTPUT"
  if (result.stdout.length) await Bun.write(Bun.stdout, result.stdout)
  if (result.stderr.length) await Bun.write(Bun.stderr, result.stderr)
  // The production Docker adapter has no side channel for a bridge truncation.
  // Fail closed instead of returning an apparently successful bounded log.
  process.exitCode = result.truncated ? 125 : result.exit
} catch (cause) {
  await Bun.write(
    Bun.stderr,
    (cause instanceof Error && /^TASK24_[A-Z0-9_]{1,96}$/.test(cause.message)
      ? cause.message
      : `TASK24_PRODUCTION_CLIENT_${stage}_FAILED`) + "\n",
  )
  process.exitCode = 125
}
