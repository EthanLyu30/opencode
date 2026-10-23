import { browserHelperMain, browserHelperFailurePhase } from "../src/sandbox/browser-helper"

void browserHelperMain().catch(() => {
  process.stderr.write("TASK24_BROWSER_V2_FAILURE:" + browserHelperFailurePhase())
  process.exitCode = 1
})
