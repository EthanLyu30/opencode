import { requireModelCapability } from "../capabilities"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"

export const id = ProviderID.make("kimi")
export const DEFAULT_BASE_URL = "https://api.moonshot.cn/v1"

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

export const configure = (input: ModelOptions = {}) => {
  const { apiKey: _, auth: _auth, baseURL, ...defaults } = input
  const route = OpenAICompatibleChat.route.with({
    ...defaults,
    provider: id,
    endpoint: { baseURL: baseURL ?? DEFAULT_BASE_URL },
    auth: AuthOptions.bearer(input, "MOONSHOT_API_KEY"),
  })
  const model = (modelID: string | ModelID) => {
    const profile = requireModelCapability({ provider: id, model: modelID, required: "chat" })
    return route.model({ id: profile.model })
  }

  return { id, model, configure }
}

export const provider = configure()
export const model = provider.model
