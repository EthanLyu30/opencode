import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { runWindowsPolicyCrash } from "./fixtures/windows-policy-crash"

test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_POLICY_LIVE !== "1")(
  "persistent private-executable deny survives its supervisor crash and retires only after held-job proof",
  async () => {
    const result = await runWindowsPolicyCrash({ root: tmpdir() })
    expect(result.scope).toBe("network-policy-only")
    expect(result.before).toBe("healthy")
    expect(result.during).toBe("healthy")
    expect(result.installed).toMatchObject({
      supervisorState: "alive",
      persistentNetworkPolicy: true,
      persistentPolicyRetired: false,
    })
    expect(result.aliveRecoveryRejected).toBe(true)
    expect(result.afterCrash).toMatchObject({
      supervisorState: "dead",
      jobState: "empty",
      persistentNetworkPolicy: true,
      objects: { sublayer: true, ipv4: true, ipv6: true },
    })
    expect(result.after).toBe("blocked")
    expect(result.postCrashHits).toBe(0)
    expect(result.recovery).toMatchObject({
      retirementPerformed: true,
      persistentPolicyRetired: true,
      recoveryScope: "network-policy-only",
    })
    expect(result.gone).toMatchObject({
      persistentNetworkPolicy: false,
      objects: { sublayer: false, ipv4: false, ipv6: false },
    })
    expect(result.restored).toBe("healthy")
    expect(result.modelApiCalls).toBe(0)
  },
  180000,
)
