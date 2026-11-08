/** Fixed control data. This module imports no business contract or implementation. */
import { Effect, Schema } from "effect"

export const Token = Schema.Struct({
	authority: Schema.String,
	change: Schema.String,
	unit: Schema.String,
	incarnation: Schema.String,
	term: Schema.Int,
	view: Schema.Int,
})
export type Token = typeof Token.Type
export const Artifact = Schema.Struct({
	directory: Schema.String,
	identity: Schema.Struct({
		version: Schema.Literal(1),
		algorithm: Schema.Literal("sha256"),
		digest: Schema.String,
		entry: Schema.String,
	}),
})
export const ConfigurationModule = Schema.Struct({
	artifact: Artifact,
	export: Schema.String,
	options: Schema.Json,
})
export const Deployment = Schema.Struct({
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
export const CallMessage = Schema.Union([
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
export type CallMessage = typeof CallMessage.Type
export const Command = Schema.Struct({
	members: Schema.HashMap(Schema.String, UnitMember),
	call: Schema.optionalKey(CallControl),
	id: Schema.String,
	kind: Schema.Literals([
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
	]),
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
export const Report = Schema.Union([
	Schema.TaggedStruct("Succeeded", {}),
	Schema.TaggedStruct("Resolved", { value: Resolved }),
	Schema.TaggedStruct("Described", { value: Description }),
	Schema.TaggedStruct("Started", {
		value: Description,
		endpoint: Schema.optionalKey(Endpoint),
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
])
export type Incoming = typeof Incoming.Type
export const Outgoing = Schema.Union([
	Schema.TaggedStruct("Call", { message: CallMessage }),
	Schema.TaggedStruct("Online", {}),
	Schema.TaggedStruct("Initialized", {}),
	Schema.TaggedStruct("Result", { command: Schema.String, result: Report }),
	Schema.TaggedStruct("Failure", { cause: Schema.Json }),
	Schema.TaggedStruct("Diagnostic", { cause: Schema.Json }),
	Schema.TaggedStruct("Cleanup", { cause: Schema.optionalKey(Schema.Json) }),
	Schema.TaggedStruct("Progress", { stage: Schema.String }),
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
