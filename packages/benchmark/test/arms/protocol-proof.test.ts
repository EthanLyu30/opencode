import { describe, expect, test } from "bun:test"
import { assertFiveArmProtocolProof } from "../../src/arms/protocol-proof"

const grant = "TASK24_BROKER_GRANT_abcdefghijklmnopqrstuvwxyz"
const authorization = `Bearer ${grant}`

describe("Task24 five-arm wire proof", () => {
  test("accepts only the sealed native route/model/max-output matrix", () => {
    const proof = assertFiveArmProtocolProof({
      grant,
      calls: [
        {
          armID: "A",
          path: "/v1/kimi/chat/completions",
          authorization,
          body: { model: "kimi-k3", max_completion_tokens: 10, stream: true },
        },
        {
          armID: "A",
          path: "/v1/deepseek/responses",
          authorization,
          body: { model: "deepseek-v4-pro", max_output_tokens: 10, stream: true },
        },
        {
          armID: "A",
          path: "/v1/deepseek/responses",
          authorization,
          body: { model: "deepseek-v4-flash", max_output_tokens: 10, stream: true },
        },
        {
          armID: "B",
          path: "/v1/deepseek/responses",
          authorization,
          body: { model: "deepseek-v4-pro", max_output_tokens: 10, stream: true },
        },
        {
          armID: "C",
          path: "/v1/kimi/chat/completions",
          authorization,
          body: { model: "kimi-k3", max_tokens: 10, stream: true },
        },
        {
          armID: "D",
          path: "/v1/deepseek/responses",
          authorization,
          body: { model: "deepseek-v4-pro", max_output_tokens: 10, stream: true },
        },
        {
          armID: "E",
          path: "/v1/kimi/chat/completions",
          authorization,
          body: { model: "kimi-k3", max_tokens: 10, stream: true },
        },
      ],
    })
    expect(proof.arms).toEqual(["A", "B", "C", "D", "E"])
    expect(proof.callCount).toBe(7)
  })

  test("fails a paid preflight on protocol substitution, missing max output, or a leaked upstream key", () => {
    expect(() =>
      assertFiveArmProtocolProof({
        grant,
        calls: [
          {
            armID: "B",
            path: "/v1/deepseek/chat/completions",
            authorization,
            body: { model: "deepseek-v4-pro", max_tokens: 10, stream: true },
          },
        ],
      }),
    ).toThrow(/protocol|route|proof/i)
    expect(() =>
      assertFiveArmProtocolProof({
        grant,
        calls: [
          {
            armID: "C",
            path: "/v1/kimi/chat/completions",
            authorization: "Bearer sk-real-provider",
            body: { model: "kimi-k3", stream: true },
          },
        ],
      }),
    ).toThrow(/grant|auth/i)
  })
})
