import { describe, expect, test } from "bun:test"
import { Capabilities } from "../src"
import { DeepSeek, Kimi } from "../src/providers"

const profile = (provider: string, model: string) => {
  const result = Capabilities.getModelCapabilityProfile(provider, model)
  expect(result).toBeDefined()
  return result!
}

const unsupported = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Capabilities.UnsupportedModelCapability)
    return error as Capabilities.UnsupportedModelCapability
  }
  throw new Error("Expected UnsupportedModelCapability")
}

describe("model capability contracts", () => {
  test("exposes lookup, support, and requirement helpers", () => {
    expect(Capabilities.getModelCapabilityProfile).toBeFunction()
    expect(Capabilities.supportsModelCapability).toBeFunction()
    expect(Capabilities.requireModelCapability).toBeFunction()
    expect(Capabilities.UnsupportedModelCapability).toBeFunction()
  })

  test("admits only Kimi K3 with the declared Chat capabilities", () => {
    const kimi = profile("kimi", "kimi-k3")

    expect(kimi.protocol).toBe("openai-chat")
    expect([...kimi.capabilities]).toEqual([
      "chat",
      "reasoning_replay",
      "vision_input",
      "structured_output",
      "required_tool_choice",
    ])
    expect([...kimi.plannedCapabilities]).toEqual([])
    expect(Capabilities.supportsModelCapability({ provider: "kimi", model: "kimi-k3", required: "chat" })).toBe(
      true,
    )

    for (const model of ["kimi-k2.6", "kimi-k2.7", "kimi-k2.7-code"]) {
      expect(Capabilities.getModelCapabilityProfile("kimi", model)).toBeUndefined()
      const error = unsupported(() =>
        Capabilities.requireModelCapability({ provider: "kimi", model, required: "chat" }),
      )
      expect(String(error.provider)).toBe("kimi")
      expect(String(error.model)).toBe(model)
      expect(error.required).toBe("chat")
      expect(error.supported).toEqual([])
      expect(error.planned).toBe(false)
    }
  })

  test("selects native Responses for DeepSeek V4 Flash", () => {
    const flash = Capabilities.requireModelCapability({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      required: "responses",
    })

    expect(flash.protocol).toBe("openai-responses")
    expect([...flash.capabilities]).toEqual(["chat", "responses", "structured_output", "required_tool_choice"])
    expect([...flash.plannedCapabilities]).toEqual([])
  })

  test("reserves but does not prematurely enable Responses for DeepSeek V4 Pro", () => {
    const pro = profile("deepseek", "deepseek-v4-pro")

    expect(pro.protocol).toBe("openai-chat")
    expect([...pro.capabilities]).toEqual(["chat", "structured_output"])
    expect([...pro.plannedCapabilities]).toEqual(["responses"])
    expect(
      Capabilities.supportsModelCapability({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        required: "responses",
      }),
    ).toBe(false)

    const error = unsupported(() =>
      Capabilities.requireModelCapability({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        required: "responses",
      }),
    )
    expect(error.supported).toEqual(["chat", "structured_output"])
    expect(error.planned).toBe(true)
    expect(error.message).toBe(
      "deepseek/deepseek-v4-pro does not support responses yet; it is planned (supported: chat, structured_output)",
    )

    const toolChoice = unsupported(() =>
      Capabilities.requireModelCapability({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        required: "required_tool_choice",
      }),
    )
    expect(toolChoice.planned).toBe(false)
  })

  test("does not expose mutable canonical capability sets", () => {
    const first = profile("deepseek", "deepseek-v4-pro")
    expect(Object.isFrozen(first)).toBe(true)
    expect("add" in first.capabilities).toBe(false)
    expect("delete" in first.capabilities).toBe(false)
    expect("clear" in first.capabilities).toBe(false)

    expect(
      Capabilities.supportsModelCapability({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        required: "responses",
      }),
    ).toBe(false)
    expect([...profile("deepseek", "deepseek-v4-pro").capabilities]).not.toContain("responses")
  })
})

describe("provider capability routing", () => {
  test("routes Kimi K3 only through the compatible Chat protocol", () => {
    const kimi = Kimi.model("kimi-k3")
    expect(kimi.route.id).toBe("openai-compatible-chat")
    expect(kimi.route.endpoint.baseURL).toBe("https://api.moonshot.cn/v1")
    expect(String(kimi.provider)).toBe("kimi")
    expect(Kimi.configure({ baseURL: "https://moonshot.test/v1" }).model("kimi-k3").route.endpoint.baseURL).toBe(
      "https://moonshot.test/v1",
    )
    unsupported(() => Kimi.model("kimi-k2.7"))
  })

  test("makes DeepSeek model selection Responses-first and Chat explicit", () => {
    const flash = DeepSeek.model("deepseek-v4-flash")
    expect(flash.route.id).toBe("openai-responses")
    expect(flash.route.endpoint.baseURL).toBe("https://api.deepseek.com")
    expect(String(DeepSeek.responses("deepseek-v4-flash").provider)).toBe("deepseek")
    expect(DeepSeek.chat("deepseek-v4-pro").route.id).toBe("openai-compatible-chat")
    expect(
      DeepSeek.configure({ baseURL: "https://deepseek.test" }).responses("deepseek-v4-flash").route.endpoint.baseURL,
    ).toBe("https://deepseek.test")

    const error = unsupported(() => DeepSeek.model("deepseek-v4-pro"))
    expect(error.required).toBe("responses")
    expect(error.planned).toBe(true)
  })
})
