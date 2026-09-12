import { timingSafeEqual } from "node:crypto"
import { authorizeRequest } from "../broker/policy"
import type { ArmID } from "./types"

export interface ProtocolCall {
  readonly armID: ArmID
  readonly path: string
  readonly authorization: string
  readonly body: unknown
}

export function assertFiveArmProtocolProof(input: {
  readonly grant: string
  readonly calls: readonly ProtocolCall[]
}): { readonly arms: readonly ArmID[]; readonly callCount: number } {
  const observed = new Map<ArmID, string[]>()
  for (const call of input.calls) {
    if (!same(call.authorization, `Bearer ${input.grant}`)) throw new TypeError("TASK24_PROTOCOL_GRANT_MISMATCH")
    let route: ReturnType<typeof authorizeRequest>
    try {
      route = authorizeRequest(call.path, call.body)
    } catch {
      throw new TypeError("TASK24_PROTOCOL_ROUTE_INVALID")
    }
    const key = `${route.provider}/${route.model}/${route.protocol}`
    const arm = observed.get(call.armID) ?? []
    arm.push(key)
    observed.set(call.armID, arm)
  }
  const expected: Readonly<Record<ArmID, readonly string[]>> = {
    A: ["kimi/kimi-k3/chat_completions", "deepseek/deepseek-v4-pro/responses", "deepseek/deepseek-v4-flash/responses"],
    B: ["deepseek/deepseek-v4-pro/responses"],
    C: ["kimi/kimi-k3/chat_completions"],
    D: ["deepseek/deepseek-v4-pro/responses"],
    E: ["kimi/kimi-k3/chat_completions"],
  }
  const arms = (["A", "B", "C", "D", "E"] as const).filter((armID) => observed.has(armID))
  for (const armID of arms) {
    const actual = [...new Set(observed.get(armID))].toSorted()
    if (JSON.stringify(actual) !== JSON.stringify([...expected[armID]].toSorted())) {
      throw new TypeError("TASK24_PROTOCOL_PROOF_MISMATCH")
    }
  }
  if (arms.length !== 5) throw new TypeError("TASK24_PROTOCOL_PROOF_INCOMPLETE")
  return Object.freeze({ arms: Object.freeze(arms), callCount: input.calls.length })
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8")
  const b = Buffer.from(right, "utf8")
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}
