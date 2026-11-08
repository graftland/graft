/** Fixed control codecs contain no business schemas. */
import { Schema } from "effect"

import * as Unit from "./unitProtocol"

export const Address = Schema.Struct({
	host: Schema.String,
	port: Schema.Int,
	token: Schema.String,
})
export type Address = typeof Address.Type
/** Fixed deployment description accepted by the kernel executable. */
export const Deployment = Schema.Struct({
	authority: Schema.String,
	maxUnits: Schema.Int.check(Schema.isGreaterThan(0)),
	instances: Schema.Array(
		Schema.Struct({ id: Schema.String, target: Unit.Target }),
	),
	bindings: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				consumer: Schema.String,
				provider: Schema.String,
				service: Schema.String,
			}),
		),
	),
	callLimits: Schema.optionalKey(
		Schema.Struct({
			concurrency: Schema.optionalKey(Schema.Int),
			waiters: Schema.optionalKey(Schema.Int),
			wait: Schema.optionalKey(Schema.Finite),
		}),
	),
	supervision: Schema.optionalKey(
		Schema.Struct({
			intensity: Schema.optionalKey(
				Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			),
			period: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
		}),
	),
	recording: Schema.optionalKey(
		Schema.Struct({
			recorder: Schema.String,
			instance: Schema.String,
			scope: Schema.Array(Schema.String),
			maxRecords: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
		}),
	),
})
export type Deployment = typeof Deployment.Type
const Cause = Schema.Cause(
	Schema.Defect({ includeStack: true }),
	Schema.Defect({ includeStack: true }),
)
const Strings = Schema.HashSet(Schema.String)
const Phase = Schema.Literals([
	"Draining",
	"Resolving",
	"Spawning",
	"Starting",
	"Serving",
	"Readiness",
	"Probing",
	"Installing",
	"Trial",
	"Retiring",
	"Settling",
	"Concluded",
])
const Outcome = Schema.Literals([
	"Accepted",
	"Aborted",
	"Recovered",
	"RecoveryFailed",
	"Stuck",
])
const Rejection = Schema.Literals([
	"IncompatibleBinding",
	"PlacementConflict",
	"MissingProvider",
	"AmbiguousProvider",
	"DependencyCycle",
	"IneligibleOverlap",
	"InvalidDeclaration",
	"ResourceConflict",
	"DescriptionFailed",
	"PluginExportMissing",
	"Unauthorized",
	"Closing",
	"UnsupportedTarget",
	"Unsupported",
	"InvalidBudget",
	"Busy",
	"Stale",
	"Capacity",
	"KeyConflict",
	"RecordingUnavailable",
	"RecordingCapacity",
	"SelfReplacement",
])
const Cleanup = Schema.Union([
	Schema.TaggedStruct("Unknown", {}),
	Schema.TaggedStruct("Completed", {}),
	Schema.TaggedStruct("Failed", { cause: Cause }),
])
const Reason = Schema.Struct({
	kind: Schema.Literals([
		"ExplicitTarget",
		"OldGroup",
		"NewGroup",
		"LocalDependency",
		"ContractProviderLost",
		"StructuralChild",
	]),
	from: Schema.String,
})
const Dependency = Schema.Struct({
	kind: Schema.Literals(["Local", "Contract"]),
	service: Schema.String,
	provider: Schema.Option(Schema.String),
	optional: Schema.Boolean,
	slots: Strings,
	ambiguous: Schema.Boolean,
})
const Group = Schema.Struct({
	id: Schema.String,
	version: Schema.Int,
	members: Strings,
	placement: Unit.PlacementRequirement,
})
const Realm = Schema.Struct({
	id: Schema.String,
	parent: Schema.Option(Schema.String),
	isolated: Strings,
})
const Proposal = Schema.Struct({
	members: Schema.Array(Unit.MemberDeclaration),
	removed: Strings,
	explicit: Strings,
	realms: Schema.Array(Realm),
})
const Plan = Schema.Struct({
	previousDependencies: Schema.HashMap(Schema.String, Schema.Array(Dependency)),
	previousRealms: Schema.HashMap(Schema.String, Schema.Option(Realm)),
	desiredRealms: Schema.HashMap(Schema.String, Schema.Option(Realm)),
	members: Strings,
	reasons: Schema.HashMap(Schema.String, Schema.HashSet(Reason)),
	recoveryGroups: Schema.HashMap(Schema.String, Group),
	newGroups: Schema.HashMap(Schema.String, Group),
	previous: Schema.HashMap(Schema.String, Unit.MemberDeclaration),
	desired: Schema.HashMap(Schema.String, Unit.MemberDeclaration),
	dependencies: Schema.HashMap(Schema.String, Schema.Array(Dependency)),
	membershipCells: Strings,
	absenceCells: Strings,
	reads: Strings,
	writes: Strings,
	leases: Strings,
	participants: Strings,
	startWaves: Schema.Array(Strings),
	stopWaves: Schema.Array(Strings),
	recoveryWaves: Schema.Array(Strings),
	peakUnits: Schema.Int,
	oldUnitCount: Schema.Int,
	newUnitCount: Schema.Int,
	nextGroup: Schema.Int,
	proposal: Proposal,
})
const Member = Schema.Struct({
	instance: Schema.String,
	reasons: Schema.HashSet(Reason),
	starting: Schema.Option(Unit.Target),
	startingVersion: Schema.Int,
	desired: Schema.Option(Unit.Target),
	actual: Schema.Option(Unit.Target),
	healthy: Schema.Boolean,
	matchesTarget: Schema.Boolean,
})
const Conclusion = Schema.Struct({
	plan: Plan,
	calls: Strings,
	outcome: Outcome,
	phase: Phase,
	cause: Cause,
	members: Schema.HashMap(Schema.String, Member),
	units: Strings,
})
const Status = Schema.Struct({
	plan: Plan,
	outstandingCalls: Strings,
	id: Schema.String,
	sequence: Schema.Int,
	phase: Phase,
	oldChanged: Schema.Boolean,
	recovering: Schema.Boolean,
	members: Schema.HashMap(Schema.String, Member),
	remaining: Schema.Finite,
	leaseHolders: Strings,
	unconfirmedUnits: Strings,
	settlement: Schema.Literals([
		"Unresolved",
		"Failed",
		"UnknownCleanup",
		"Satisfied",
	]),
	recording: Schema.Struct({
		required: Schema.Boolean,
		gate: Schema.Option(Schema.Literals(["Intent", "Commit", "Conclusion"])),
		outstanding: Schema.Array(Unit.RecordDuty),
		blocked: Schema.Boolean,
	}),
	cause: Cause,
	conclusion: Schema.Option(Conclusion),
})
const Grant = Schema.Struct({
	recorder: Schema.String,
	unit: Schema.String,
	incarnation: Schema.String,
})
const Fact = Schema.Struct({
	placement: Unit.PlacementRequirement,
	memberBudget: Unit.Budget,
	memberHistory: Schema.HashMap(Schema.String, Unit.MemberExecution),
	localConsumers: Schema.HashMap(Schema.String, Strings),
	children: Schema.HashMap(Schema.String, Strings),
	group: Schema.String,
	members: Schema.HashMap(Schema.String, Unit.MemberExecution),
	description: Schema.Option(Unit.Description),
	progress: Schema.optionalKey(Schema.String),
	kind: Schema.Literals(["Inspection", "Execution"]),
	id: Schema.String,
	incarnation: Schema.String,
	owner: Schema.String,
	claim: Schema.String,
	spawn: Schema.String,
	phase: Schema.Literals([
		"PendingSpawn",
		"Running",
		"Terminating",
		"Exited",
		"NotStarted",
	]),
	evidence: Schema.Literals(["Missing", "Exited", "NotStarted"]),
	cleanup: Cleanup,
	cause: Cause,
	leases: Strings,
})
const PreparationPhase = Schema.Literals([
	"Resolving",
	"Spawning",
	"Describing",
	"Stopping",
	"Terminating",
	"Concluded",
])
const Preparation = Schema.Struct({
	interrupted: Schema.Option(PreparationPhase),
	id: Schema.String,
	sequence: Schema.Int,
	phase: PreparationPhase,
	instance: Schema.String,
	unit: Schema.String,
	remaining: Schema.Finite,
	unconfirmedUnits: Strings,
	exitEvidence: Schema.Literals(["Missing", "Exited", "NotStarted"]),
	cleanup: Cleanup,
	cause: Cause,
	result: Schema.Option(
		Schema.Union([
			Schema.TaggedStruct("Rejected", {
				reason: Rejection,
				conflicts: Strings,
			}),
			Schema.TaggedStruct("Admitted", { change: Schema.String }),
			Schema.TaggedStruct("Described", { description: Unit.Description }),
		]),
	),
})
const Call = Schema.Struct({
	consumerMember: Schema.String,
	consumerTerm: Schema.Int,
	consumerGeneration: Schema.Int,
	providerMember: Schema.String,
	providerTerm: Schema.Int,
	providerGeneration: Schema.Int,
	key: Schema.String,
	consumer: Schema.String,
	consumerIncarnation: Schema.String,
	provider: Schema.String,
	providerIncarnation: Schema.String,
	session: Schema.String,
	request: Schema.String,
	service: Schema.String,
	route: Unit.BindingRoute,
	credit: Schema.Boolean,
	dispatched: Schema.Boolean,
	cancelled: Schema.Boolean,
	result: Schema.Literals(["Pending", "Received", "Unknown"]),
	completion: Schema.Option(Cleanup),
	cause: Cause,
	sequence: Schema.Int,
})
const Waiter = Schema.Struct({
	key: Schema.String,
	consumer: Schema.String,
	incarnation: Schema.String,
	deadline: Schema.Finite,
	message: Schema.TaggedStruct("Request", {
		member: Schema.String,
		term: Schema.Int,
		generation: Schema.Int,
		session: Schema.String,
		request: Schema.String,
		service: Schema.String,
		lifecycle: Schema.Boolean,
		nested: Schema.Boolean,
		wait: Schema.Finite,
	}),
})
const Budget = Schema.Struct({
	total: Schema.optionalKey(Schema.Finite),
	startup: Schema.optionalKey(Schema.Finite),
	probe: Schema.optionalKey(Schema.Finite),
	drain: Schema.optionalKey(Schema.Finite),
	stop: Schema.optionalKey(Schema.Finite),
	terminate: Schema.optionalKey(Schema.Finite),
})
const InspectionInput = Schema.Struct({
	realm: Schema.optionalKey(Schema.String),
	realms: Schema.optionalKey(Schema.Array(Realm)),
	colocate: Schema.optionalKey(Schema.Array(Schema.String)),
	placement: Schema.optionalKey(Unit.PlacementRequirement),
	key: Schema.optional(Schema.String),
	instance: Schema.String,
	target: Unit.Target,
	strategy: Schema.optional(Schema.Literals(["Overlap", "Restart"])),
	expected: Schema.optional(Schema.Int),
	budget: Schema.optional(Budget),
	requirements: Schema.optional(
		Schema.Struct({
			trial: Schema.optionalKey(Schema.Finite),
			probes: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
	),
})
const Input = Schema.Struct({
	operations: Schema.Array(
		Schema.Union([
			Schema.TaggedStruct("Deploy", {
				instance: Schema.String,
				target: Unit.Target,
				expected: Schema.optionalKey(Schema.Int),
				realm: Schema.optionalKey(Schema.String),
				colocate: Schema.optionalKey(Schema.Array(Schema.String)),
				placement: Schema.optionalKey(Unit.PlacementRequirement),
			}),
			Schema.TaggedStruct("Remove", {
				instance: Schema.String,
				expected: Schema.optionalKey(Schema.Int),
			}),
		]),
	),
	realms: Schema.optionalKey(Schema.Array(Realm)),
	key: Schema.optionalKey(Schema.String),
	strategy: Schema.optionalKey(Schema.Literals(["Restart", "Overlap"])),
	budget: Schema.optionalKey(Budget),
	requirements: Schema.optionalKey(
		Schema.Struct({
			trial: Schema.optionalKey(Schema.Finite),
			probes: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
	),
})
const Policy = Schema.Struct({
	instance: Schema.String,
	/** Omitted: the operator's current allowed set is kept. */
	allowed: Schema.optionalKey(Schema.Array(Schema.String)),
	/** Omitted: the current sandbox requirement is kept. */
	sandbox: Schema.optionalKey(Schema.Boolean),
	values: Schema.Record(Schema.String, Schema.Json),
})
export type Policy = typeof Policy.Type
export const Request = Schema.Union([
	Schema.TaggedStruct("Ping", {}),
	Schema.TaggedStruct("Submit", { input: Input }),
	Schema.TaggedStruct("Inspect", { input: InspectionInput }),
	Schema.Struct({
		_tag: Schema.Literals(["Get", "Await", "Cancel", "GetPreparation"]),
		id: Schema.String,
	}),
	Schema.Struct({
		_tag: Schema.Literals([
			"Units",
			"Preparations",
			"Calls",
			"Waiters",
			"Recording",
			"Supervision",
			"Shutdown",
		]),
	}),
	Schema.TaggedStruct("SetPolicy", { policy: Policy }),
])
export type Request = typeof Request.Type
export const Response = Schema.Union([
	Schema.TaggedStruct("Submitted", { id: Schema.String }),
	Schema.TaggedStruct("Status", { value: Schema.Option(Status) }),
	Schema.TaggedStruct("Outcome", { value: Conclusion }),
	Schema.TaggedStruct("Units", { value: Schema.Array(Fact) }),
	Schema.TaggedStruct("Preparations", { value: Schema.Array(Preparation) }),
	Schema.TaggedStruct("Preparation", { value: Schema.Option(Preparation) }),
	Schema.TaggedStruct("Calls", { value: Schema.Array(Call) }),
	Schema.TaggedStruct("Waiters", { value: Schema.Array(Waiter) }),
	Schema.TaggedStruct("Supervision", {
		value: Schema.Array(
			Schema.Struct({
				instance: Schema.String,
				attempts: Schema.Array(Schema.Finite),
				escalated: Schema.Boolean,
			}),
		),
	}),
	Schema.TaggedStruct("Recording", {
		grant: Schema.Option(Grant),
		outstanding: Schema.Array(Unit.RecordDuty),
	}),
	Schema.TaggedStruct("Ack", {}),
	Schema.TaggedStruct("Failure", {
		reason: Schema.String,
		cause: Cause,
		conflicts: Schema.Array(Schema.String),
		preparation: Schema.optionalKey(Schema.String),
	}),
])
export type Response = typeof Response.Type
export const Incoming = Schema.Struct({
	id: Schema.String,
	token: Schema.String,
	request: Request,
})
export type Incoming = typeof Incoming.Type
export const Outgoing = Schema.Union([
	Schema.TaggedStruct("Reply", { id: Schema.String, result: Response }),
	Schema.TaggedStruct("Change", { value: Status }),
	Schema.TaggedStruct("Preparation", { value: Preparation }),
	Schema.TaggedStruct("Call", { value: Call }),
])
export type Outgoing = typeof Outgoing.Type
export const encodeRequest = Schema.encodeEffect(
	Schema.fromJsonString(Schema.toCodecJson(Incoming)),
)
export const decodeRequest = Schema.decodeEffect(
	Schema.fromJsonString(Schema.toCodecJson(Incoming)),
)
export const encodeResponse = Schema.encodeEffect(
	Schema.fromJsonString(Schema.toCodecJson(Outgoing)),
)
export const decodeResponse = Schema.decodeEffect(
	Schema.fromJsonString(Schema.toCodecJson(Outgoing)),
)
export class ControlError extends Schema.TaggedError<
	ControlError,
	{ readonly brand: unique symbol }
>()("ControlError", {
	reason: Schema.String,
	cause: Cause,
	conflicts: Schema.optionalKey(Schema.Array(Schema.String)),
	preparation: Schema.optionalKey(Schema.String),
}) {}
