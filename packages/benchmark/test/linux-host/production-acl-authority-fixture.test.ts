import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { withAclAuthorityFixture } from "./acl-authority-fixture"

for (const reason of ["ACL restoration mismatch", "ACL restoration probe error"]) {
  test(`native authority fixture retains independent evidence on ${reason}`, async () => {
    let root: string | undefined
    let id: Awaited<ReturnType<typeof fs.lstat>> | undefined
    try {
      await expect(
        withAclAuthorityFixture(process.env.TMPDIR!, async (scope) => {
          root = scope.root
          id = await fs.lstat(root)
          // Precise artificial boundary: no native process, grant or registration.
          scope.launched()
          await scope.retire(
            {
              processTreeEnded: true,
              cleanupCompleted: true,
              persistentPolicyRetired: true,
              ancestorMetadataRetired: true,
            },
            async () => {
              throw Error(reason)
            },
          )
        }),
      ).rejects.toThrow(reason)
      expect(await fs.exists(root!)).toBe(true)
    } finally {
      // Only this no-resource artificial fixture is independently reclaimable.
      if (root && (await fs.exists(root))) {
        const current = await fs.lstat(root)
        if (
          (await fs.realpath(root)) !== root ||
          current.dev !== id!.dev ||
          current.ino !== id!.ino ||
          current.birthtimeMs !== id!.birthtimeMs
        )
          throw Error("own artificial fixture changed")
        await fs.rmdir(root)
      }
    }
  })
}
