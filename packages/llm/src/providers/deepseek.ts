import { requireModelCapability } from "../capabilities"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"
import * as OpenAIResponses from "../protocols/openai-responses"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"

export const id = ProviderID.make("deepseek")
export const DEFAULT_BASE_URL = "https://api.deepseek.com"

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAIResponses.route, OpenAICompatibleChat.route]

const defaults = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL: _baseURL, ...rest } = input
  return rest
}

const auth = (input: ModelOptions) => AuthOptions.bearer(input, "DEEPSEEK_API_KEY")

export const configure = (input: ModelOptions = {}) => {
  const routeDefaults = defaults(input)
  const responsesRoute = OpenAIResponses.route.with({
    ...routeDefaults,
    provider: id,
    endpoint: { baseURL: input.baseURL ?? DEFAULT_BASE_URL },
    auth: auth(input),
  })
  const chatRoute = OpenAICompatibleChat.route.with({
    ...routeDefaults,
    provider: id,
    endpoint: { baseURL: input.baseURL ?? DEFAULT_BASE_URL },
    auth: auth(input),
  })
  const responses = (modelID: string | ModelID) => {
    const profile = requireModelCapability({ provider: id, model: modelID, required: "responses" })
    return responsesRoute.model({ id: profile.model })
  }
  const chat = (modelID: string | ModelID) => {
    const profile = requireModelCapability({ provider: id, model: modelID, required: "chat" })
    return chatRoute.model({ id: profile.model })
  }

  return {
    id,
    model: responses,
    responses,
    chat,
    configure,
  }
}

export const provider = configure()
export const model = provider.model
export const responses = provider.responses
export const chat = provider.chat
