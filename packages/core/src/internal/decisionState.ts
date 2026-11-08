import type { Cause, HashMap, HashSet, Option, Schema } from "effect"

export type Strategy = "Overlap" | "Restart"
export type Placement = "Worker" | "Process" | "Runner"
export interface ArtifactData {
	readonly directory: string
	readonly identity: {
		readonly version: 1
		readonly algorithm: "sha256"
		readonly digest: string
		readonly module: string
	}
}
export interface ConfigurationModule {
	readonly artifact: ArtifactData
	readonly export: string
	readonly options: Schema.Json
}
export interface DeploymentData {
	readonly module?: string
	readonly environment?: ReadonlyArray<ConfigurationModule>
	readonly moduleSuffix?: string
	readonly inspection?: "Module"
	readonly moduleKind?: "Environment" | "Resolver"
	readonly contractArtifact?: ArtifactData
	readonly artifact: ArtifactData
	readonly contract?: string
	readonly input: Schema.Json
	readonly runner?: { readonly socket: string; readonly owner: string }
}
export interface ResolvedInput {
	readonly environmentModules?: ReadonlyArray<ConfigurationModule>
	readonly input: Schema.Json
	readonly identity: string
	readonly environment: string
}
/** A realm is a lookup boundary, independent of structural configuration containers. */
export interface RealmDeclaration {
	readonly id: string
	readonly parent: Option.Option<string>
	readonly isolated: HashSet.HashSet<string>
}
export interface PlacementRequirement {
	readonly kind: Placement
	readonly destination?: string
	readonly security?: string
}
export interface LocalRequirement {
	readonly key: string
	readonly optional: boolean
}
export interface ResourceDeclaration {
	readonly key: string
	readonly mode: "Shared" | "Exclusive"
	readonly overlap: boolean
}
export interface MemberDeclaration {
	readonly instance: string
	readonly declaration: string
	readonly parent: Option.Option<string>
	readonly realm: string
	readonly target: Target
	readonly localProvides: ReadonlyArray<string>
	readonly localRequires: ReadonlyArray<LocalRequirement>
	readonly provides: ReadonlyArray<BindingDeclaration>
	readonly requires: ReadonlyArray<
		BindingDeclaration & { readonly optional: boolean }
	>
	readonly resources: ReadonlyArray<ResourceDeclaration>
	readonly colocate: ReadonlyArray<string>
	readonly placement: Option.Option<PlacementRequirement>
	readonly overlap: boolean
	readonly probes: ReadonlyArray<string>
}
export interface ResolvedDependency {
	readonly ambiguous: boolean
	readonly kind: "Local" | "Contract"
	readonly service: string
	readonly provider: Option.Option<string>
	readonly optional: boolean
	readonly slots: HashSet.HashSet<string>
}
export interface DeploymentGroup {
	readonly id: string
	readonly version: number
	readonly members: HashSet.HashSet<string>
	readonly placement: PlacementRequirement
}
export interface GraphTopology {
	readonly resourceOwners: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly declarations: HashMap.HashMap<string, MemberDeclaration>
	readonly realms: HashMap.HashMap<string, RealmDeclaration>
	readonly providers: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly slotConsumers: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly dependencies: HashMap.HashMap<
		string,
		ReadonlyArray<ResolvedDependency>
	>
	readonly localConsumers: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly contractConsumers: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly children: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly colocations: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly membersByRealm: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly childRealms: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly groups: HashMap.HashMap<string, DeploymentGroup>
	readonly memberships: HashMap.HashMap<string, string>
	readonly nextGroup: number
}
export interface GraphProposal {
	readonly members: ReadonlyArray<MemberDeclaration>
	readonly removed: HashSet.HashSet<string>
	readonly explicit: HashSet.HashSet<string>
	readonly realms: ReadonlyArray<RealmDeclaration>
}
export interface SelectionReason {
	readonly kind:
		| "ExplicitTarget"
		| "OldGroup"
		| "NewGroup"
		| "LocalDependency"
		| "ContractProviderLost"
		| "StructuralChild"
	readonly from: string
}
export interface GroupPlan {
	readonly previousDependencies: HashMap.HashMap<
		string,
		ReadonlyArray<ResolvedDependency>
	>
	readonly previousRealms: HashMap.HashMap<
		string,
		Option.Option<RealmDeclaration>
	>
	readonly desiredRealms: HashMap.HashMap<
		string,
		Option.Option<RealmDeclaration>
	>
	readonly members: HashSet.HashSet<string>
	readonly reasons: HashMap.HashMap<string, HashSet.HashSet<SelectionReason>>
	readonly recoveryGroups: HashMap.HashMap<string, DeploymentGroup>
	readonly newGroups: HashMap.HashMap<string, DeploymentGroup>
	readonly previous: HashMap.HashMap<string, MemberDeclaration>
	readonly desired: HashMap.HashMap<string, MemberDeclaration>
	readonly dependencies: HashMap.HashMap<
		string,
		ReadonlyArray<ResolvedDependency>
	>
	readonly membershipCells: HashSet.HashSet<string>
	readonly absenceCells: HashSet.HashSet<string>
	readonly reads: HashSet.HashSet<string>
	readonly writes: HashSet.HashSet<string>
	readonly leases: HashSet.HashSet<string>
	readonly participants: HashSet.HashSet<string>
	readonly startWaves: ReadonlyArray<HashSet.HashSet<string>>
	readonly stopWaves: ReadonlyArray<HashSet.HashSet<string>>
	readonly recoveryWaves: ReadonlyArray<HashSet.HashSet<string>>
	readonly peakUnits: number
	readonly oldUnitCount: number
	readonly newUnitCount: number
	readonly nextGroup: number
	readonly proposal: GraphProposal
}
export interface BindingDeclaration {
	readonly unary: boolean
	readonly key: string
	readonly operations: ReadonlyArray<{
		readonly identity: string
		readonly tag: string
		readonly provenance: string
	}>
}
export interface FixedBinding {
	readonly consumer: string
	readonly provider: string
	readonly service: string
}
export interface Endpoint {
	readonly host: string
	readonly port: number
	readonly credential: string
}
export interface BindingRoute extends FixedBinding {
	readonly generation: number
	readonly id: string
	readonly unit: string
	readonly incarnation: string
	readonly term: number
	readonly endpoint: Endpoint
	readonly version: number
}
export interface BindingFault {
	readonly service: string
	readonly reason:
		| "MissingBinding"
		| "MissingOperation"
		| "ProvenanceMismatch"
		| "WireTagMismatch"
		| "DuplicateOperation"
		| "UnsupportedCallShape"
		| "MultipleProviders"
}
export interface RouteView {
	readonly routes: ReadonlyArray<BindingRoute>
}
export interface Description {
	readonly inspectionData?: Schema.Json
	readonly moduleExport?: "default" | "plugin"
	readonly artifact: string
	readonly configuration: string
	readonly environment: string
	readonly protocol: 1
	readonly members: ReadonlyArray<MemberDeclaration>
}
export interface Policy {
	readonly version: number
	readonly allowed: Option.Option<HashSet.HashSet<string>>
	readonly values: Readonly<Record<string, Schema.Json>>
}
export type PreparationResult =
	| {
			readonly _tag: "Rejected"
			readonly reason: Rejection
			readonly conflicts: HashSet.HashSet<string>
	  }
	| { readonly _tag: "Admitted"; readonly change: string }
	| { readonly _tag: "Described"; readonly description: Description }
export type PreparationPhase =
	| "Resolving"
	| "Spawning"
	| "Describing"
	| "Stopping"
	| "Terminating"
	| "Concluded"
export interface Preparation {
	readonly inspectedResolutions: HashMap.HashMap<string, ResolvedInput>
	readonly inspected: HashMap.HashMap<string, Description>
	readonly inspectionUnits: HashSet.HashSet<string>
	readonly interrupted: Option.Option<PreparationPhase>
	readonly parent?: string
	readonly claim: string
	readonly archived: boolean
	readonly id: string
	readonly request: Request
	readonly inspect: boolean
	readonly policyVersion: number
	readonly phase: PreparationPhase
	readonly unit: string
	readonly submitted: number
	readonly deadline: number
	readonly resolution: Option.Option<ResolvedInput>
	readonly description: Option.Option<Description>
	readonly failure: Option.Option<Rejection>
	readonly cause: Cause.Cause<unknown>
	readonly result: Option.Option<PreparationResult>
	readonly sequence: number
	readonly nextCommand: number
	readonly commandIds: HashSet.HashSet<string>
	readonly timerIds: HashSet.HashSet<string>
}
export interface PreparationStatus {
	readonly interrupted: Option.Option<PreparationPhase>
	readonly id: string
	readonly sequence: number
	readonly phase: PreparationPhase
	readonly instance: string
	readonly unit: string
	readonly remaining: number
	readonly unconfirmedUnits: HashSet.HashSet<string>
	readonly exitEvidence: Unit["evidence"]
	readonly cleanup: Cleanup
	readonly cause: Cause.Cause<unknown>
	readonly result: Option.Option<PreparationResult>
}
export interface DescriptionKey {
	readonly boundary: PlacementRequirement
	readonly target: Target
	readonly instance: string
	readonly realm: string
	readonly colocate: ReadonlyArray<string>
	readonly placement: Option.Option<PlacementRequirement>
}
export interface VerifiedDescription {
	readonly policyValues?: Readonly<Record<string, Schema.Json>>
	readonly target: Target
	readonly resolution: ResolvedInput
	readonly description: Description
}
/** Deployment data bounding supervisor restarts, as in OTP: at most `intensity` attempts per `period` milliseconds. */
export interface SupervisionDeclaration {
	readonly intensity?: number
	readonly period?: number
}
export interface SupervisionPolicy {
	readonly intensity: number
	readonly period: number
}
/** Supervisor facts for one instance: recent attempted restarts and whether it was escalated. */
export interface Supervision {
	readonly attempts: ReadonlyArray<number>
	readonly escalated: boolean
}
/** A restart that met a conflicting owner; it is tried again, never dropped. */
export interface PendingRestart {
	readonly kind: "Members" | "Unit"
	readonly unit: string
	readonly members: HashSet.HashSet<string>
	readonly cause: Cause.Cause<unknown>
}
/** Each recorded Change has at most one duty per stage, acknowledged in this order. */
export type RecordStage = "Intent" | "Commit" | "Conclusion"
/** Deployment data that names the recording role, the instance allowed to hold it and the instances whose Changes it records. */
export interface RecordingDeclaration {
	readonly recorder: string
	readonly instance: string
	readonly scope: ReadonlyArray<string>
	readonly maxRecords?: number
}
/** Deployment data naming the recording role, who may hold it and which instances need it. */
export interface RecordingPolicy {
	readonly recorder: string
	readonly instance: string
	readonly scope: HashSet.HashSet<string>
	readonly maxRecords: number
}
/** The live unit incarnation that registered for the recording role. */
export interface RecorderGrant {
	readonly recorder: string
	readonly unit: string
	readonly incarnation: string
}
/** The immutable payload a recorder stores before acknowledging. */
export interface RecordPayload {
	/** The kernel run: Change ids restart at change-1 in every run. */
	readonly run: string
	readonly change: string
	readonly stage: RecordStage
	readonly members: ReadonlyArray<string>
	readonly targets: ReadonlyArray<string>
	readonly outcome: Option.Option<Outcome>
}
/** One outstanding or discharged duty, bound to the owner incarnation that received it. */
export interface RecordDuty {
	readonly id: string
	readonly recorder: string
	readonly unit: string
	readonly incarnation: string
	readonly content: string
	readonly payload: RecordPayload
	readonly deliveries: number
	readonly acknowledged: boolean
}
/** Recording facts of one Change, projected from core state. */
export interface RecordingStatus {
	readonly required: boolean
	readonly gate: Option.Option<RecordStage>
	readonly outstanding: ReadonlyArray<RecordDuty>
	readonly blocked: boolean
}
export interface Working extends State {
	readonly emitted: ReadonlyArray<Command>
	readonly changed: HashSet.HashSet<string>
	readonly preparationsChanged: HashSet.HashSet<string>
	readonly descriptions: ReadonlyArray<{
		readonly change: string
		readonly result: PreparationResult
		readonly cause: Cause.Cause<unknown>
		readonly resolution: Option.Option<ResolvedInput>
	}>
	readonly admissions: ReadonlyArray<{
		readonly preparation: string
		readonly request: Request
	}>
	readonly reply: Reply
}
export interface Target {
	readonly identity: string
	readonly placement: Placement
	readonly overlap: boolean
	readonly deployment?: DeploymentData
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
export interface InspectionInput {
	readonly realm?: string
	readonly realms?: ReadonlyArray<RealmDeclaration>
	readonly colocate?: ReadonlyArray<string>
	readonly placement?: PlacementRequirement
	readonly key?: string | undefined
	readonly instance: string
	readonly target: Target
	readonly strategy?: Strategy | undefined
	readonly expected?: number | undefined
	readonly budget?: Partial<Budget> | undefined
	readonly requirements?: Partial<Requirements> | undefined
}
export type DeploymentOperation =
	| {
			readonly _tag: "Deploy"
			readonly instance: string
			readonly target: Target
			readonly realm?: string
			readonly colocate?: ReadonlyArray<string>
			readonly placement?: PlacementRequirement
			readonly expected?: number
	  }
	| {
			readonly _tag: "Remove"
			readonly instance: string
			readonly expected?: number
	  }

export interface Input {
	readonly operations: ReadonlyArray<DeploymentOperation>
	readonly realms?: ReadonlyArray<RealmDeclaration>
	readonly key?: string
	readonly strategy?: Strategy
	readonly budget?: Partial<Budget>
	readonly requirements?: Partial<Requirements>
}
export interface RequestIdentity {
	readonly mode: "Inspect" | "Deploy"
	readonly operations: ReadonlyArray<DeploymentOperation>
	readonly realms: ReadonlyArray<RealmDeclaration>
	readonly strategy: Strategy
	readonly budget: Budget
	readonly probes: ReadonlyArray<string>
	readonly trial: number
}

export interface Request {
	/** A supervisor restart: a busy admission defers it instead of dropping it. */
	readonly supervised?: PendingRestart
	readonly boundary?: PlacementRequirement
	readonly member?: MemberDeclaration
	readonly operations?: ReadonlyArray<DeploymentOperation>
	readonly realm?: string
	readonly realms?: ReadonlyArray<RealmDeclaration>
	readonly colocate?: ReadonlyArray<string>
	readonly placement?: PlacementRequirement
	readonly proposal?: GraphProposal
	readonly submitted?: number
	readonly preparation?: string
	readonly policyVersion?: number
	readonly description?: Description
	readonly resolution?: ResolvedInput
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
}
export interface Cell {
	readonly version: number
	readonly writer: Option.Option<string>
	readonly readers: HashSet.HashSet<string>
}
export interface Instance {
	readonly established: boolean
	readonly id: string
	readonly current: Option.Option<string>
	readonly term: number
}

export type Cleanup =
	| { readonly _tag: "Unknown" }
	| { readonly _tag: "Completed" }
	| { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> }
export interface UnitMember {
	readonly dependencies: ReadonlyArray<ResolvedDependency>
	readonly declaration: string
	readonly parent: Option.Option<string>
	readonly realm: string
	readonly placement: Option.Option<PlacementRequirement>
	readonly colocate: ReadonlyArray<string>
	readonly instance: string
	readonly target: Target
	readonly term: number
	readonly generation: number
}
export interface MemberExecution extends UnitMember {
	readonly endpoint: Option.Option<Endpoint>
	readonly phase:
		| "Declared"
		| "Preparing"
		| "Starting"
		| "Ready"
		| "Stopping"
		| "Stopped"
		| "NotStarted"
		| "Failed"
	readonly cleanup: Cleanup
	readonly cause: Cause.Cause<unknown>
}
export interface Unit {
	readonly placement: PlacementRequirement
	readonly memberBudget: Budget
	readonly memberHistory: HashMap.HashMap<string, MemberExecution>
	readonly localConsumers: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly children: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly group: string
	readonly members: HashMap.HashMap<string, MemberExecution>
	readonly description: Option.Option<Description>
	readonly progress?: string
	readonly kind: "Inspection" | "Execution"
	readonly id: string
	readonly incarnation: string
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
	| "Draining"
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
	readonly reasons: HashSet.HashSet<SelectionReason>
	readonly starting: Option.Option<Target>
	readonly startingVersion: number
	readonly desired: Option.Option<Target>
	readonly actual: Option.Option<Target>
	readonly healthy: boolean
	readonly matchesTarget: boolean
}
export interface Conclusion {
	readonly plan: GroupPlan
	readonly calls: HashSet.HashSet<string>
	readonly outcome: Outcome
	readonly phase: Phase
	readonly cause: Cause.Cause<unknown>
	readonly members: HashMap.HashMap<string, MemberFact>
	readonly units: HashSet.HashSet<string>
}
export interface Change {
	readonly currentGroup: Option.Option<string>
	readonly currentMember: Option.Option<string>
	readonly loadedGroups: HashSet.HashSet<string>
	readonly resolvedMembers: HashSet.HashSet<string>
	readonly serveWave: number
	readonly pendingUnits: HashSet.HashSet<string>
	readonly resolutions: HashMap.HashMap<string, ResolvedInput>
	readonly descriptions: HashMap.HashMap<string, Description>
	readonly plan: GroupPlan
	readonly hadServing: boolean
	readonly policyVersion: number
	readonly id: string
	readonly request: Request
	readonly startingVersions: HashMap.HashMap<string, number>
	readonly phase: Phase
	readonly interrupted: Option.Option<Phase>
	readonly oldUnits: HashSet.HashSet<string>
	readonly candidates: HashMap.HashMap<string, string>
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
	readonly invalidated: HashSet.HashSet<string>
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
	readonly transferred: HashSet.HashSet<string>
	readonly released: boolean
	readonly recorded: boolean
	readonly recordingGate: Option.Option<RecordStage>
	/** Member facts when execution finished; the conclusion reports these, not later faults. */
	readonly executed: Option.Option<HashMap.HashMap<string, MemberFact>>
}
export type CommandKind =
	| "ServeMembers"
	| "StopMembers"
	| "RestartMembers"
	| "ReadyMembers"
	| "RetireRoute"
	| "CallRegister"
	| "CallGrant"
	| "CallReject"
	| "CallCancel"
	| "CallCompleteAck"
	| "CallArmTimer"
	| "PublishCall"
	| "Resolve"
	| "Describe"
	| "PublishPreparation"
	| "Spawn"
	| "Start"
	| "Serve"
	| "Ready"
	| "Probe"
	| "Install"
	| "Activate"
	| "Discard"
	| "Stop"
	| "Terminate"
	| "ArmTimer"
	| "Publish"
	| "CancelTimer"
	| "Record"
export interface Token {
	readonly authority: string
	readonly change: string
	readonly unit: string
	readonly incarnation: string
	readonly members: HashMap.HashMap<string, MemberGeneration>
	readonly view: number
}
export interface MemberGeneration {
	readonly term: number
	readonly generation: number
}
export type Report =
	| { readonly _tag: "Succeeded" }
	| { readonly _tag: "Resolved"; readonly value: ResolvedInput }
	| { readonly _tag: "Described"; readonly value: Description }
	| {
			readonly _tag: "Started"
			readonly value: Description
			readonly endpoints: HashMap.HashMap<string, Endpoint>
	  }
	| {
			readonly _tag: "Failed"
			readonly reason?: "PluginExportMissing"
			readonly cause: Cause.Cause<unknown>
			readonly creation: "NotStarted" | "Unknown"
			readonly delivery?: "Unavailable"
	  }
export interface Command {
	readonly subjects: HashSet.HashSet<string>
	readonly placement: PlacementRequirement
	readonly resolutions: HashMap.HashMap<string, ResolvedInput>
	readonly descriptions: HashMap.HashMap<string, Description>
	readonly policies: HashMap.HashMap<string, Policy>
	readonly members: HashMap.HashMap<string, UnitMember>
	readonly call?: CallControl
	readonly callStatus?: CallFact
	readonly view?: RouteView
	readonly dispatched: boolean
	readonly resolution?: ResolvedInput
	readonly policy?: Policy
	readonly preparation?: PreparationStatus
	readonly probes?: ReadonlyArray<string>
	readonly description?: Description
	readonly record?: RecordDuty
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
	readonly plan: GroupPlan
	readonly outstandingCalls: HashSet.HashSet<string>
	readonly id: string
	readonly sequence: number
	readonly phase: Phase
	readonly oldChanged: boolean
	readonly recovering: boolean
	readonly members: HashMap.HashMap<string, MemberFact>
	readonly remaining: number
	readonly leaseHolders: HashSet.HashSet<string>
	readonly unconfirmedUnits: HashSet.HashSet<string>
	readonly settlement: Settlement
	readonly recording: RecordingStatus
	readonly cause: Cause.Cause<unknown>
	readonly conclusion: Option.Option<Conclusion>
}
export interface GraphIssue {
	readonly reason: Rejection
	readonly conflicts: HashSet.HashSet<string>
	readonly cause: Cause.Cause<unknown>
}
export interface State {
	readonly supervisionPolicy: SupervisionPolicy
	readonly supervision: HashMap.HashMap<string, Supervision>
	readonly pendingRestarts: HashMap.HashMap<string, PendingRestart>
	readonly recording: Option.Option<RecordingPolicy>
	readonly recorder: Option.Option<RecorderGrant>
	readonly records: HashMap.HashMap<string, RecordDuty>
	/** Unacknowledged duties; kept incrementally so admission reads no other Change. */
	readonly recordsOutstanding: number
	/** Stage slots promised to admitted recorded Changes that have not emitted them yet. */
	readonly recordsPromised: number
	readonly nextMemberOperation: number
	readonly memberOperations: HashMap.HashMap<string, MemberOperation>
	readonly memberOperationsByUnit: HashMap.HashMap<
		string,
		HashSet.HashSet<string>
	>
	readonly graphIssue: Option.Option<GraphIssue>
	readonly graph: GraphTopology
	readonly activeCalls: HashSet.HashSet<string>
	readonly calls: HashMap.HashMap<string, CallFact>
	readonly callsByUnit: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly callWaiters: HashMap.HashMap<string, CallWaiter>
	readonly waitingByBinding: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly callRequests: HashMap.HashMap<string, string>
	readonly cancelledCalls: HashSet.HashSet<string>
	readonly callSeen: HashSet.HashSet<string>
	readonly callHistory: ReadonlyArray<string>
	readonly callLimits: CallLimits
	readonly nextCallCommand: number
	readonly bindings: HashMap.HashMap<string, FixedBinding>
	readonly bindingConflicts: HashSet.HashSet<string>
	readonly providerBindings: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly consumerBindings: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly routes: HashMap.HashMap<string, BindingRoute>
	readonly authority: string
	/** Unique per kernel start; namespaces durable records across restarts. */
	readonly run: string
	readonly open: boolean
	readonly now: number
	readonly nextChange: number
	readonly nextPreparation: number
	readonly preparationHistory: ReadonlyArray<string>
	readonly verifiedHistory: ReadonlyArray<DescriptionKey>
	readonly preparations: HashMap.HashMap<string, Preparation>
	readonly preparationKeys: HashMap.HashMap<string, string>
	readonly verified: HashMap.HashMap<DescriptionKey, VerifiedDescription>
	readonly policies: HashMap.HashMap<string, Policy>
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
}
export interface MemberIdentity {
	readonly unit: string
	readonly incarnation: string
	readonly observer: string
	readonly member: string
	readonly term: number
	readonly generation: number
}
export type MemberSignal =
	| (MemberIdentity & { readonly _tag: "MemberReady" })
	| (MemberIdentity & {
			readonly _tag: "MemberFailed"
			readonly cause: Cause.Cause<unknown>
	  })
	| (MemberIdentity & {
			readonly _tag: "MemberStopped"
			readonly cleanup: Cleanup
			readonly cause: Cause.Cause<unknown>
	  })
export interface MemberOperation {
	readonly activated: HashSet.HashSet<string>
	readonly serveWave: number
	readonly stoppedAck: boolean
	readonly id: string
	readonly unit: string
	readonly incarnation: string
	readonly members: HashSet.HashSet<string>
	readonly phase:
		| "Stopping"
		| "Resolving"
		| "Starting"
		| "Serving"
		| "Installing"
		| "Activating"
		| "Completed"
		| "Failed"
		| "Unconfirmed"
	readonly retry: boolean
	readonly currentMember: Option.Option<string>
	readonly resolutions: HashMap.HashMap<string, ResolvedInput>
	readonly resolved: HashSet.HashSet<string>
	readonly reads: HashMap.HashMap<string, number>
	readonly writes: HashSet.HashSet<string>
	readonly participants: HashSet.HashSet<string>
	readonly installed: HashSet.HashSet<string>
	readonly deadline: number
	readonly cause: Cause.Cause<unknown>
	readonly nextCommand: number
	readonly commandIds: HashSet.HashSet<string>
	readonly timerIds: HashSet.HashSet<string>
}
/** Recorder messages arrive on the unit's own control channel, which identifies the unit incarnation. */
export type RecordingSignal =
	| {
			readonly _tag: "RecorderRegistered"
			readonly unit: string
			readonly incarnation: string
			readonly recorder: string
	  }
	| {
			readonly _tag: "RecordAcknowledged"
			readonly unit: string
			readonly incarnation: string
			readonly record: string
			readonly content: string
	  }
export type Event =
	| (MemberSignal & { readonly now: number })
	| (RecordingSignal & { readonly now: number })
	| (CallEvidence & { readonly now: number })
	| { readonly _tag: "CallExpired"; readonly key: string; readonly now: number }
	| {
			readonly _tag: "UnitDiagnostic"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly cause: Cause.Cause<unknown>
			readonly now: number
	  }
	| {
			readonly _tag: "UnitCleanup"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly cleanup: Cleanup
			readonly cause: Cause.Cause<unknown>
			readonly now: number
	  }
	| {
			readonly _tag: "UnitDisconnected"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly cause: Cause.Cause<unknown>
			readonly now: number
	  }
	| {
			readonly _tag: "UnitProgress"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly stage: string
			readonly now: number
	  }
	| {
			readonly _tag: "UnitFailed"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly cause: Cause.Cause<unknown>
			readonly now: number
	  }
	| {
			readonly _tag: "InspectRequested"
			readonly request: InspectionInput
			readonly now: number
	  }
	| {
			readonly _tag: "PreparationObserved"
			readonly preparation: string
			readonly now: number
	  }
	| {
			readonly _tag: "PolicyChanged"
			readonly instance: string
			/** Omitted: keep the current allowed set; only values change. */
			readonly allowed?: ReadonlyArray<string>
			readonly values: Readonly<Record<string, Schema.Json>>
			readonly now: number
	  }
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
	| "PlacementConflict"
	| "MissingProvider"
	| "AmbiguousProvider"
	| "DependencyCycle"
	| "IneligibleOverlap"
	| "InvalidDeclaration"
	| "ResourceConflict"
	| "PluginExportMissing"
	| "IncompatibleBinding"
	| "DescriptionFailed"
	| "Unauthorized"
	| "Closing"
	| "UnsupportedTarget"
	| "Unsupported"
	| "InvalidBudget"
	| "Busy"
	| "Stale"
	| "Capacity"
	| "KeyConflict"
	| "RecordingUnavailable"
	| "RecordingCapacity"
	| "SelfReplacement"
export type Reply =
	| { readonly _tag: "None" }
	| { readonly _tag: "Preparing"; readonly preparation: string }
	| {
			readonly _tag: "Admitted"
			readonly change: string
			readonly preparation?: string
	  }
	| {
			readonly _tag: "Rejected"
			readonly reason: Rejection
			readonly preparation?: string
			readonly cause?: Cause.Cause<unknown>
			readonly conflicts: HashSet.HashSet<string>
	  }
export interface Transition {
	readonly state: State
	readonly commands: ReadonlyArray<Command>
	readonly reply: Reply
}

export interface CallLimits {
	readonly concurrency: number
	readonly waiters: number
	readonly wait: number
}
export interface CallMemberIdentity {
	readonly member: string
	readonly term: number
	readonly generation: number
}
export type CallMessage = CallMemberIdentity &
	(
		| {
				readonly _tag: "Lost"
				readonly session: string
				readonly request: string
				readonly cause: Cause.Cause<unknown>
		  }
		| {
				readonly _tag: "Request"
				readonly session: string
				readonly request: string
				readonly service: string
				readonly lifecycle: boolean
				readonly nested: boolean
				readonly wait: number
		  }
		| {
				readonly _tag: "Cancel" | "Result"
				readonly session: string
				readonly request: string
		  }
		| {
				readonly _tag: "Complete"
				readonly key: string
				readonly cleanup: Cleanup
				readonly cause: Cause.Cause<unknown>
		  }
	)
export interface CallFact {
	readonly consumerMember: string
	readonly consumerTerm: number
	readonly consumerGeneration: number
	readonly providerMember: string
	readonly providerTerm: number
	readonly providerGeneration: number
	readonly key: string
	readonly consumer: string
	readonly consumerIncarnation: string
	readonly provider: string
	readonly providerIncarnation: string
	readonly session: string
	readonly request: string
	readonly service: string
	readonly route: BindingRoute
	readonly credit: boolean
	readonly dispatched: boolean
	readonly cancelled: boolean
	readonly result: "Pending" | "Received" | "Unknown"
	readonly completion: Option.Option<Cleanup>
	readonly cause: Cause.Cause<unknown>
	readonly sequence: number
}
export interface CallWaiter {
	readonly key: string
	readonly consumer: string
	readonly incarnation: string
	readonly message: Extract<CallMessage, { _tag: "Request" }>
	readonly deadline: number
}
export interface CallControl {
	readonly member: CallMemberIdentity
	readonly key: string
	readonly session: string
	readonly request: string
	readonly service: string
	readonly route?: BindingRoute
	readonly reason?: string
	readonly deadline?: number
	readonly tags?: ReadonlyArray<string>
}
export interface CallEvidence {
	readonly _tag: "CallObserved"
	readonly unit: string
	readonly incarnation: string
	readonly observer: string
	readonly message: CallMessage
}
