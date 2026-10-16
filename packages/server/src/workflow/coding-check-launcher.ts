export * as CodingCheckLauncher from "./coding-check-launcher"

import { Schema } from "effect"

const Envelope = Schema.Struct({
  kind: Schema.Literal("opencode.coding-check.v1"),
  exitCode: Schema.Int,
  timedOut: Schema.Boolean,
  log: Schema.String.check(Schema.isMaxLength(65536)),
  report: Schema.optional(Schema.String.check(Schema.isMaxLength(256 * 1024))),
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export type Result = typeof Envelope.Type

/** Host-only literal launcher. Production never accepts scratchRoot or argv from a public/model request. */
export function source(input: {
  readonly argv: readonly string[]
  readonly id: "test" | "build" | "typecheck"
  readonly timeoutMs: number
  readonly scratchRoot?: string
}): string {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.argv[0] !== "bun" ||
    input.argv[1] !== "--no-env-file"
  )
    throw new Error("Invalid trusted coding invocation")
  return `
const input = ${JSON.stringify(input)};
const path = await import("node:path");
const fs = await import("node:fs/promises");
const root = input.scratchRoot ?? "/tmp/opencode-coding-check";
await fs.mkdir(root, { recursive: true });
const bin = path.join(root, "bin");
await fs.mkdir(bin, { recursive: true });
const wrapper = path.join(bin, process.platform === "win32" ? "bun.cmd" : "bun");
if (/[\\r\\n\"]/u.test(process.execPath)) throw new Error("Invalid pinned Bun path");
await Bun.write(wrapper, process.platform === "win32" ? '@"' + process.execPath + '" --no-env-file %*\\r\\n' : '#!/bin/sh\\nexec "' + process.execPath + '" --no-env-file "$@"\\n');
if (process.platform !== "win32") await fs.chmod(wrapper, 0o700);
const reportPath = path.join(root, "report.xml");
await fs.rm(reportPath, { force: true });
const argv = [process.execPath, ...input.argv.slice(1), ...(input.id === "test" ? ["--reporter=junit", "--reporter-outfile=" + reportPath] : [])];
const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: bin + path.delimiter + (process.env.PATH ?? "") }, windowsHide: true });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill(); }, input.timeoutMs);
async function bounded(stream) {
  const chunks = []; let used = 0;
  for await (const chunk of stream) { if (used < 32768) { const keep = chunk.slice(0, 32768 - used); chunks.push(Buffer.from(keep)); used += keep.byteLength; } }
  return Buffer.concat(chunks).toString("utf8");
}
const [exit, stdout, stderr] = await Promise.all([child.exited, bounded(child.stdout), bounded(child.stderr)]);
clearTimeout(timer);
let report;
const file = Bun.file(reportPath);
if (input.id === "test" && await file.exists()) {
  if (file.size <= 262144) { const bytes = await file.arrayBuffer(); if (bytes.byteLength <= 262144) report = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
}
const exitCode = timedOut ? 124 : exit;
console.log(JSON.stringify({ kind: "opencode.coding-check.v1", exitCode, timedOut, log: (stdout + stderr).slice(0, 65536), ...(report === undefined ? {} : { report }) }));
process.exit(exitCode);
`
}
export function decode(output: string, exit: number): Result {
  if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new Error("Coding check envelope too large")
  const result = Schema.decodeUnknownSync(Envelope)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(output))
  if (result.exitCode !== exit || (result.timedOut && result.exitCode !== 124))
    throw new Error("Coding container and command exit disagree")
  return result
}
