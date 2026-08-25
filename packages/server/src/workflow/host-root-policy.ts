export * as HostRootPolicy from "./host-root-policy"

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const systemSid = "S-1-5-18"
const administratorsSid = "S-1-5-32-544"
const fixedPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const genericAll = 0x10000000
const genericWrite = 0x40000000
const concreteWriteMask =
  0x00000002 | // FILE_WRITE_DATA / FILE_ADD_FILE
  0x00000004 | // FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
  0x00000010 | // FILE_WRITE_EA
  0x00000040 | // FILE_DELETE_CHILD
  0x00000100 | // FILE_WRITE_ATTRIBUTES
  0x00010000 | // DELETE
  0x00040000 | // WRITE_DAC
  0x00080000 // WRITE_OWNER

export interface Ace {
  readonly sid: string
  readonly allow: boolean
  readonly inherited: boolean
  readonly mask: number
}

export interface AclSnapshot {
  readonly currentUserSid: string
  readonly currentIdentitySids: readonly string[]
  readonly ownerSid: string
  readonly protected: boolean
  readonly descriptorSddl: string
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
  readonly verifyTempRoot: (canonicalTempRoot: string) => void
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

  const fingerprints = new Map<string, string>()
  const identities = new Map<string, string>()
  for (const root of Object.values(roots)) {
    const snapshot = input.probe(root)
    verifyAcl(root, snapshot)
    fingerprints.set(root, fingerprint(snapshot))
    identities.set(root, rootIdentity(root))
  }

  const verifyOne = (expected: string, actual: string, target: string) => {
    if (actual !== expected) throw new TypeError(`Workflow ${target} policy target changed`)
    if (requireCanonical(expected) !== expected || rootIdentity(expected) !== identities.get(expected)) {
      throw new TypeError(`Workflow ${target} root identity changed`)
    }
    const snapshot = input.probe(expected)
    verifyAcl(expected, snapshot)
    if (fingerprint(snapshot) !== fingerprints.get(expected)) {
      throw new TypeError(`Workflow ${target} ACL descriptor changed`)
    }
  }

  return Object.freeze({
    roots: Object.freeze({ ...roots }),
    verifyHostRoot: (canonicalHostRoot: string) => verifyOne(roots.hostRoot, canonicalHostRoot, "host"),
    verifyEvidenceRoot: (canonicalEvidenceRoot: string) =>
      verifyOne(roots.evidenceRoot, canonicalEvidenceRoot, "evidence"),
    verifyTempRoot: (canonicalTempRoot: string) => verifyOne(roots.tempRoot, canonicalTempRoot, "temp"),
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
    !Array.isArray(snapshot.currentIdentitySids) ||
    snapshot.currentIdentitySids.length === 0 ||
    snapshot.currentIdentitySids.some((sid: unknown) => typeof sid !== "string" || !isSid(sid)) ||
    !snapshot.currentIdentitySids.includes(snapshot.currentUserSid) ||
    !isSid(snapshot.ownerSid) ||
    !snapshot.protected ||
    typeof snapshot.descriptorSddl !== "string" ||
    snapshot.descriptorSddl.length === 0 ||
    snapshot.descriptorSddl.length > 65_536 ||
    !Array.isArray(snapshot.aces)
  ) {
    throw new TypeError(`Workflow host ACL is unsupported for ${root}`)
  }
  const trusted = new Set([snapshot.currentUserSid, systemSid, administratorsSid])
  if (!trusted.has(snapshot.ownerSid)) throw new TypeError("Workflow host ACL owner is not trusted")
  const identity = new Set(snapshot.currentIdentitySids)
  let allowed = 0
  let denied = 0
  for (const ace of snapshot.aces) {
    if (
      ace === null ||
      typeof ace !== "object" ||
      !isSid(ace.sid) ||
      typeof ace.allow !== "boolean" ||
      typeof ace.inherited !== "boolean" ||
      !validMask(ace.mask)
    ) {
      throw new TypeError("Workflow host ACL contains an unsupported ACE")
    }
    if (ace.inherited) throw new TypeError("Workflow host ACL must use protected explicit inheritance")
    const write = dangerousAccess(ace.mask)
    if (ace.allow && write !== 0 && !trusted.has(ace.sid)) {
      throw new TypeError("Workflow host ACL grants write authority to an untrusted SID")
    }
    if (write === 0) continue
    if (!ace.allow && identity.has(ace.sid)) denied = (denied | write) >>> 0
    if (ace.allow && ace.sid === snapshot.currentUserSid) allowed = (allowed | write) >>> 0
  }
  if ((allowed & ~denied) >>> 0 === 0) {
    throw new TypeError("Workflow host ACL lacks an effective direct current-user write grant")
  }
}

function decodeSnapshot(value: unknown): AclSnapshot {
  if (value === null || typeof value !== "object") throw new TypeError("Workflow ACL snapshot is not an object")
  const currentUserSid = Reflect.get(value, "currentUserSid")
  const currentIdentitySids = Reflect.get(value, "currentIdentitySids")
  const ownerSid = Reflect.get(value, "ownerSid")
  const protectedAcl = Reflect.get(value, "protected")
  const descriptorSddl = Reflect.get(value, "descriptorSddl")
  const rawAces = Reflect.get(value, "aces")
  if (
    typeof currentUserSid !== "string" ||
    !Array.isArray(currentIdentitySids) ||
    typeof ownerSid !== "string" ||
    typeof protectedAcl !== "boolean" ||
    typeof descriptorSddl !== "string" ||
    !Array.isArray(rawAces)
  ) {
    throw new TypeError("Workflow ACL snapshot has an invalid shape")
  }
  const aces = rawAces.map((ace): Ace => {
    if (ace === null || typeof ace !== "object") throw new TypeError("Workflow ACL ACE has an invalid shape")
    const sid = Reflect.get(ace, "sid")
    const allow = Reflect.get(ace, "allow")
    const inherited = Reflect.get(ace, "inherited")
    const mask = Reflect.get(ace, "mask")
    if (typeof sid !== "string" || typeof allow !== "boolean" || typeof inherited !== "boolean") {
      throw new TypeError("Workflow ACL ACE has invalid identity fields")
    }
    if (!validMask(mask)) throw new TypeError("Workflow ACL ACE has invalid mask")
    return { sid, allow, inherited, mask }
  })
  return {
    currentUserSid,
    currentIdentitySids: currentIdentitySids.map(String),
    ownerSid,
    protected: protectedAcl,
    descriptorSddl,
    aces,
  }
}

function validMask(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0xffffffff
}

function dangerousAccess(value: number): number {
  const mask = value >>> 0
  let write = mask & concreteWriteMask
  if ((mask & genericAll) !== 0) write |= concreteWriteMask
  if ((mask & genericWrite) !== 0) write |= 0x00000002 | 0x00000004 | 0x00000010 | 0x00000100
  return write >>> 0
}

function fingerprint(snapshot: AclSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        currentUserSid: snapshot.currentUserSid,
        currentIdentitySids: [...snapshot.currentIdentitySids].toSorted(),
        ownerSid: snapshot.ownerSid,
        protected: snapshot.protected,
        descriptorSddl: snapshot.descriptorSddl,
        aces: snapshot.aces.map((ace) => ({ ...ace, mask: ace.mask >>> 0 })),
      }),
    )
    .digest("hex")
}

function rootIdentity(value: string) {
  const stat = fs.lstatSync(value, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Workflow host root identity changed")
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}

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
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$current = $identity.User.Value
$currentSids = @($current, 'S-1-1-0') + @($identity.Groups | ForEach-Object { $_.Value }) | Select-Object -Unique
$owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
$descriptor = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]$sections)
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
  currentIdentitySids = @($currentSids)
  ownerSid = $owner
  protected = $acl.AreAccessRulesProtected
  descriptorSddl = $descriptor
  aces = $aces
} | ConvertTo-Json -Depth 5 -Compress`
