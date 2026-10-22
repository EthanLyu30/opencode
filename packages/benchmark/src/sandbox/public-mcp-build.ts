import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { canonicalJson } from "../campaign/canonical"
import { directRoot } from "../corpus/evaluation-bundle"
import { freeze } from "../corpus/evaluation-profile"
import { fileIdentity } from "./storage"
import { requireDPath } from "./contracts"

/** A new immutable packaging directory; never overwrite an existing release or deployment. */
export async function buildPublicMcpExecutable(input: { outputRoot: string }) {
  const root = input.outputRoot
  if (!/^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|toolchain)\\[^\\]+(?:\\.*)?$/.test(root))
    throw new TypeError("TASK24_PUBLIC_MCP_BUILD_ROOT")
  requireDPath(root)
  if (process.platform !== "win32" || process.arch !== "x64") throw new TypeError("TASK24_PUBLIC_MCP_BUILD_PLATFORM")
  await directRoot(path.dirname(root))
  const compiler = await fileIdentity(process.execPath)
  const entry = fileURLToPath(new URL("../../script/public-mcp.ts", import.meta.url))
  const source = await fileIdentity(entry)
  await fs.mkdir(root)
  await fs.writeFile(
    path.join(root, "owner.json"),
    canonicalJson({ purpose: "task24-public-mcp-packaging", source, compiler }),
    { flag: "wx" },
  )
  const compile = freeze({
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadPackageJson: false,
    autoloadTsconfig: false,
  })
  const output = path.join(root, "public-mcp.exe")
  const result = await Bun.build({ entrypoints: [entry], target: "bun", compile: { ...compile, outfile: output } })
  if (
    !result.success ||
    result.outputs.length !== 1 ||
    result.outputs[0]?.path !== output ||
    canonicalJson(await fileIdentity(process.execPath)) !== canonicalJson(compiler) ||
    canonicalJson(await fileIdentity(entry)) !== canonicalJson(source)
  )
    throw new TypeError("TASK24_PUBLIC_MCP_BUILD_FAILED")
  const executable = await fileIdentity(output)
  const record = freeze({ schemaVersion: 2, kind: "public-mcp-executable", compiler, source, compile, executable })
  await fs.writeFile(path.join(root, "build-record.json"), canonicalJson(record), { flag: "wx" })
  return { executable, record }
}
