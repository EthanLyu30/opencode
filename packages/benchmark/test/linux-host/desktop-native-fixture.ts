import type { DesktopLaunchSpec } from "../../src/sandbox/desktop/contracts"
import type { DesktopNativeSnapshot } from "../../src/sandbox/desktop/native-query"

/** These are data fixtures, never native transport, console or authority factories. */
export function nativeQueryFixture(spec: DesktopLaunchSpec) {
  const snapshot: DesktopNativeSnapshot = {
    schemaVersion: 1,
    complete: true,
    sampledAt: Date.now(),
    sid: "S-1-5-21-100-200-300-1001",
    profileSID: "S-1-5-21-100-200-300-1001",
    windowsProfile: spec.windowsProfile,
    registration: {
      key: spec.registration.fileID,
      distributionName: "docker-desktop",
      basePath: spec.registration.basePath,
      version: 2,
      build: 230596,
    },
    disks: spec.disks,
    processes: [],
    pipes: [
      "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine",
      "npipe:////./pipe/dockerDesktopEngine",
      "npipe:////./pipe/docker_engine",
    ].map((endpoint) => ({ endpoint, present: false })),
    installedWsl: ["docker-desktop", "Ubuntu-24.04"],
    runningWsl: [],
  }
  return { snapshot, all: Buffer.from("docker-desktop\r\nUbuntu-24.04\r\n", "utf16le"), running: new Uint8Array() }
}

export async function desktopFeature<T>(file: string): Promise<Partial<T>> {
  return import(new URL("../../src/sandbox/desktop/" + file + ".ts", import.meta.url).href).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ERR_MODULE_NOT_FOUND") throw error
    return {}
  })
}
