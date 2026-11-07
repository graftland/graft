import { Schema } from "effect"

import { Manifest } from "@graftland/graft"
import { Artifact, Publication } from "@graftland/plugin-remote"
import * as Policy from "@graftland/plugin-remote/Policy"

export const Placement = Schema.Union([
	Schema.TaggedStruct("Worker", {
		execArgv: Schema.optionalKey(Schema.Array(Schema.String)),
	}),
	Schema.TaggedStruct("Local", {
		command: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
	}),
])
export const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const SourceEntry = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.Literal("@graftland/plugin-remote"),
	config: Schema.Struct({
		package: Schema.NonEmptyString,
		entry: Manifest.PublicEntry,
		contract: Schema.NonEmptyString,
		target: Placement,
		config: Schema.Json,
		probes: Schema.Array(Schema.NonEmptyString),
	}),
})
export type SourceEntry = typeof SourceEntry.Type
export const Entry = Schema.Struct({
	id: Schema.NonEmptyString,
	contract: Schema.String.check(Schema.isPattern(/^file:\/\//)),
	target: Placement,
	input: Schema.Json,
	probes: Schema.Array(Schema.NonEmptyString),
	artifact: Artifact.Artifact,
	package: Manifest.Package,
	entry: Manifest.PublicEntry,
	provenance: Publication.Provenance,
})
export type Entry = typeof Entry.Type
export const Release = Schema.Struct({
	version: Schema.Literal(1),
	entries: Schema.Array(Entry),
	references: Schema.Array(Schema.NonEmptyString),
	revocations: Schema.Array(Schema.NonEmptyString),
})
export type Release = typeof Release.Type
export const Build = Schema.Struct({
	metadataOnly: Schema.optionalKey(Schema.Boolean),
	file: Schema.NonEmptyString,
	references: Schema.Array(Schema.NonEmptyString),
	revocations: Schema.Array(Schema.NonEmptyString),
})
export type Build = typeof Build.Type
export const Diagnostic = Schema.Struct({
	reference: Schema.optionalKey(Schema.String),
	entry: Schema.String,
	code: Schema.String,
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
})
export type Diagnostic = typeof Diagnostic.Type
export const Change = Schema.Struct({
	entry: Schema.String,
	reasons: Schema.Array(
		Schema.Literals(["code", "config", "added", "removed"]),
	),
})
export type Change = typeof Change.Type
export const Plan = Schema.Struct({
	current: Id,
	target: Id,
	changes: Schema.Array(Change),
	diagnostics: Schema.Array(Diagnostic),
})
export type Plan = typeof Plan.Type
export const Status = Schema.Struct({
	current: Id,
	previous: Schema.NullOr(Id),
	state: Schema.Literals(["Ready", "Applying", "Degraded"]),
	revocations: Schema.Array(Schema.String),
})
export type Status = typeof Status.Type
/** Safe durable summary: never serializes arbitrary causes or resolved configuration. */
export const OutcomeSummary = Schema.Struct({
	change: Schema.String,
	_tag: Schema.Literals([
		"Accepted",
		"Aborted",
		"Recovered",
		"RecoveryFailed",
		"Stuck",
	]),
	phase: Schema.String,
	reason: Schema.optionalKey(Schema.String),
	evidence: Schema.Array(
		Schema.Struct({
			attempt: Schema.optionalKey(Schema.Int),
			phase: Schema.String,
			hasCause: Schema.Boolean,
			termination: Schema.optionalKey(
				Schema.Struct({
					unit: Schema.String,
					state: Schema.Literals(["Exited", "NotStarted"]),
				}),
			),
		}),
	),
})
export type OutcomeSummary = typeof OutcomeSummary.Type
/** Version-one journal data, independent of a runtime execution adapter. */
export const JournalObject = Schema.TaggedUnion({
	Instance: { instance: Schema.String },
	Slot: { realm: Schema.String, key: Schema.String },
	Edge: { consumer: Schema.String, provider: Schema.String },
})
export type JournalObject = typeof JournalObject.Type
export const RejectionSummary = Schema.Struct({
	reason: Schema.TaggedUnion({
		Busy: {
			conflicts: Schema.Array(
				Schema.Struct({
					object: JournalObject,
					holders: Schema.Array(Schema.String),
				}),
			),
		},
		Closing: {},
		UnsupportedTarget: { instance: Schema.String },
		InvalidBudget: { message: Schema.String },
		Stale: {
			object: JournalObject,
			expected: Schema.Finite,
			actual: Schema.Finite,
		},
		KeyConflict: { key: Schema.String },
		Capacity: { maxUnits: Schema.Finite, required: Schema.Finite },
		Unsupported: { message: Schema.String },
	}),
})
export type RejectionSummary = typeof RejectionSummary.Type
export const Event = Schema.Struct({
	approval: Schema.optionalKey(Policy.Approval),
	projection: Schema.optionalKey(Policy.ProjectionChange),
	revocations: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
	who: Schema.optionalKey(Schema.NonEmptyString),
	at: Schema.optionalKey(Schema.Finite),
	kind: Schema.Literals([
		"Bootstrap",
		"Startup",
		"Approval",
		"Projection",
		"Revocation",
		"Intent",
		"Outcome",
		"Compensation",
		"Commit",
		"Rejected",
	]),
	current: Id,
	target: Id,
	entry: Schema.optionalKey(Schema.String),
	outcome: Schema.optionalKey(OutcomeSummary),
	rejection: Schema.optionalKey(RejectionSummary),
	overrideRevocations: Schema.optionalKey(Schema.Boolean),
	entries: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Event = typeof Event.Type
export const Journal = Schema.Struct({
	version: Schema.Literal(1),
	status: Status,
	events: Schema.Array(Event),
})
export type Journal = typeof Journal.Type
export class ReleaseError extends Schema.TaggedError<
	ReleaseError,
	{ readonly brand: unique symbol }
>()("ReleaseError", {
	code: Schema.String,
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
