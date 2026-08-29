export * as SessionAdmission from "./admission"

import { DateTime } from "effect"
import path from "node:path"
import { AgentV2 } from "../agent"
import { InstallationVersion } from "../installation/version"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { ProviderV2 } from "../provider"
import { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"
import { Slug } from "../util/slug"
import { WorkspaceV2 } from "../workspace"

export interface PrepareInput {
  readonly id: SessionSchema.ID
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly location: Location.Ref
  readonly project: ProjectV2.Resolved
  readonly visibility: SessionSchema.Visibility
  readonly timestamp: number
}

export function prepare(input: PrepareInput) {
  const legacy = SessionV1.SessionInfo.make({
    id: input.id,
    slug: Slug.create(input.id),
    version: InstallationVersion,
    projectID: input.project.id,
    directory: input.location.directory,
    path: path.relative(input.project.directory, input.location.directory).replaceAll("\\", "/"),
    workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
    title: `New session - ${new Date(input.timestamp).toISOString()}`,
    agent: input.agent,
    model: input.model
      ? {
          id: ModelV2.ID.make(input.model.id),
          providerID: input.model.providerID,
          variant: input.model.variant,
        }
      : undefined,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: input.timestamp, updated: input.timestamp },
  })
  const info = SessionSchema.Info.make({
    id: input.id,
    projectID: input.project.id,
    agent: input.agent,
    model: input.model
      ? {
          id: ModelV2.ID.make(input.model.id),
          providerID: ProviderV2.ID.make(input.model.providerID),
          variant: ModelV2.VariantID.make(input.model.variant ?? "default"),
        }
      : undefined,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title: legacy.title,
    visibility: input.visibility,
    location: input.location,
    time: {
      created: DateTime.makeUnsafe(input.timestamp),
      updated: DateTime.makeUnsafe(input.timestamp),
    },
  })
  return Object.freeze({
    info,
    entry: Object.freeze({
      definition: SessionV1.Event.Created,
      data: Object.freeze({
        sessionID: input.id,
        info: legacy,
        visibility: input.visibility,
        project: Object.freeze({
          id: input.project.id,
          worktree: input.project.directory,
          vcs: input.project.vcs?.type,
        }),
      }),
    }),
  })
}
