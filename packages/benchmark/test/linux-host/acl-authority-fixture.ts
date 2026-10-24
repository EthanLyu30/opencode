import fs from "node:fs/promises"
import path from "node:path"

/** Test-only owner. Independent restoration observations gate fixture removal. */
export async function withAclAuthorityFixture(
  parent: string,
  run: (scope: {
    root: string
    launched(): void
    retire(
      containment: {
        processTreeEnded: boolean
        cleanupCompleted: boolean
        persistentPolicyRetired: boolean
        ancestorMetadataRetired?: true
      },
      verifyRestoration: () => Promise<void>,
    ): Promise<void>
  }) => Promise<void>,
) {
  if ((await fs.realpath(parent)) !== parent || (await fs.lstat(parent)).isSymbolicLink())
    throw Error("unsafe owned test parent")
  const root = await fs.mkdtemp(path.join(parent, "acl-authority-live-"))
  const id = await fs.lstat(root, { bigint: true })
  let safe = true
  try {
    await run({
      root,
      launched() {
        safe = false
      },
      async retire(c, verifyRestoration) {
        safe = false
        if (
          !(c.processTreeEnded && c.cleanupCompleted && c.persistentPolicyRetired && c.ancestorMetadataRetired === true)
        )
          throw Object.assign(Error("own native retirement unconfirmed"), { cleanupUncertain: true, root })
        await verifyRestoration()
        safe = true
      },
    })
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "cleanupUncertain") === true) safe = false
    throw error
  } finally {
    const current = await fs.lstat(root, { bigint: true })
    if (
      safe &&
      path.dirname(root) === parent &&
      (await fs.realpath(root)) === root &&
      current.dev === id.dev &&
      current.ino === id.ino &&
      current.birthtimeNs === id.birthtimeNs
    )
      await fs.rm(root, { recursive: true })
    if (!safe) console.warn("Retained uncertain native authority fixture:", root)
  }
}
