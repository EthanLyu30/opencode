export * as HostRootPolicy from "./host-root-policy"

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const systemSid = "S-1-5-18"
const administratorsSid = "S-1-5-32-544"
const fixedPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const dangerousRights = new Set<Right>([
  "generic_all",
  "generic_write",
  "write_data",
  "append_data",
  "write_ea",
  "write_attributes",
  "delete",
  "delete_child",
  "write_dac",
  "write_owner",
])

export type Right =
  | "generic_all"
  | "generic_write"
  | "write_data"
  | "append_data"
  | "write_ea"
  | "write_attributes"
  | "delete"
  | "delete_child"
  | "write_dac"
  | "write_owner"
  | "read"
  | "execute"

export interface Ace {
  readonly sid: string
  readonly allow: boolean
  readonly inherited: boolean
  readonly rights: readonly Right[]
}

export interface AclSnapshot {
  readonly currentUserSid: string
  readonly ownerSid: string
  readonly protected: boolean
  readonly aces: readonly Ace[]
}

export type Probe = (canonicalRoot: string) => AclSnapshot

export interface Roots {
  readonly hostRoot: string
  readonly evidenceRoot: string
  readonly browserRoot: string
  readonly tempRoot: string
}

export interface Policy {
  readonly roots: Roots
  readonly verifyHostRoot: (canonicalHostRoot: string) => void
  readonly verifyEvidenceRoot: (canonicalEvidenceRoot: string) => void
}

export interface ProbeInvocation {
  readonly executable: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface ProbeResult {
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
}

export function make(input: Roots & { readonly workspaceRoots?: readonly string[]; readonly probe: Probe }): Policy {
  const roots = canonicalRoots(input)
  const workspaces = (input.workspaceRoots ?? []).map(canonicalRoot)
  if (workspaces.some((workspace) => overlap(workspace, roots.hostRoot))) {
    throw new TypeError("Workflow host roots overlap a workspace-controlled path")
  }

  const verifyAll = () => {
    const current = canonicalRoots(roots)
    if (Object.entries(roots).some(([name, value]) => Reflect.get(current, name) !== value)) {
      throw new TypeError("Workflow host root identity changed")
    }
    for (const root of Object.values(current)) verifyAcl(root, input.probe(root))
  }
  verifyAll()

  return Object.freeze({
    roots: Object.freeze({ ...roots }),
    verifyHostRoot: (canonicalHostRoot: string) => {
      if (canonicalHostRoot !== roots.hostRoot) throw new TypeError("Workflow host root policy target changed")
      verifyAll()
    },
    verifyEvidenceRoot: (canonicalEvidenceRoot: string) => {
      if (canonicalEvidenceRoot !== roots.evidenceRoot)
        throw new TypeError("Workflow evidence root policy target changed")
      verifyAll()
    },
  })
}

export function productionProbe(input: {
  readonly tempRoot: string
  readonly run?: (invocation: ProbeInvocation) => ProbeResult
}): Probe {
  const tempRoot = canonicalRoot(input.tempRoot)
  const run =
    input.run ??
    ((invocation: ProbeInvocation) => {
      const result = spawnSync(invocation.executable, [...invocation.argv], {
        env: { ...invocation.env },
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      })
      return { exit: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
    })
  return (canonicalRoot) => {
    const target = requireCanonical(canonicalRoot)
    const result = run({
      executable: fixedPowerShell,
      argv: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript, target],
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: tempRoot, TMP: tempRoot },
    })
    if (result.exit !== 0 || result.stderr.trim() !== "") throw new TypeError("Workflow ACL probe failed closed")
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (cause) {
      throw new TypeError("Workflow ACL probe returned malformed output", { cause })
    }
    return decodeSnapshot(parsed)
  }
}

function canonicalRoots(input: Roots): Roots {
  const roots = {
    hostRoot: canonicalRoot(input.hostRoot),
    evidenceRoot: canonicalRoot(input.evidenceRoot),
    browserRoot: canonicalRoot(input.browserRoot),
    tempRoot: canonicalRoot(input.tempRoot),
  }
  if (
    !strictlyContains(roots.hostRoot, roots.evidenceRoot) ||
    !strictlyContains(roots.hostRoot, roots.browserRoot) ||
    !strictlyContains(roots.hostRoot, roots.tempRoot) ||
    overlap(roots.evidenceRoot, roots.browserRoot) ||
    overlap(roots.evidenceRoot, roots.tempRoot) ||
    overlap(roots.browserRoot, roots.tempRoot)
  ) {
    throw new TypeError("Workflow host subroots must be isolated descendants")
  }
  return roots
}

function canonicalRoot(value: string) {
  if (!path.win32.isAbsolute(value) || !/^D:\\/i.test(value) || unsafeWindowsPath(value)) {
    throw new TypeError("Workflow host roots must be canonical D-drive paths")
  }
  return requireCanonical(value)
}

function requireCanonical(value: string) {
  const lexical = path.resolve(value)
  const canonical = fs.realpathSync.native(lexical)
  const stat = fs.lstatSync(lexical)
  if (canonical !== lexical || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Workflow host roots must not be aliases or reparse points")
  }
  return canonical
}

function verifyAcl(root: string, snapshot: AclSnapshot) {
  if (
    !isSid(snapshot.currentUserSid) ||
    !isSid(snapshot.ownerSid) ||
    !snapshot.protected ||
    !Array.isArray(snapshot.aces)
  ) {
    throw new TypeError(`Workflow host ACL is unsupported for ${root}`)
  }
  const trusted = new Set([snapshot.currentUserSid, systemSid, administratorsSid])
  if (!trusted.has(snapshot.ownerSid)) throw new TypeError("Workflow host ACL owner is not trusted")
  let currentWritable = false
  for (const ace of snapshot.aces) {
    if (
      ace === null ||
      typeof ace !== "object" ||
      !isSid(ace.sid) ||
      typeof ace.allow !== "boolean" ||
      typeof ace.inherited !== "boolean" ||
      !Array.isArray(ace.rights) ||
      ace.rights.some((right: unknown) => !isRight(right))
    ) {
      throw new TypeError("Workflow host ACL contains an unsupported ACE")
    }
    if (ace.inherited) throw new TypeError("Workflow host ACL must use protected explicit inheritance")
    const grantsWrite = ace.allow && ace.rights.some(isDangerousRight)
    if (!grantsWrite) continue
    if (!trusted.has(ace.sid)) throw new TypeError("Workflow host ACL grants write authority to an untrusted SID")
    if (ace.sid === snapshot.currentUserSid) currentWritable = true
  }
  if (!currentWritable) throw new TypeError("Workflow host ACL is not writable by the trusted current identity")
}

const allRights = new Set<Right>([...dangerousRights, "read", "execute"])

function decodeSnapshot(value: unknown): AclSnapshot {
  if (value === null || typeof value !== "object") throw new TypeError("Workflow ACL snapshot is not an object")
  const currentUserSid = Reflect.get(value, "currentUserSid")
  const ownerSid = Reflect.get(value, "ownerSid")
  const protectedAcl = Reflect.get(value, "protected")
  const rawAces = Reflect.get(value, "aces")
  if (
    typeof currentUserSid !== "string" ||
    typeof ownerSid !== "string" ||
    typeof protectedAcl !== "boolean" ||
    !Array.isArray(rawAces)
  ) {
    throw new TypeError("Workflow ACL snapshot has an invalid shape")
  }
  const aces = rawAces.map((ace): Ace => {
    if (ace === null || typeof ace !== "object") throw new TypeError("Workflow ACL ACE has an invalid shape")
    const sid = Reflect.get(ace, "sid")
    const allow = Reflect.get(ace, "allow")
    const inherited = Reflect.get(ace, "inherited")
    const rawRights = Reflect.get(ace, "rights")
    const mask = Reflect.get(ace, "mask")
    if (typeof sid !== "string" || typeof allow !== "boolean" || typeof inherited !== "boolean") {
      throw new TypeError("Workflow ACL ACE has invalid identity fields")
    }
    const rights = Array.isArray(rawRights)
      ? rawRights
      : typeof mask === "number" && Number.isInteger(mask)
        ? rightsFromMask(mask)
        : undefined
    if (rights === undefined) {
      throw new TypeError("Workflow ACL ACE has invalid rights")
    }
    const decodedRights: Right[] = []
    for (const right of rights) {
      if (!isRight(right)) throw new TypeError("Workflow ACL ACE has invalid rights")
      decodedRights.push(right)
    }
    return { sid, allow, inherited, rights: decodedRights }
  })
  return { currentUserSid, ownerSid, protected: protectedAcl, aces }
}

function rightsFromMask(value: number): Right[] {
  const mask = value >>> 0
  const rights: Right[] = []
  const add = (right: Right, bits: number) => {
    if ((mask & bits) !== 0) rights.push(right)
  }
  add("generic_all", 0x10000000)
  add("generic_write", 0x40000000)
  add("write_data", 0x00000002)
  add("append_data", 0x00000004)
  add("write_ea", 0x00000010)
  add("delete_child", 0x00000040)
  add("write_attributes", 0x00000100)
  add("delete", 0x00010000)
  add("write_dac", 0x00040000)
  add("write_owner", 0x00080000)
  if ((mask & 0x00020089) !== 0) rights.push("read")
  if ((mask & 0x00000020) !== 0) rights.push("execute")
  return rights
}

function isRight(value: unknown): value is Right {
  return typeof value === "string" && rightNames.has(value)
}

function isDangerousRight(value: unknown): value is Right {
  return isRight(value) && dangerousRights.has(value)
}

const rightNames: ReadonlySet<string> = allRights

function isSid(value: string) {
  return /^S-1-(?:[0-9]+-)+[0-9]+$/i.test(value)
}

function unsafeWindowsPath(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return true
  return value
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function strictlyContains(parent: string, child: string) {
  return parent !== child && contains(parent, child)
}

function overlap(left: string, right: string) {
  return contains(left, right) || contains(right, left)
}

const aclScript = String.raw`$ErrorActionPreference = 'Stop'
$target = $args[0]
$acl = Get-Acl -LiteralPath $target
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$aces = @($acl.Access | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    allow = $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
    inherited = $_.IsInherited
    mask = [int]$_.FileSystemRights
  }
})
[pscustomobject]@{
  currentUserSid = $current
  ownerSid = $owner
  protected = $acl.AreAccessRulesProtected
  aces = $aces
} | ConvertTo-Json -Depth 5 -Compress`
