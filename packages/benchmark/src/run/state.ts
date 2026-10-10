export type RunState =
  | "planned"
  | "materializing"
  | "ready"
  | "reserved"
  | "running"
  | "evaluating"
  | "completed"
  | "rejected_budget"
  | "canceling"
  | "canceled"
  | "interrupted"
  | "resumable"
  | "failed"

const transitions: Readonly<Record<RunState, readonly RunState[]>> = {
  planned: ["materializing"],
  materializing: ["ready", "interrupted"],
  ready: ["reserved", "rejected_budget", "interrupted"],
  reserved: ["running", "interrupted"],
  running: ["evaluating", "canceling", "interrupted"],
  evaluating: ["completed", "interrupted"],
  canceling: ["canceled"],
  interrupted: ["resumable", "failed"],
  resumable: ["materializing"],
  completed: [],
  rejected_budget: [],
  canceled: [],
  failed: [],
}

export function assertTransition(from: RunState, to: RunState): RunState {
  if (!transitions[from].includes(to)) throw new TypeError(`TASK24_RUN_TRANSITION_INVALID:${from}:${to}`)
  return to
}

export function isTerminal(state: RunState): boolean {
  return state === "completed" || state === "rejected_budget" || state === "canceled" || state === "failed"
}
