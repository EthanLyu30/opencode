import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import {
  decodeEvaluationIdentity,
  freeze,
  safePath,
  type EvaluationIdentityV2,
  type ProbeOperation,
  type TaskExecutionProfile,
} from "../../corpus/evaluation-profile"
import type { CandidateReference, ProbeRequest } from "./host"

const Result = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("value"), value: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("throw"), message: Schema.String }),
])
const Response = Schema.Struct({
  cases: Schema.NonEmptyArray(Schema.Struct({ id: Schema.NonEmptyString, outputs: Schema.NonEmptyArray(Result) })),
})
export type ProbeResponse = typeof Response.Type
export type ProbeCase = Readonly<{ id: string; operations: readonly ProbeOperation[] }>
export function decodeProbeResponse(bytes: Uint8Array): ProbeResponse {
  if (bytes.byteLength > 1024 * 1024) throw new TypeError("TASK24_PROBE_SIZE_INVALID")
  try {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    canonicalJson(raw)
    const r = Schema.decodeUnknownSync(Response)(raw, { onExcessProperty: "error" })
    if (
      r.cases.reduce((n, c) => n + c.outputs.length, 0) > 1000 ||
      new Set(r.cases.map((c) => c.id)).size !== r.cases.length
    )
      throw Error("coverage")
    return freeze(r)
  } catch {
    throw new TypeError("TASK24_PROBE_RESPONSE_INVALID")
  }
}
export function makeProbeRequest(input: {
  identity: EvaluationIdentityV2
  profile: TaskExecutionProfile
  inputs: { candidate: CandidateReference; module: string; cases: readonly ProbeCase[] }
}): ProbeRequest {
  const { module, candidate, cases } = input.inputs
  safePath(module)
  if (
    !input.profile.probeModules.includes(module) ||
    !cases.length ||
    new Set(cases.map((c) => c.id)).size !== cases.length ||
    cases.some((c) => !c.operations.length) ||
    cases.reduce((n, c) => n + c.operations.length, 0) > 1000
  )
    throw new TypeError("TASK24_PROBE_REQUEST_INVALID")
  for (const c of cases)
    for (const op of c.operations) {
      if (
        !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(op.target) ||
        op.target.split(".").some((p) => ["__proto__", "prototype", "constructor"].includes(p)) ||
        !["call", "method", "get"].includes(op.kind) ||
        (op.kind === "get" && op.args.length)
      )
        throw new TypeError("TASK24_PROBE_OPERATION_INVALID")
    }
  const request = {
    identity: decodeEvaluationIdentity(input.identity),
    candidate: {
      archiveFile: candidate.archiveFile,
      archiveSha256: candidate.archiveSha256,
      candidateSha256: candidate.candidateSha256,
      configSha256: candidate.configSha256,
    },
    profileSha256: input.identity.profileSha256,
    timeoutMs: 30000,
    module,
    inputs: cases.map((c) => ({ id: c.id })),
    operations: cases.map((c) => ({
      id: c.id,
      steps: c.operations.map((op) => ({ kind: op.kind, target: op.target, args: structuredClone(op.args) })),
    })),
  }
  if (Buffer.byteLength(canonicalJson(request)) > 1024 * 1024) throw new TypeError("TASK24_PROBE_SIZE_INVALID")
  return freeze(request)
}
/** Fixed untrusted worker; the host isolates it. No judge/answer is loaded here. */
export function probeWorkerSource(): string {
  return `import {pathToFileURL} from "node:url";
import path from "node:path";
const text = await Bun.stdin.text();
if (Buffer.byteLength(text)>1048576) throw Error("size");
const request=JSON.parse(text);
if (!/^[a-zA-Z0-9_./-]+$/.test(request.module)||request.module.split("/").includes("..")||request.module.startsWith("/")) throw Error("module");
const mod=await import(pathToFileURL(path.resolve(process.argv[2],request.module)).href);
const cases=[];let count=0;
for(const c of request.operations){const outputs=[];for(const op of c.steps){if(++count>1000)throw Error("size");try{
const parts=op.target.split(".");if(parts.some(p=>["__proto__","prototype","constructor"].includes(p)))throw Error("target");
let owner=mod;for(const part of parts.slice(0,-1))owner=owner[part];const value=owner[parts.at(-1)];
const result=op.kind==="get"?value:await value.apply(op.kind==="method"?owner:undefined,op.args);
outputs.push({kind:"value",value:JSON.parse(JSON.stringify(result===undefined?null:result))});
}catch(e){outputs.push({kind:"throw",message:String(e?.message??e)})}}cases.push({id:c.id,outputs})}
const out=JSON.stringify({cases});if(Buffer.byteLength(out)>1048576)throw Error("size");process.stdout.write(out);`
}
