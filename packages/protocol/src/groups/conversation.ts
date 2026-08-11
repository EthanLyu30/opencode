import { Responses } from "@opencode-ai/schema/responses"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConversationNotFoundError, InvalidRequestError, ResponseConflictError } from "../errors"

export const ConversationItemAppendPayload = Schema.Struct({
  responseID: Responses.ID.pipe(Schema.optional),
  payload: Responses.ItemPayload,
}).annotate({ identifier: "Responses.ConversationItemAppendPayload" })

export const ConversationGroup = HttpApiGroup.make("server.conversation")
  .add(
    HttpApiEndpoint.post("conversation.create", "/v1/conversations", {
      payload: Responses.ConversationCreateInput,
      success: Responses.Conversation,
      error: [InvalidRequestError, ResponseConflictError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v1.conversation.create", summary: "Create conversation" })),
  )
  .add(
    HttpApiEndpoint.get("conversation.get", "/v1/conversations/:conversationID", {
      params: { conversationID: Responses.ConversationID },
      success: Responses.Conversation,
      error: ConversationNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v1.conversation.get", summary: "Get conversation" })),
  )
  .add(
    HttpApiEndpoint.delete("conversation.delete", "/v1/conversations/:conversationID", {
      params: { conversationID: Responses.ConversationID },
      success: HttpApiSchema.NoContent,
      error: [ConversationNotFoundError, ResponseConflictError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v1.conversation.delete", summary: "Delete conversation" })),
  )
  .add(
    HttpApiEndpoint.post("conversation.appendItem", "/v1/conversations/:conversationID/items", {
      params: { conversationID: Responses.ConversationID },
      payload: ConversationItemAppendPayload,
      success: Responses.Conversation,
      error: [ConversationNotFoundError, InvalidRequestError, ResponseConflictError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v1.conversation.appendItem", summary: "Append conversation item" }),
    ),
  )
  .add(
    HttpApiEndpoint.get("conversation.items", "/v1/conversations/:conversationID/items", {
      params: { conversationID: Responses.ConversationID },
      success: Schema.Struct({ data: Schema.Array(Responses.ConversationItem) }),
      error: ConversationNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v1.conversation.items", summary: "List conversation items" })),
  )
  .annotateMerge(OpenApi.annotations({ title: "conversations", description: "Durable local conversation routes." }))
