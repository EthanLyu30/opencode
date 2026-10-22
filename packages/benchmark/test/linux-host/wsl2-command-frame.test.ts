import { expect, test } from "bun:test"
import { decodeWsl2CommandFrame } from "../../src/sandbox/wsl2-independent"

test("trusted WSL command frame preserves real binary stderr without mixing launcher progress", () => {
  const frame = {
    nonce: "a".repeat(64),
    exitCode: 7,
    stdout: Buffer.from([0, 255, 1]).toString("base64"),
    stderr: Buffer.from("real command error\n").toString("base64"),
    truncated: false,
  }
  const outer = {
    started: true,
    exitCode: 0,
    stdout: Buffer.from(JSON.stringify(frame)),
    stderr: Buffer.from("wsl launcher progress", "utf16le"),
    truncated: false,
  }
  const result = decodeWsl2CommandFrame(outer, frame.nonce, { maxStdoutBytes: 100, maxStderrBytes: 100 })
  expect([...result.stdout]).toEqual([0, 255, 1])
  expect(Buffer.from(result.stderr).toString()).toBe("real command error\n")
  expect(result.exitCode).toBe(7)
  for (const change of [
    { nonce: "b".repeat(64) },
    { stdout: "AA==invalid" },
    { extra: true },
    { stdout: Buffer.alloc(101).toString("base64") },
  ])
    expect(() =>
      decodeWsl2CommandFrame({ ...outer, stdout: Buffer.from(JSON.stringify({ ...frame, ...change })) }, frame.nonce, {
        maxStdoutBytes: 100,
        maxStderrBytes: 100,
      }),
    ).toThrow()
  expect(() =>
    decodeWsl2CommandFrame({ ...outer, truncated: true }, frame.nonce, { maxStdoutBytes: 100, maxStderrBytes: 100 }),
  ).toThrow()
})
