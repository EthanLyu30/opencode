import path from "node:path"
import { Task24Root } from "../root"
import type { ArmID, BinaryAuthority } from "./types"

const sha256Pattern = /^[a-f0-9]{64}$/

export function assertBinaryForArm(armID: ArmID, binary: BinaryAuthority): BinaryAuthority {
  const expected = armID === "D" || armID === "E" ? "upstream" : "modified"
  if (binary.runtime !== expected) throw new TypeError("TASK24_ARM_RUNTIME_MISMATCH")
  const executable = path.resolve(binary.executable)
  const toolchain = path.resolve(Task24Root.ensure().toolchain) + path.sep
  if (
    path.parse(executable).root.toLowerCase() !== "d:\\" ||
    path.normalize(binary.executable) !== binary.executable ||
    (expected === "upstream" && !executable.startsWith(toolchain))
  ) {
    throw new TypeError("TASK24_BINARY_OUTSIDE_TOOLCHAIN")
  }
  if (!sha256Pattern.test(binary.sha256) || binary.version.length === 0)
    throw new TypeError("TASK24_BINARY_AUTHORITY_INVALID")
  return binary
}
