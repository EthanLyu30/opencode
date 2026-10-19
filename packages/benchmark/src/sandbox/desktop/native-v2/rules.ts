import type { Gate } from "../../contracts"
import { canonicalJson } from "../../../campaign/canonical"
import { freeze } from "../../../corpus/evaluation-profile"
import { sha256Text } from "../../../hash"

/** Rule data is not a read permit, approval, session or executable entry point. */
export type NativeRuleDescriptor = Readonly<{
  installSha256: string
  readerSha256: string
  layoutSha256: string
  settingsSha256: string
  lifecycleSha256: string
  handoffSha256: string
  evidenceSha256: string
}>
type NativePrerequisites = Readonly<{
  status: "ready_for_implementation" | "needs_dependency_approval" | "blocked"
  missing: readonly string[]
  evidence: readonly Readonly<{ id: string; source: string; sha256: string; location: string }>[]
}>

// A historical static sample, not a live installation check or a complete write/layout inventory.
const installation = freeze({
  schemaVersion: 1,
  root: "D:\\Applications\\Docker",
  members: [
    { path: "Docker Desktop.exe", sha256: "d079706dcb13555ad6e51e04e0f0507f475de5ebb79ac31cf85986d8902e31bc" },
    { path: "com.docker.service", sha256: "5ba942808db6b1ebb32dd9f940d61f27e36322362fb8fe0d794c89f8b6a0d4bf" },
    { path: "frontend/Docker Desktop.exe", sha256: "86d8ea314a56cfee849d666f2cac60f07aeb7937632e7fe005d642ad04be2771" },
    { path: "frontend/resources/app.asar", sha256: "607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada" },
    { path: "resources/bin/docker.exe", sha256: "7bc66b018b9da43fea986f893288bb93970d3d1217f5063201fd97c827f20732" },
    {
      path: "resources/com.docker.backend.exe",
      sha256: "2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd",
    },
    {
      path: "resources/componentsVersion.json",
      sha256: "8e1ea0564f06432d37853880188ea838fcd59b2ed751861fc933afb0e54ca233",
    },
  ],
})
const installSha256 = sha256Text(canonicalJson(installation))
const prerequisites: NativePrerequisites = freeze({
  status: "blocked",
  missing: [
    "offline_reader_unavailable",
    "workload_layout_unproved",
    "workload_handoff_unproved",
    "path_routing_unproved",
    "backend_environment_unproved",
    "registration_reuse_unproved",
    "stop_owned_unproved",
    "settings_mutation_unproved",
    "existing_workload_restart_unproved",
    "automatic_behavior_unproved",
  ],
  evidence: [
    {
      id: "static_installation_manifest",
      source: "D:\\Applications\\Docker",
      sha256: installSha256,
      location:
        "canonicalJson({schemaVersion:1,root,members}); seven sorted members recorded in NW1 verification report",
    },
    ...installation.members.map((member) => ({
      id: "static_installation_member",
      source: installation.root + "\\" + member.path.replaceAll("/", "\\"),
      sha256: member.sha256,
      location: "whole-file static bytes; not execution, complete behavior proof or current authority",
    })),
    {
      id: "frontend_home_routing_fragment",
      source: "D:\\Applications\\Docker\\frontend\\resources\\app.asar",
      sha256: "3998a5b748667b5bd51fe73d3b113de9dc9d31ebc144b5b95c62413201c5f32b",
      location: "build/entry-cli.main.js; ASAR data=282980, member offset=25371808, size=11593; PINATA_HOME byte=991",
    },
    {
      id: "frontend_single_instance_fragment",
      source: "D:\\Applications\\Docker\\frontend\\resources\\app.asar",
      sha256: "ed2277acdafb0891a3b6d93599738a3ae5fc909a8bc2123018816c67d830027d",
      location:
        "build/onlyAllowSingleInstance.main.js; offset=27753709, size=988; PINATA_SINGLE_INSTANCE_LOCK byte=502",
    },
  ],
})

/** Pure, compile-time evidence only. No filesystem, subprocess, environment or proof-import access. */
export function assessNativePrerequisites(): NativePrerequisites {
  return prerequisites
}

export function selectNativeRuleDescriptor(installSha256: string): Gate<NativeRuleDescriptor> {
  // There are NO qualified catalog entries, implementation versions or reader/lifecycle entry points.
  // In particular, the sampled installation does not qualify merely because its digest matches.
  // Future enablement needs a reviewed complete internal record; no external registration is offered.
  return freeze({
    kind: "blocked",
    code: "TASK24_DESKTOP_NATIVE_RULES_UNPROVED",
    missing:
      typeof installSha256 === "string" && installSha256 === prerequisites.evidence[0]!.sha256
        ? prerequisites.missing
        : ["native_installation_unregistered", ...prerequisites.missing],
  })
}
