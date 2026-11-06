import { Array, Context, Effect, Schema } from "effect"

import { Manifest, type Transition } from "@graftland/graft"
import { Artifact, Publication } from "@graftland/plugin-remote"
import * as RemoteConfig from "@graftland/plugin-remote/Config"

export const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const SourceEntry = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.Literal("@graftland/plugin-remote"),
	config: Schema.Struct({
		package: Schema.NonEmptyString,
		entry: Manifest.PublicEntry,
		contract: Schema.NonEmptyString,
		target: RemoteConfig.ManagedHost.fields.target,
		config: Schema.Json,
		probes: Schema.Array(Schema.NonEmptyString),
	}),
})
export type SourceEntry = typeof SourceEntry.Type
export const Entry = Schema.Struct({
	id: Schema.NonEmptyString,
	contract: Schema.NonEmptyString,
	target: RemoteConfig.ManagedHost.fields.target,
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
	file: Schema.NonEmptyString,
	references: Schema.Array(Schema.NonEmptyString),
	revocations: Schema.Array(Schema.NonEmptyString),
})
export type Build = typeof Build.Type
export const Diagnostic = Schema.Struct({
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
	_tag: Schema.String,
	phase: Schema.String,
	reason: Schema.optionalKey(Schema.String),
	evidence: Schema.Array(
		Schema.Struct({
			attempt: Schema.Int,
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
export const summarize = (outcome: Transition.Outcome): OutcomeSummary => ({
	_tag: outcome._tag,
	phase: outcome.phase,
	...(outcome._tag === "Accepted" ? {} : { reason: outcome.reason }),
	evidence: Array.map(outcome.evidence, (evidence) => ({
		attempt: evidence.attempt,
		phase: evidence.phase,
		hasCause: evidence.cause !== undefined,
		...(evidence.termination === undefined
			? {}
			: {
					termination: {
						unit: evidence.termination.unit,
						state: evidence.termination.state,
					},
				}),
	})),
})
export const Event = Schema.Struct({
	kind: Schema.Literals([
		"Startup",
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
	overrideRevocations: Schema.optionalKey(Schema.Boolean),
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
export interface Applied {
	readonly status: Status
	readonly outcomes: ReadonlyArray<{
		readonly entry: string
		readonly compensation: boolean
		readonly outcome: Transition.Outcome
	}>
}
export const Apply = Schema.Struct({
	target: Id,
	expected: Id,
	overrideRevocations: Schema.optionalKey(Schema.Boolean),
})
export type Apply = typeof Apply.Type
export interface Options {
	readonly store: string
	readonly initial: string
	readonly host: Manifest.Host
	readonly socket?: string
	readonly policy?: Partial<Transition.Policy>
}
export const Config = Schema.Struct({
	store: Schema.NonEmptyString,
	initial: Id,
	host: Manifest.Host,
	socket: Schema.optionalKey(Schema.NonEmptyString),
})
export type Config = typeof Config.Type
export class Releases extends Context.Service<
	Releases,
	{
		readonly build: (request: Build) => Effect.Effect<string, ReleaseError>
		readonly plan: (target: string) => Effect.Effect<Plan, ReleaseError>
		readonly apply: (request: Apply) => Effect.Effect<Applied, ReleaseError>
		readonly rollback: (
			expected: string,
			overrideRevocations?: boolean,
		) => Effect.Effect<Applied, ReleaseError>
		readonly observe: Effect.Effect<Status>
		readonly history: Effect.Effect<ReadonlyArray<Event>>
	}
>()("@graftland/plugin-release/Model/Releases") {}
