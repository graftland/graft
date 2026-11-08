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
])
const Cleanup = Schema.Union([
	Schema.TaggedStruct("Unknown", {}),
	Schema.TaggedStruct("Completed", {}),
	Schema.TaggedStruct("Failed", { cause: Cause }),
])
const Member = Schema.Struct({
	instance: Schema.String,
	reason: Schema.Literal("ExplicitTarget"),
	starting: Unit.Target,
	startingVersion: Schema.Int,
	desired: Unit.Target,
	actual: Schema.Option(Unit.Target),
	healthy: Schema.Boolean,
	matchesTarget: Schema.Boolean,
})
const Conclusion = Schema.Struct({
	calls: Strings,
	outcome: Outcome,
	phase: Phase,
	cause: Cause,
	member: Member,
	units: Strings,
})
const Status = Schema.Struct({
	outstandingCalls: Strings,
	id: Schema.String,
	sequence: Schema.Int,
	phase: Phase,
	oldChanged: Schema.Boolean,
	recovering: Schema.Boolean,
	member: Member,
	remaining: Schema.Finite,
	leaseHolders: Strings,
	unconfirmedUnits: Strings,
	settlement: Schema.Literals([
		"Unresolved",
		"Failed",
		"UnknownCleanup",
		"Satisfied",
	]),
	cause: Cause,
	conclusion: Schema.Option(Conclusion),
})
const Fact = Schema.Struct({
	description: Schema.Option(Unit.Description),
	endpoint: Schema.Option(Unit.Endpoint),
	progress: Schema.optionalKey(Schema.String),
	kind: Schema.Literals(["Inspection", "Execution"]),
	id: Schema.String,
	incarnation: Schema.String,
	instance: Schema.String,
	term: Schema.Int,
	target: Unit.Target,
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
const Input = Schema.Struct({
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
const Policy = Schema.Struct({
	instance: Schema.String,
	allowed: Schema.Array(Schema.String),
	values: Schema.Record(Schema.String, Schema.Json),
})
export type Policy = typeof Policy.Type
export const Request = Schema.Union([
	Schema.TaggedStruct("Ping", {}),
	Schema.TaggedStruct("Submit", { input: Input }),
	Schema.TaggedStruct("Inspect", { input: Input }),
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
