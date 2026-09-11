export * as ProductionHostRuntime from "./production-host-runtime"

import { DockerConfig } from "./docker-config"
import { HostRootPolicy } from "./host-root-policy"
import { ProductionHostRoots } from "./production-host-roots"

export interface Runtime {
  readonly contract: ProductionHostRoots.Contract
  readonly dockerConfig: DockerConfig.Config
}

export function load(
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly probe?: HostRootPolicy.Probe; readonly workspaceRoots?: readonly string[] } = {},
): Runtime {
  const tempRoot = environment.OPENCODE_WORKFLOW_HOST_TEMP
  if (tempRoot === undefined || tempRoot.length === 0) throw new TypeError("OPENCODE_WORKFLOW_HOST_TEMP is required")
  const contract = ProductionHostRoots.fromEnvironment(environment, {
    probe: options.probe ?? HostRootPolicy.productionProbe({ tempRoot }),
    workspaceRoots: options.workspaceRoots,
  })
  return Object.freeze({ contract, dockerConfig: DockerConfig.fromProductionHostRoots(contract) })
}

export function unavailableDockerConfig(): DockerConfig.Config {
  return DockerConfig.fromEnvironment(Object.freeze({}))
}
