import { Route, type RouteRoutedModelInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol, type ProtocolBody } from "../route/protocol"
import * as OpenAIChat from "./openai-chat"

const ADAPTER = "openai-compatible-chat"

export type OpenAICompatibleChatModelInput = RouteRoutedModelInput

/**
 * Route for non-OpenAI providers that expose an OpenAI Chat-compatible
 * `/chat/completions` endpoint. By default it reuses `OpenAIChat.protocol`
 * end-to-end. Provider facades can use `makeProjectedRoute` to keep the shared
 * Chat stream parser while replacing request lowering for documented wire
 * differences such as Kimi K3's fixed sampling controls.
 */
export const makeProjectedRoute = <Body>(body: ProtocolBody<Body>) => {
  const protocol = Protocol.make({
    id: OpenAIChat.protocol.id,
    body,
    stream: OpenAIChat.protocol.stream,
  })
  return Route.make({
    id: ADAPTER,
    protocol,
    endpoint: Endpoint.path<Body>(OpenAIChat.PATH),
    framing: Framing.sse,
  })
}

export const route = makeProjectedRoute(OpenAIChat.protocol.body)

export * as OpenAICompatibleChat from "./openai-compatible-chat"
