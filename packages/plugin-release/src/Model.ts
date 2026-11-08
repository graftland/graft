import { Schema } from "effect"

import { Manifest } from "@graftland/graft"
import { Artifact, Publication } from "@graftland/plugin-remote"

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
	/** Captured contract bytes; releases built before the native workflow must be rebuilt. */
	contractArtifact: Schema.optionalKey(Artifact.Artifact),
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
export class ReleaseError extends Schema.TaggedError<
	ReleaseError,
	{ readonly brand: unique symbol }
>()("ReleaseError", {
	code: Schema.String,
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
