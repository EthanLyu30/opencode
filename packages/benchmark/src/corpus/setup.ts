import { lstat, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../root"
import {
  decodeDatasetSource,
  publishSourceLock,
  resolveOfficialUpstream,
  sealSourceLock,
  stageOfficialUpstream,
} from "./source-lock"

interface SetupArguments {
  readonly root: string
  readonly datasets: string
}

export async function setupSources(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv)
  const layout = Task24Root.ensure(args.root)
  const datasetInput = path.resolve(args.datasets)
  const datasetStat = await lstat(datasetInput)
  if (!datasetStat.isFile() || datasetStat.isSymbolicLink()) {
    throw new TypeError("Dataset source candidate must be a direct ordinary file")
  }
  const datasetPath = await realpath(datasetInput)
  if (datasetPath.toLowerCase() !== datasetInput.toLowerCase() || !strictDescendant(layout.runs, datasetPath)) {
    throw new TypeError("Dataset source candidate must be inside the Task24 runs root")
  }
  const input: unknown = JSON.parse(await readFile(datasetPath, "utf8"))
  if (!Array.isArray(input) || input.length !== 2) {
    throw new TypeError("Task24 requires exactly two dataset source candidates")
  }
  const datasets = input.map(decodeDatasetSource)
  if (!datasets.some((source) => source.id === "design2code-hard")) {
    throw new TypeError("Design2Code-Hard source candidate is required")
  }
  if (!datasets.some((source) => source.id === "swebench-multimodal-js")) {
    throw new TypeError("SWE-bench Multimodal JavaScript source candidate is required")
  }

  const upstream = await resolveOfficialUpstream()
  const staged = await stageOfficialUpstream({ layout, source: upstream })
  const stagingRoot = path.dirname(path.dirname(staged.checkout))
  if (!strictDescendant(layout.tmp, stagingRoot)) throw new TypeError("Unsafe Task24 source staging cleanup")
  try {
    const license = await findLicense(staged.checkout)
    if (!/mit license/i.test(await readFile(license, "utf8"))) {
      throw new TypeError("Official OpenCode checkout does not contain its expected MIT license")
    }
    const lock = sealSourceLock({ schemaVersion: 1, upstream, datasets })
    await publishSourceLock({ layout, lock, stagedCheckout: staged.checkout })
    process.stdout.write(JSON.stringify({ command: "sources.setup", sha256: lock.sha256 }) + "\n")
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

function parseArguments(argv: readonly string[]): SetupArguments {
  let root = Task24Root.fixed
  let datasets: string | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new TypeError("TASK24_SOURCE_SETUP_ARGUMENT_INVALID")
    if (flag === "--root") root = value
    else if (flag === "--datasets") datasets = value
    else throw new TypeError("TASK24_SOURCE_SETUP_ARGUMENT_INVALID")
  }
  if (datasets === undefined) throw new TypeError("--datasets is required")
  return { root, datasets }
}

async function findLicense(checkout: string): Promise<string> {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"] as const) {
    const candidate = path.join(checkout, name)
    if (await Bun.file(candidate).exists()) return candidate
  }
  throw new TypeError("Official OpenCode license file is missing")
}

function strictDescendant(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative.length > 0 && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}

if (import.meta.main) {
  try {
    await setupSources(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write((cause instanceof Error ? cause.message : "TASK24_SOURCE_SETUP_FAILED") + "\n")
    process.exitCode = 1
  }
}
