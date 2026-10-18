import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import { directoryIdentity } from "../storage"
import { canonicalDesktopPath, readDesktopText } from "./compatibility"

const environments = new WeakMap<object, { snapshot: string; identity: string; ownerSha256: string }>()
async function snapshot(temp: string) {
  canonicalDesktopPath(temp)
  const base = /^(D:\\OpenCode-Benchmark\\Task24\\tmp\\(?:bprep1-[^\\]+|desktop-native-[a-f0-9]{32}))(?:\\|$)/i.exec(
    temp,
  )?.[1]
  if (!base) throw new TypeError("TASK24_DESKTOP_PROBE_OWNER")
  const owner = await readDesktopText(path.join(base, "owner.json"), 4096)
  const raw: unknown = JSON.parse(owner.text)
  if (!raw || typeof raw !== "object") throw new TypeError("TASK24_DESKTOP_PROBE_OWNER")
  if (path.basename(base).startsWith("bprep1-")) {
    if (
      Object.keys(raw).sort().join(",") !== "nonce,runOwner" ||
      !("nonce" in raw) ||
      raw.nonce !== "bprep2-0786b1f11abc" ||
      !("runOwner" in raw) ||
      typeof raw.runOwner !== "string" ||
      !/^[a-z0-9-]{8,128}$/.test(raw.runOwner)
    )
      throw new TypeError("TASK24_DESKTOP_PROBE_OWNER")
  } else if (
    Object.keys(raw).sort().join(",") !== "kind,nonce,schemaVersion" ||
    !("kind" in raw) ||
    raw.kind !== "desktop-native-probe" ||
    !("schemaVersion" in raw) ||
    raw.schemaVersion !== 1 ||
    !("nonce" in raw) ||
    raw.nonce !== path.basename(base).slice("desktop-native-".length)
  )
    throw new TypeError("TASK24_DESKTOP_PROBE_OWNER")
  const leaf = temp === base ? owner : await readDesktopText(path.join(temp, "owner.json"), 4096)
  if (leaf.text !== owner.text) throw new TypeError("TASK24_DESKTOP_PROBE_OWNER")
  const parents: Record<string, string> = {}
  for (let current = temp; current !== path.parse(current).root; current = path.dirname(current))
    parents[current] = await directoryIdentity(current)
  return { snapshot: canonicalJson({ temp, owner, leaf, parents }), identity: parents[temp]!, ownerSha256: leaf.sha256 }
}
export async function desktopProbeEnvironment() {
  const temp = canonicalDesktopPath(process.env.TEMP ?? "")
  const proof = await snapshot(temp)
  const env = {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    HOME: temp,
    USERPROFILE: temp,
    APPDATA: temp,
    LOCALAPPDATA: temp,
    TEMP: temp,
    TMP: temp,
    PSModuleAnalysisCachePath: "NUL",
    NODE_DISABLE_COMPILE_CACHE: "1",
    BUN_INSTALL_CACHE_DIR: temp,
  }
  environments.set(env, proof)
  return env
}
export async function revalidateDesktopProbeEnvironment(env: Awaited<ReturnType<typeof desktopProbeEnvironment>>) {
  if (environments.get(env)?.snapshot !== (await snapshot(env.TEMP)).snapshot)
    throw new TypeError("TASK24_DESKTOP_PROBE_OWNER_DRIFT")
}
export function readDesktopProbeRootProof(env: Awaited<ReturnType<typeof desktopProbeEnvironment>>) {
  const proof = environments.get(env)
  if (!proof) throw new TypeError("TASK24_DESKTOP_PROBE_OWNER")
  return { identity: proof.identity, ownerSha256: proof.ownerSha256 }
}
