import type { Cause, HashMap, HashSet, Option } from "effect"

export type Strategy = "Overlap" | "Restart"
export type Placement = "Worker" | "Process" | "Runner"
export interface Target {
	readonly identity: string
	readonly placement: Placement
	readonly overlap: boolean
}
export interface Budget {
	readonly total: number
	readonly startup: number
	readonly probe: number
	readonly drain: number
	readonly stop: number
	readonly terminate: number
}
export interface Requirements {
	readonly probes: ReadonlyArray<string>
	readonly trial: number
}
export interface Input {
	readonly key?: string | undefined
	readonly instance: string
	readonly target: Target
	readonly strategy?: Strategy | undefined
	readonly expected?: number | undefined
	readonly budget?: Partial<Budget> | undefined
	readonly requirements?: Partial<Requirements> | undefined
}
export interface RequestIdentity {
	readonly instance: string
	readonly target: Target
	readonly strategy: Strategy | "Auto"
	readonly expected: Option.Option<number>
	readonly budget: Budget
	readonly probes: ReadonlyArray<string>
	readonly trial: number
}
export interface Request {
	readonly identity?: RequestIdentity
	readonly probes?: ReadonlyArray<string>
	readonly instance: string
	readonly target: Target
	readonly strategy: Strategy
	readonly reads: HashMap.HashMap<string, number>
	readonly writes: HashSet.HashSet<string>
	readonly leases: HashSet.HashSet<string>
	readonly participants: HashSet.HashSet<string>
	readonly budget: Budget
	readonly trial: number
	readonly key?: string
	readonly members?: HashSet.HashSet<string>
	readonly localDependencies?: HashSet.HashSet<string>
}
export interface Cell {
	readonly version: number
	readonly value: Option.Option<string>
	readonly writer: Option.Option<string>
	readonly readers: HashSet.HashSet<string>
}
export interface Instance {
	readonly id: string
	readonly desired: Target
	readonly current: Option.Option<string>
	readonly term: number
	readonly healthy: boolean
	readonly authorized: boolean
}
export type Cleanup =
	| { readonly _tag: "Unknown" }
	| { readonly _tag: "Completed" }
	| { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> }
export interface Unit {
	readonly id: string
	readonly incarnation: string
	readonly instance: string
	readonly term: number
	readonly target: Target
	readonly owner: string
	readonly claim: string
	readonly spawn: string
	readonly phase:
		"PendingSpawn" | "Running" | "Terminating" | "Exited" | "NotStarted"
	readonly evidence: "Missing" | "Exited" | "NotStarted"
	readonly cleanup: Cleanup
	readonly cause: Cause.Cause<unknown>
	readonly leases: HashSet.HashSet<string>
}
export interface Claim {
	readonly id: string
	readonly owner: string
	readonly unit: Option.Option<string>
}
export type Phase =
	| "Resolving"
	| "Spawning"
	| "Starting"
	| "Serving"
	| "Readiness"
	| "Probing"
	| "Installing"
	| "Trial"
	| "Retiring"
	| "Settling"
	| "Concluded"
export type Outcome =
	"Accepted" | "Aborted" | "Recovered" | "RecoveryFailed" | "Stuck"
export type Settlement =
	"Unresolved" | "Failed" | "UnknownCleanup" | "Satisfied"
export interface MemberFact {
	readonly instance: string
	readonly reason: "ExplicitTarget"
	readonly starting: Target
	readonly startingVersion: number
	readonly desired: Target
	readonly actual: Option.Option<Target>
	readonly healthy: boolean
	readonly matchesTarget: boolean
}
export interface Conclusion {
	readonly outcome: Outcome
	readonly phase: Phase
	readonly cause: Cause.Cause<unknown>
	readonly member: MemberFact
	readonly units: HashSet.HashSet<string>
}
export interface Change {
	readonly id: string
	readonly request: Request
	readonly previous: Target
	readonly startingVersion: number
	readonly phase: Phase
	readonly interrupted: Option.Option<Phase>
	readonly old: Option.Option<string>
	readonly candidate: Option.Option<string>
	readonly units: HashSet.HashSet<string>
	readonly requiredExits: HashSet.HashSet<string>
	readonly claims: HashSet.HashSet<string>
	readonly premises: HashMap.HashMap<string, number>
	readonly oldChanged: boolean
	readonly recovering: boolean
	readonly recoveryFailed: boolean
	readonly failure: boolean
	readonly shuttingDown: boolean
	readonly cancelRequested: boolean
	readonly authorized: boolean
	readonly trialPassed: boolean
	readonly view: number
	readonly installed: HashSet.HashSet<string>
	readonly requiredParticipants: HashSet.HashSet<string>
	readonly sequence: number
	readonly nextCommand: number
	readonly commandIds: HashSet.HashSet<string>
	readonly timerIds: HashSet.HashSet<string>
	readonly deadline: number
	readonly cause: Cause.Cause<unknown>
	readonly conclusion: Option.Option<Conclusion>
	readonly transferred: Option.Option<string>
	readonly released: boolean
}
export type CommandKind =
	| "Resolve"
	| "Spawn"
	| "Start"
	| "Serve"
	| "Ready"
	| "Probe"
	| "Install"
	| "Activate"
	| "Stop"
	| "Terminate"
	| "ArmTimer"
	| "Publish"
	| "CancelTimer"
export interface Token {
	readonly authority: string
	readonly change: string
	readonly unit: string
	readonly incarnation: string
	readonly term: number
	readonly view: number
}
export type Report =
	| { readonly _tag: "Succeeded" }
	| {
			readonly _tag: "Failed"
			readonly cause: Cause.Cause<unknown>
			readonly creation: "NotStarted" | "Unknown"
	  }
export interface Command {
	readonly id: string
	readonly change: string
	readonly kind: CommandKind
	readonly token: Token
	readonly unit: string
	readonly target: Target
	readonly participant: string
	readonly timer: Option.Option<string>
	readonly status: Option.Option<Status>
	readonly disposition: "Pending" | "Reported" | "Obsolete"
	readonly report: Option.Option<Report>
}
export type TimerPurpose = "Operation" | "Trial" | "Evidence" | "Total"
export interface Timer {
	readonly id: string
	readonly change: string
	readonly generation: number
	readonly cause: Cause.Cause<unknown>
	readonly purpose: TimerPurpose
	readonly deadline: number
	readonly active: boolean
	readonly command: Option.Option<string>
}
export interface Status {
	readonly id: string
	readonly sequence: number
	readonly phase: Phase
	readonly oldChanged: boolean
	readonly recovering: boolean
	readonly member: MemberFact
	readonly remaining: number
	readonly leaseHolders: HashSet.HashSet<string>
	readonly unconfirmedUnits: HashSet.HashSet<string>
	readonly settlement: Settlement
	readonly cause: Cause.Cause<unknown>
	readonly conclusion: Option.Option<Conclusion>
}
export interface State {
	readonly authority: string
	readonly open: boolean
	readonly now: number
	readonly nextChange: number
	readonly historyLimit: number
	readonly history: ReadonlyArray<string>
	readonly maxUnits: number
	readonly instances: HashMap.HashMap<string, Instance>
	readonly cells: HashMap.HashMap<string, Cell>
	readonly units: HashMap.HashMap<string, Unit>
	readonly claims: HashMap.HashMap<string, Claim>
	readonly changes: HashMap.HashMap<string, Change>
	readonly active: HashSet.HashSet<string>
	readonly observers: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly commands: HashMap.HashMap<string, Command>
	readonly timers: HashMap.HashMap<string, Timer>
	readonly keys: HashMap.HashMap<
		string,
		{ readonly request: Request; readonly change: string }
	>
	readonly accesses: HashMap.HashMap<string, number>
}
export type Event =
	| {
			readonly _tag: "Requested"
			readonly request: Input
			readonly now: number
	  }
	| {
			readonly _tag: "TimerEnded"
			readonly timer: string
			readonly generation: number
			readonly cause: Cause.Cause<unknown>
			readonly now: number
	  }
	| { readonly _tag: "Observed"; readonly change: string; readonly now: number }
	| { readonly _tag: "Submit"; readonly request: Request; readonly now: number }
	| {
			readonly _tag: "Reported"
			readonly command: string
			readonly token: Token
			readonly result: Report
			readonly now: number
	  }
	| {
			readonly _tag: "Exited"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly cleanup: Cleanup
			readonly cause: Cause.Cause<unknown>
			readonly now: number
	  }
	| {
			readonly _tag: "TimerFired"
			readonly timer: string
			readonly generation: number
			readonly now: number
	  }
	| {
			readonly _tag: "Cancel"
			readonly change: string
			readonly cause: Cause.Cause<unknown>
			readonly now: number
	  }
	| {
			readonly _tag: "Invalidated"
			readonly object: string
			readonly cause: Cause.Cause<unknown>
			readonly now: number
	  }
	| { readonly _tag: "Shutdown"; readonly now: number }
export type Rejection =
	| "Closing"
	| "UnsupportedTarget"
	| "Unsupported"
	| "InvalidBudget"
	| "Busy"
	| "Stale"
	| "Capacity"
	| "KeyConflict"
export type Reply =
	| { readonly _tag: "None" }
	| { readonly _tag: "Admitted"; readonly change: string }
	| {
			readonly _tag: "Rejected"
			readonly reason: Rejection
			readonly conflicts: HashSet.HashSet<string>
	  }
export interface Transition {
	readonly state: State
	readonly commands: ReadonlyArray<Command>
	readonly reply: Reply
}
