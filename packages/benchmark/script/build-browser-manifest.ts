import { createHash } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../src/campaign/canonical"
import { browserBuildSha256, type BrowserReleaseFile } from "../src/evaluator/browser-runtime"

const [rootInput, helperInput, browserExecutableInput] = process.argv.slice(2)
if (!rootInput || !helperInput || !browserExecutableInput) {
  throw new TypeError("TASK24_BROWSER_MANIFEST_ARGUMENT_INVALID")
}
const root = path.resolve(rootInput)
if (!/^D:\\/i.test(root) || fsSync.realpathSync.native(root) !== root) {
  throw new TypeError("TASK24_BROWSER_MANIFEST_ROOT_INVALID")
}
const browserExecutableFile = relativeFile(root, browserExecutableInput)
const helperFile = relativeFile(root, helperInput)
const files = await collect(root)
for (const required of ["node.exe", helperFile, browserExecutableFile]) {
  if (!files.some((entry) => entry.path === required)) throw new TypeError("TASK24_BROWSER_MANIFEST_ENTRY_MISSING")
}
const unsigned = {
  schemaVersion: 1 as const,
  protocolVersion: 1 as const,
  nodeFile: "node.exe",
  helperFile,
  browserExecutableFile,
  files,
}
const buildSha256 = browserBuildSha256(unsigned)
await fs.writeFile(
  path.join(root, "task24-browser-runtime.manifest.json"),
  canonicalJson({ ...unsigned, buildSha256 }) + "\n",
  { encoding: "utf8", flag: "wx" },
)
process.stdout.write(buildSha256 + "\n")

async function collect(directory: string): Promise<readonly BrowserReleaseFile[]> {
  const result: BrowserReleaseFile[] = []
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const stat = await fs.lstat(absolute)
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new TypeError("TASK24_BROWSER_RELEASE_LINK_INVALID")
      if (entry.isDirectory()) {
        if (fsSync.realpathSync.native(absolute) !== absolute)
          throw new TypeError("TASK24_BROWSER_RELEASE_LINK_INVALID")
        await visit(absolute)
        continue
      }
      if (!entry.isFile() || stat.nlink !== 1) throw new TypeError("TASK24_BROWSER_RELEASE_FILE_INVALID")
      const bytes = await fs.readFile(absolute)
      result.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      })
    }
  }
  await visit(directory)
  return Object.freeze(result.toSorted((left, right) => left.path.localeCompare(right.path)))
}

function relativeFile(parent: string, value: string): string {
  const absolute = path.resolve(value)
  const relative = path.relative(parent, absolute)
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !fsSync.lstatSync(absolute).isFile()
  ) {
    throw new TypeError("TASK24_BROWSER_EXECUTABLE_INVALID")
  }
  return relative.split(path.sep).join("/")
}
