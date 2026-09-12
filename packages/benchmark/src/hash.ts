import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"))
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
