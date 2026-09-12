import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, win32 } from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "./campaign/canonical"
import { sealCampaign, verifyCampaign, type CampaignVerification } from "./campaign/seal"
import { CampaignID, Sha256, type SealedCampaign } from "./schema"
import { Task24Root, type Task24Layout } from "./root"

const CurrentCampaign = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: CampaignID,
  sha256: Sha256,
})
const exactDecode = { onExcessProperty: "error" as const }

type CurrentCampaign = typeof CurrentCampaign.Type

export interface CliDependencies {
  readonly root: (value: string) => Task24Layout
  readonly readJson: (path: string) => Promise<unknown>
  readonly writeImmutableJson: (path: string, value: unknown) => Promise<void>
  readonly writeCurrentJson: (path: string, value: unknown) => Promise<void>
  readonly seal: (value: unknown) => SealedCampaign
  readonly verify: (value: unknown) => CampaignVerification
  readonly output: (value: unknown) => void
}

function invalidCommand(): never {
  throw new Error("TASK24_COMMAND_INVALID")
}

function parseRoot(argv: readonly string[]): string {
  if (argv.length === 2) return Task24Root.fixed
  if (argv.length !== 4 || argv[2] !== "--root" || argv[3] === undefined) return invalidCommand()
  return argv[3]
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"))
}

function tempPath(path: string): string {
  return `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  const body = canonicalJson(value) + "\n"
  if (existsSync(path)) {
    const current = await readFile(path, "utf8")
    if (current === body) return
    throw new Error("CAMPAIGN_SEAL_CONFLICT")
  }

  await mkdir(dirname(path), { recursive: true })
  const staging = tempPath(path)
  try {
    await writeFile(staging, body, { encoding: "utf8", flag: "wx" })
    await rename(staging, path)
  } finally {
    await rm(staging, { force: true })
  }
}

async function writeCurrentJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const staging = tempPath(path)
  try {
    await writeFile(staging, canonicalJson(value) + "\n", { encoding: "utf8", flag: "wx" })
    await rename(staging, path)
  } finally {
    await rm(staging, { force: true })
  }
}

const defaults: CliDependencies = {
  root: (value) => Task24Root.ensure(value),
  readJson,
  writeImmutableJson,
  writeCurrentJson,
  seal: sealCampaign,
  verify: verifyCampaign,
  output: (value) => process.stdout.write(canonicalJson(value) + "\n"),
}

function campaignPath(layout: Task24Layout, id: string): string {
  return win32.join(layout.runs, id, "campaign.sealed.json")
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = defaults): Promise<void> {
  if (argv[0] !== "campaign" || (argv[1] !== "seal" && argv[1] !== "verify")) invalidCommand()
  const layout = dependencies.root(parseRoot(argv))
  const pointerPath = win32.join(layout.runs, "current-campaign.json")

  if (argv[1] === "seal") {
    const candidate = await dependencies.readJson(win32.join(layout.runs, "preregistration.candidate.json"))
    const sealed = dependencies.seal(candidate)
    await dependencies.writeImmutableJson(campaignPath(layout, sealed.id), sealed)
    const pointer: CurrentCampaign = { schemaVersion: 1, id: sealed.id, sha256: sealed.sha256 }
    await dependencies.writeCurrentJson(pointerPath, pointer)
    dependencies.output({ command: "campaign.seal", id: sealed.id, sha256: sealed.sha256 })
    return
  }

  const pointer = Schema.decodeUnknownSync(CurrentCampaign)(await dependencies.readJson(pointerPath), exactDecode)
  const value = await dependencies.readJson(campaignPath(layout, pointer.id))
  const result = dependencies.verify(value)
  if (!result.ok) throw new Error(result.reason)
  if (result.campaign.id !== pointer.id || result.campaign.sha256 !== pointer.sha256) {
    throw new Error("CAMPAIGN_POINTER_MISMATCH")
  }
  dependencies.output({ command: "campaign.verify", id: pointer.id, sha256: pointer.sha256, ok: true })
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : "TASK24_UNKNOWN_ERROR"
    process.stderr.write(message + "\n")
    process.exitCode = 1
  }
}
