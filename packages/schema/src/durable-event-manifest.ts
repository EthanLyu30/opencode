export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { ResponseEvent } from "./response-event"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"
import { WorkflowEvent } from "./workflow-event"

export const SessionDurable = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
} as const

export const WorkflowDurable = {
  definitions: Event.durable(WorkflowEvent.DurableDefinitions),
  schema: WorkflowEvent.Durable,
} as const

export const ResponseDurable = {
  definitions: Event.durable(ResponseEvent.DurableDefinitions),
  schema: ResponseEvent.Durable,
} as const

export const Durable = Event.durable([
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
  ...ResponseEvent.DurableDefinitions,
  ...WorkflowEvent.DurableDefinitions,
])
