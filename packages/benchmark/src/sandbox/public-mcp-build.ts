import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { canonicalJson } from "../campaign/canonical"
import { directRoot } from "../corpus/evaluation-bundle"
import { freeze } from "../corpus/evaluation-profile"
import { fileIdentity } from "./storage"
import { requireDPath } from "./contracts"
import { Schema } from "effect"
import { ProductionBridgeConnection } from "./production-command-http"
import { makeProcessRunner } from "./docker"

export async function buildProductionDockerExecutable(input: {
  outputRoot: string
  connection:
    | typeof ProductionBridgeConnection.Type
    | { host: string; port: number; capability: string; expiresAt: number }
}) {
  const connection = Schema.decodeUnknownSync(ProductionBridgeConnection)(input.connection, {
    onExcessProperty: "error",
  })
  if (connection.expiresAt <= Date.now() || connection.expiresAt > Date.now() + 3600000)
    throw new TypeError("TASK24_PRODUCTION_BRIDGE_EXPIRY")
  return buildExecutable(input.outputRoot, "production-docker", "../../script/production-docker.ts", connection)
}

/** A new immutable packaging directory; never overwrite an existing release or deployment. */
export async function buildPublicMcpExecutable(input: { outputRoot: string }) {
  return buildExecutable(input.outputRoot, "public-mcp", "../../script/public-mcp.ts")
}

export async function buildBrowserProtocolHelper(input: { outputRoot: string }) {
  return buildExecutable(input.outputRoot, "browser-protocol-v2", "../../script/linux-browser-helper.ts")
}

async function buildExecutable(
  root: string,
  kind: "public-mcp" | "production-docker" | "browser-protocol-v2",
  relative: string,
  connection?: typeof ProductionBridgeConnection.Type,
) {
  if (!/^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|toolchain)\\[^\\]+(?:\\.*)?$/.test(root))
    throw new TypeError("TASK24_PUBLIC_MCP_BUILD_ROOT")
  requireDPath(root)
  if (process.platform !== "win32" || process.arch !== "x64") throw new TypeError("TASK24_PUBLIC_MCP_BUILD_PLATFORM")
  await directRoot(path.dirname(root))
  const compiler = await fileIdentity(process.execPath)
  const entry = fileURLToPath(new URL(relative, import.meta.url))
  const source = await fileIdentity(entry)
  await fs.mkdir(root)
  await fs.writeFile(
    path.join(root, "owner.json"),
    canonicalJson({ purpose: `task24-${kind}-packaging`, source, compiler }),
    { flag: "wx" },
  )
  const compile = freeze({
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadPackageJson: false,
    autoloadTsconfig: false,
  })
  const output = path.join(
    root,
    kind === "browser-protocol-v2" ? "browser-helper.cjs" : kind === "public-mcp" ? "public-mcp.exe" : "docker.exe",
  )
  const options =
    kind === "browser-protocol-v2"
      ? { entrypoints: [entry], target: "node", format: "cjs", outdir: root, naming: "browser-helper.cjs" }
      : { entrypoints: [entry], target: "bun", compile: { ...compile, outfile: output } }
  // Bun 1.3.14 can reuse stale module descriptors when a long-lived controller
  // has already loaded the production graph. Both helpers get a fresh pinned
  // compiler; their entrypoints, output layout and autoload policy stay intact.
  const result = await isolatedCompile()
  async function isolatedCompile() {
    const config = path.join(root, "compiler.toml")
    await fs.writeFile(config, "# Owned empty compiler configuration\n", { flag: "wx" })
    const env = Object.fromEntries(
      ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    )
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      APPDATA: root,
      LOCALAPPDATA: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
      XDG_DATA_HOME: root,
      XDG_STATE_HOME: root,
      TEMP: root,
      TMP: root,
      TMPDIR: root,
      BUN_INSTALL_CACHE_DIR: root,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      NODE_DISABLE_COMPILE_CACHE: "1",
      PATH: path.dirname(compiler.path),
    })
    const runner = makeProcessRunner({ executable: compiler.path, argvPrefix: [], cwd: root, env })
    const script = `const r=await Bun.build(${JSON.stringify(options)});process.stdout.write(JSON.stringify({success:r.success,outputs:r.outputs.map(v=>({path:v.path}))}));process.exitCode=r.success?0:1`
    const compiled = await runner.execute({
      argv: ["--no-env-file", `--config=${config}`, "--eval", script],
      timeoutMs: 120000,
      maxStdoutBytes: 16384,
      maxStderrBytes: 16384,
      signal: new AbortController().signal,
    })
    if (!compiled.started || compiled.exitCode !== 0 || compiled.cleanupUncertain || compiled.truncated)
      throw new TypeError("TASK24_PUBLIC_MCP_BUILD_FAILED")
    return Schema.decodeUnknownSync(
      Schema.Struct({ success: Schema.Boolean, outputs: Schema.Array(Schema.Struct({ path: Schema.String })) }),
    )(JSON.parse(Buffer.from(compiled.stdout).toString("utf8")), { onExcessProperty: "error" })
  }
  const assets = result.outputs.filter((file) => file.path !== output)
  if (
    !result.success ||
    result.outputs.filter((file) => file.path === output).length !== 1 ||
    (kind !== "browser-protocol-v2" && assets.length !== 0) ||
    assets.length > 1 ||
    assets.some(
      (file) => path.dirname(file.path) !== root || !/^appIcon-[a-z0-9]+\.png$/.test(path.basename(file.path)),
    ) ||
    canonicalJson(await fileIdentity(process.execPath)) !== canonicalJson(compiler) ||
    canonicalJson(await fileIdentity(entry)) !== canonicalJson(source)
  )
    throw new TypeError("TASK24_PUBLIC_MCP_BUILD_FAILED")
  const assetIdentities = await Promise.all(
    assets.map(async (file) => {
      const stat = await fs.lstat(file.path)
      if (stat.size > 65536 || stat.size < 8) throw new TypeError("TASK24_PUBLIC_MCP_BUILD_FAILED")
      const bytes = await fs.readFile(file.path)
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new TypeError("TASK24_PUBLIC_MCP_BUILD_FAILED")
      return fileIdentity(file.path)
    }),
  )
  const executable = await fileIdentity(output)
  if (connection)
    await fs.writeFile(path.join(root, "production-bridge.json"), canonicalJson(connection), { flag: "wx" })
  const record = freeze({
    schemaVersion: 2,
    kind: `${kind}-executable`,
    compiler,
    source,
    // Not a complete dependency/source-tree attestation or a readiness receipt.
    provenanceScope: "entrypoint-compiler-output",
    compile,
    executable,
    ...(kind === "browser-protocol-v2" ? { assets: assetIdentities } : {}),
    ...(connection ? { connection: await fileIdentity(path.join(root, "production-bridge.json")) } : {}),
  })
  await fs.writeFile(path.join(root, "build-record.json"), canonicalJson(record), { flag: "wx" })
  return { executable, record }
}
