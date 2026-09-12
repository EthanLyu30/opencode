import { canonicalJson } from "../campaign/canonical"
import type { ReportModel } from "./model"

export function reportJson(value: ReportModel): string {
  return canonicalJson(value) + "\n"
}
