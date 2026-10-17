import { expect, test } from "bun:test"
import { authorizeLinuxHost, requireLinuxObservation } from "../../src/sandbox/evaluation-host"
import { fixtureObservation } from "../../src/evaluator/independent/host"
import { sessionFixture } from "./fixture"
import { candidate, identity } from "../independent/fixture"
import { verifyLinuxResultProof } from "../../src/sandbox/evaluation-host"

test("fixture receipts and JSON lookalikes never authorize a Linux evaluator", async () => {
  const f = await sessionFixture()
  try {
    for (const receipt of [
      { assurance: "fixture" },
      { assurance: "linux-attested", status: "passed", manifestSha256: f.session.manifestSha256, checks: [] },
    ])
      expect(() =>
        authorizeLinuxHost({
          manifest: f.manifest,
          engineReceipt: receipt as never,
          evidenceRoot: f.manifest.roots.evidence,
        }),
      ).toThrow()
    const o = fixtureObservation(
      { identity: identity(), candidate, profileSha256: identity().profileSha256, timeoutMs: 30000 },
      { kind: "candidate_failure", reason: "fixture" },
    )
    expect(() => requireLinuxObservation({ ...o, assurance: "linux-attested" })).toThrow()
    expect(() =>
      verifyLinuxResultProof(
        {
          manifestSha256: f.session.manifestSha256,
          engineReceiptSha256: "a".repeat(64),
          operations: [],
          browserOperations: [],
          evidenceRoot: f.manifest.roots.evidence,
        },
        undefined,
        identity(),
      ),
    ).toThrow()
  } finally {
    await f.dispose()
  }
})
