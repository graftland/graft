/** Fixed control data. This module imports no business contract or implementation. */
import { Effect, Schema } from "effect"

export const Token = Schema.Struct({
	authority: Schema.String,
	change: Schema.String,
	unit: Schema.String,
	incarnation: Schema.String,
	members: Schema.HashMap(
		Schema.String,
		Schema.Struct({ term: Schema.Int, generation: Schema.Int }),
	),
	view: Schema.Int,
})
export type Token = typeof Token.Type
export const Artifact = Schema.Struct({
	directory: Schema.String,
	identity: Schema.Struct({
		version: Schema.Literal(1),
		algorithm: Schema.Literal("sha256"),
		digest: Schema.String,
		module: Schema.String,
	}),
})
export const ConfigurationModule = Schema.Struct({
	artifact: Artifact,
	export: Schema.String,
	options: Schema.Json,
})
export const Deployment = Schema.Struct({
	module: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.Array(ConfigurationModule)),
	moduleSuffix: Schema.optionalKey(Schema.String),
	inspection: Schema.optionalKey(Schema.Literal("Module")),
	moduleKind: Schema.optionalKey(Schema.Literals(["Environment", "Resolver"])),
	artifact: Artifact,
	contractArtifact: Schema.optionalKey(Artifact),
	contract: Schema.optionalKey(Schema.String),
	input: Schema.Json,
	runner: Schema.optionalKey(
		Schema.Struct({ socket: Schema.String, owner: Schema.String }),
	),
	confinement: Schema.optionalKey(Schema.Literal("Sandbox")),
})
export const Target = Schema.Struct({
	identity: Schema.String,
	placement: Schema.Literals(["Worker", "Process", "Runner"]),
	overlap: Schema.Boolean,
	deployment: Schema.optionalKey(Deployment),
})
export const Resolved = Schema.Struct({
	environmentModules: Schema.optionalKey(Schema.Array(ConfigurationModule)),
	input: Schema.Json,
	identity: Schema.String,
	environment: Schema.String,
})
export const Budget = Schema.Struct({
	total: Schema.Finite,
	startup: Schema.Finite,
	probe: Schema.Finite,
	drain: Schema.Finite,
	stop: Schema.Finite,
	terminate: Schema.Finite,
})
export const Binding = Schema.Struct({
	unary: Schema.Boolean,
	key: Schema.String,
	operations: Schema.Array(
		Schema.Struct({
			identity: Schema.String,
			tag: Schema.String,
			provenance: Schema.String,
		}),
	),
})
export const PlacementRequirement = Schema.Struct({
	kind: Schema.Literals(["Worker", "Process", "Runner"]),
	destination: Schema.optionalKey(Schema.String),
	security: Schema.optionalKey(Schema.String),
})
export const DeclarationOptions = Schema.Struct({
	children: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
				module: Schema.String,
				input: Schema.Union([
					Schema.TaggedStruct("Parent", {}),
					Schema.TaggedStruct("Literal", { value: Schema.Json }),
				]),
				realm: Schema.optionalKey(Schema.String),
				placement: Schema.optionalKey(PlacementRequirement),
			}),
		),
	),
	resources: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				key: Schema.String,
				mode: Schema.Literals(["Shared", "Exclusive"]),
				overlap: Schema.Boolean,
			}),
		),
	),
	placement: Schema.optionalKey(PlacementRequirement),
	probes: Schema.optionalKey(Schema.Array(Schema.String)),
})
export const MemberDeclaration = Schema.Struct({
	instance: Schema.String,
	declaration: Schema.String,
	parent: Schema.Option(Schema.String),
	realm: Schema.String,
	target: Target,
	localProvides: Schema.Array(Schema.String),
	localRequires: Schema.Array(
		Schema.Struct({ key: Schema.String, optional: Schema.Boolean }),
	),
	provides: Schema.Array(Binding),
	requires: Schema.Array(
		Schema.Struct({ ...Binding.fields, optional: Schema.Boolean }),
	),
	resources: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			mode: Schema.Literals(["Shared", "Exclusive"]),
			overlap: Schema.Boolean,
		}),
	),
	colocate: Schema.Array(Schema.String),
	placement: Schema.Option(PlacementRequirement),
	overlap: Schema.Boolean,
	probes: Schema.Array(Schema.String),
})
export const UnitMember = Schema.Struct({
	dependencies: Schema.Array(
		Schema.Struct({
			ambiguous: Schema.Boolean,
			kind: Schema.Literals(["Local", "Contract"]),
			service: Schema.String,
			provider: Schema.Option(Schema.String),
			optional: Schema.Boolean,
			slots: Schema.HashSet(Schema.String),
		}),
	),
	declaration: Schema.String,
	parent: Schema.Option(Schema.String),
	realm: Schema.String,
	placement: Schema.Option(PlacementRequirement),
	colocate: Schema.Array(Schema.String),
	instance: Schema.String,
	target: Target,
	term: Schema.Int,
	generation: Schema.Int,
})
export const Description = Schema.Struct({
	inspectionData: Schema.optionalKey(Schema.Json),
	moduleExport: Schema.optionalKey(Schema.Literals(["default", "plugin"])),
	artifact: Schema.String,
	configuration: Schema.String,
	environment: Schema.String,
	protocol: Schema.Literal(1),
	members: Schema.Array(MemberDeclaration),
})
export const Endpoint = Schema.Struct({
	host: Schema.String,
	port: Schema.Int,
	credential: Schema.String,
})
export type Endpoint = typeof Endpoint.Type
export const BindingRoute = Schema.Struct({
	generation: Schema.Int,
	id: Schema.String,
	consumer: Schema.String,
	provider: Schema.String,
	service: Schema.String,
	unit: Schema.String,
	incarnation: Schema.String,
	term: Schema.Int,
	endpoint: Endpoint,
	version: Schema.Int,
})
export const RouteView = Schema.Struct({ routes: Schema.Array(BindingRoute) })
export type RouteView = typeof RouteView.Type
export const CallControl = Schema.Struct({
	member: Schema.Struct({
		member: Schema.String,
		term: Schema.Int,
		generation: Schema.Int,
	}),
	key: Schema.String,
	session: Schema.String,
	request: Schema.String,
	service: Schema.String,
	route: Schema.optionalKey(BindingRoute),
	reason: Schema.optionalKey(Schema.String),
	deadline: Schema.optionalKey(Schema.Finite),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type CallControl = typeof CallControl.Type
export const CallBody = Schema.Union([
	Schema.TaggedStruct("Lost", {
		session: Schema.String,
		request: Schema.String,
		cause: Schema.Json,
	}),
	Schema.TaggedStruct("Request", {
		session: Schema.String,
		request: Schema.String,
		service: Schema.String,
		lifecycle: Schema.Boolean,
		nested: Schema.Boolean,
		wait: Schema.Finite,
	}),
	Schema.Struct({
		_tag: Schema.Literals(["Cancel", "Result"]),
		session: Schema.String,
		request: Schema.String,
	}),
	Schema.TaggedStruct("Complete", {
		key: Schema.String,
		cleanup: Schema.Literals(["Completed", "Failed", "Unknown"]),
		cause: Schema.Json,
		cleanupCause: Schema.optionalKey(Schema.Json),
	}),
])
export type CallBody = typeof CallBody.Type
const CallIdentity = {
	member: Schema.String,
	term: Schema.Int,
	generation: Schema.Int,
}
export const CallMessage = Schema.Union([
	Schema.TaggedStruct("Lost", {
		...CallIdentity,
		session: Schema.String,
		request: Schema.String,
		cause: Schema.Json,
	}),
	Schema.TaggedStruct("Request", {
		...CallIdentity,
		session: Schema.String,
		request: Schema.String,
		service: Schema.String,
		lifecycle: Schema.Boolean,
		nested: Schema.Boolean,
		wait: Schema.Finite,
	}),
	Schema.Struct({
		...CallIdentity,
		_tag: Schema.Literals(["Cancel", "Result"]),
		session: Schema.String,
		request: Schema.String,
	}),
	Schema.TaggedStruct("Complete", {
		...CallIdentity,
		key: Schema.String,
		cleanup: Schema.Literals(["Completed", "Failed", "Unknown"]),
		cause: Schema.Json,
		cleanupCause: Schema.optionalKey(Schema.Json),
	}),
])
export type CallMessage = typeof CallMessage.Type
/** What a durable recorder reports from its journal when it registers. */
export const Recovered = Schema.Struct({
	keys: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			request: Schema.String,
			run: Schema.String,
			change: Schema.String,
		}),
	),
	unfinished: Schema.Array(
		Schema.Struct({
			run: Schema.String,
			change: Schema.String,
			members: Schema.Array(Schema.String),
		}),
	),
})
export const RecordDuty = Schema.Struct({
	id: Schema.String,
	recorder: Schema.String,
	unit: Schema.String,
	incarnation: Schema.String,
	content: Schema.String,
	payload: Schema.Struct({
		run: Schema.String,
		change: Schema.String,
		stage: Schema.Literals(["Intent", "Commit", "Conclusion"]),
		members: Schema.Array(Schema.String),
		targets: Schema.Array(Schema.String),
		outcome: Schema.Option(
			Schema.Literals([
				"Accepted",
				"Aborted",
				"Recovered",
				"RecoveryFailed",
				"Stuck",
			]),
		),
		facts: Schema.Array(
			Schema.Struct({
				instance: Schema.String,
				desired: Schema.Option(Schema.String),
				actual: Schema.Option(Schema.String),
				healthy: Schema.Boolean,
				attempt: Schema.Literals([
					"NotStarted",
					"Started",
					"Ready",
					"Failed",
					"Stopped",
				]),
			}),
		),
		key: Schema.Option(Schema.String),
		request: Schema.String,
		phase: Schema.String,
		diagnostic: Schema.String,
	}),
	deliveries: Schema.Int,
	acknowledged: Schema.Boolean,
})
export type RecordDuty = typeof RecordDuty.Type
export const Command = Schema.Struct({
	subjects: Schema.HashSet(Schema.String),
	placement: PlacementRequirement,
	resolutions: Schema.HashMap(Schema.String, Resolved),
	descriptions: Schema.HashMap(Schema.String, Description),
	policies: Schema.HashMap(
		Schema.String,
		Schema.Struct({
			version: Schema.Int,
			allowed: Schema.Option(Schema.HashSet(Schema.String)),
			sandbox: Schema.Boolean,
			values: Schema.Record(Schema.String, Schema.Json),
		}),
	),
	members: Schema.HashMap(Schema.String, UnitMember),
	call: Schema.optionalKey(CallControl),
	id: Schema.String,
	kind: Schema.Literals([
		"ServeMembers",
		"StopMembers",
		"RestartMembers",
		"ReadyMembers",
		"RetireRoute",
		"CallRegister",
		"CallGrant",
		"CallReject",
		"CallCancel",
		"CallCompleteAck",
		"CallArmTimer",
		"PublishCall",
		"Resolve",
		"Describe",
		"Spawn",
		"Start",
		"Serve",
		"Ready",
		"Probe",
		"Install",
		"Activate",
		"Discard",
		"Stop",
		"Terminate",
		"ArmTimer",
		"CancelTimer",
		"Publish",
		"PublishPreparation",
		"Record",
	]),
	record: Schema.optionalKey(RecordDuty),
	token: Token,
	target: Target,
	resolution: Schema.optionalKey(Resolved),
	description: Schema.optionalKey(Description),
	view: Schema.optionalKey(RouteView),
	probes: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Command = typeof Command.Type
export const Cause = Schema.toCodecJson(
	Schema.Cause(
		Schema.Defect({ includeStack: true }),
		Schema.Defect({ includeStack: true }),
	),
)
export const Cleanup = Schema.Union([
	Schema.TaggedStruct("Unknown", {}),
	Schema.TaggedStruct("Completed", {}),
	Schema.TaggedStruct("Failed", { cause: Cause }),
])
export const MemberExecution = Schema.Struct({
	...UnitMember.fields,
	endpoint: Schema.Option(Endpoint),
	phase: Schema.Literals([
		"Declared",
		"Preparing",
		"Starting",
		"Ready",
		"Stopping",
		"Stopped",
		"NotStarted",
		"Failed",
	]),
	cleanup: Cleanup,
	cause: Cause,
})
export const Report = Schema.Union([
	Schema.TaggedStruct("Succeeded", {}),
	Schema.TaggedStruct("Resolved", { value: Resolved }),
	Schema.TaggedStruct("Described", { value: Description }),
	Schema.TaggedStruct("Started", {
		value: Description,
		endpoints: Schema.HashMap(Schema.String, Endpoint),
	}),
	Schema.TaggedStruct("Failed", {
		reason: Schema.optionalKey(Schema.Literal("PluginExportMissing")),
		cause: Schema.Json,
		creation: Schema.Literals(["Unknown", "NotStarted"]),
		delivery: Schema.optionalKey(Schema.Literal("Unavailable")),
	}),
])
export type Report = typeof Report.Type
export const Incoming = Schema.Union([
	Schema.TaggedStruct("Init", { command: Command }),
	Schema.TaggedStruct("Run", { command: Command }),
	Schema.TaggedStruct("StdioGranted", {}),
	Schema.TaggedStruct("StdioDenied", {}),
	Schema.TaggedStruct("StdioIn", { bytes: Schema.Uint8Array }),
	Schema.TaggedStruct("StdioEnd", {}),
])
export type Incoming = typeof Incoming.Type
export const Outgoing = Schema.Union([
	Schema.TaggedStruct("MemberReady", {
		member: Schema.String,
		term: Schema.Int,
		generation: Schema.Int,
	}),
	Schema.TaggedStruct("MemberFailed", {
		member: Schema.String,
		term: Schema.Int,
		generation: Schema.Int,
		cause: Schema.Json,
	}),
	Schema.TaggedStruct("MemberStopped", {
		member: Schema.String,
		term: Schema.Int,
		generation: Schema.Int,
		cause: Schema.Json,
		cleanup: Schema.Literals(["Unknown", "Completed", "Failed"]),
	}),
	Schema.TaggedStruct("Call", { message: CallMessage }),
	Schema.TaggedStruct("Online", {}),
	Schema.TaggedStruct("Initialized", {}),
	Schema.TaggedStruct("Result", { command: Schema.String, result: Report }),
	Schema.TaggedStruct("Failure", { cause: Schema.Json }),
	Schema.TaggedStruct("Diagnostic", { cause: Schema.Json }),
	Schema.TaggedStruct("Cleanup", { cause: Schema.optionalKey(Schema.Json) }),
	Schema.TaggedStruct("Progress", { stage: Schema.String }),
	Schema.TaggedStruct("RecorderRegister", {
		recorder: Schema.String,
		recovered: Schema.optionalKey(Recovered),
	}),
	Schema.TaggedStruct("StdioClaim", {}),
	Schema.TaggedStruct("StdioOut", { bytes: Schema.Uint8Array }),
	Schema.TaggedStruct("StdioClose", {}),
	Schema.TaggedStruct("StdioRelease", {}),
	Schema.TaggedStruct("RecordAck", {
		record: Schema.String,
		content: Schema.String,
	}),
])
export type Outgoing = typeof Outgoing.Type

const encodeIncomingJson = Schema.encodeEffect(Schema.toCodecJson(Incoming))
const encodeOutgoingJson = Schema.encodeEffect(Schema.toCodecJson(Outgoing))
/** Encodes one complete fixed control frame before crossing an isolate boundary. */
export const encodeIncoming = (frame: Incoming) =>
	encodeIncomingJson(frame).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
	)
export const decodeIncoming = Schema.decodeUnknownEffect(
	Schema.toCodecJson(Incoming),
)
export const encodeOutgoing = (frame: Outgoing) =>
	encodeOutgoingJson(frame).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
	)
export const decodeOutgoing = Schema.decodeUnknownEffect(
	Schema.toCodecJson(Outgoing),
)
