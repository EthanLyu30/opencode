import { canonicalJson } from "../../campaign/canonical"
import { freeze, type CheckCommand, type DependencyResolution, type EvaluationIdentityV2, type TaskExecutionProfile } from "../../corpus/evaluation-profile"
import type { FileEntry } from "../../corpus/manifest"
import { sha256Text } from "../../hash"
import { decodeProbeResponse, type ProbeResponse } from "./probe"

export type CandidateReference = Readonly<{archiveFile:string;archiveSha256:string;candidateSha256:string;configSha256:string}>
export type CommonRequest = Readonly<{identity:EvaluationIdentityV2;candidate:CandidateReference;profileSha256:string;timeoutMs:number}>
export type BuildRequest = CommonRequest & Readonly<{commands:readonly CheckCommand[];dependency:DependencyResolution}>
export type ProbeRequest = CommonRequest & Readonly<{module:string;inputs:readonly {id:string}[];operations:readonly {id:string;steps:readonly {kind:string;target:string;args:readonly unknown[]}[]}[]}>
export type BuildManifest = Readonly<{candidateSha256:string;configSha256:string;dependencySha256:string;files:readonly FileEntry[];buildSha256:string}>
export type PreviewRequest = CommonRequest & Readonly<{build:BuildManifest;preview:NonNullable<TaskExecutionProfile["preview"]>}>
export type BuildPayload = Readonly<{kind:"ok";commands:readonly {id:string;exitCode:number}[];build:BuildManifest}>
export type ProbePayload = Readonly<{kind:"ok";response:ProbeResponse}>
export type PreviewPayload = Readonly<{kind:"ok";handle:string;buildSha256:string;browserSha256:string;fontSha256:string}>
export type FailurePayload = Readonly<{kind:"candidate_failure"|"unavailable";reason:string}>
type Bound<T> = T & Readonly<{identity:EvaluationIdentityV2;candidate:CandidateReference;profileSha256:string;assurance:"fixture"|"linux-attested";hostReceiptSha256:string}>
export type BuildObservation = Bound<BuildPayload|FailurePayload>
export type ProbeObservation = Bound<ProbePayload|FailurePayload>
export type PreviewObservation = Bound<PreviewPayload|FailurePayload>
export interface EvaluationHost {
  build(request:BuildRequest):Promise<BuildObservation>
  probe(request:ProbeRequest):Promise<ProbeObservation>
  preview(request:PreviewRequest):Promise<PreviewObservation>
}
const issued = new WeakSet<object>()
/** Test-only assurance: it deliberately cannot mint a Linux attestation. */
export function fixtureObservation<T extends BuildPayload|ProbePayload|PreviewPayload|FailurePayload>(request:CommonRequest,payload:T):Bound<T> {
  const base = { ...structuredClone(payload), identity:request.identity,candidate:request.candidate,profileSha256:request.profileSha256,assurance:"fixture" as const }
  const o = freeze({...base,hostReceiptSha256:sha256Text(canonicalJson(base))})
  issued.add(o)
  return o
}
export function validateObservation(request:CommonRequest, observation:BuildObservation|ProbeObservation|PreviewObservation):void {
  if (!issued.has(observation) || observation.assurance!=="fixture") throw new TypeError("TASK24_HOST_AUTHORITY_INVALID")
  if (canonicalJson(observation.identity)!==canonicalJson(request.identity) || canonicalJson(observation.candidate)!==canonicalJson(request.candidate) || observation.profileSha256!==request.profileSha256) throw new TypeError("TASK24_HOST_IDENTITY_INVALID")
  if (observation.kind==="ok" && "response" in observation) decodeProbeResponse(Buffer.from(canonicalJson(observation.response)))
}
export function makeUnavailableEvaluationHost():EvaluationHost {
  const unavailable = async (r:CommonRequest) => fixtureObservation(r,{kind:"unavailable" as const,reason:"EVALUATION_HOST_UNAVAILABLE"})
  return {build:unavailable,probe:unavailable,preview:unavailable}
}
