import { Schema } from "effect"

import { Manifest } from "@graftland/graft"

export const EntryInput = Schema.Struct({
	implementation: Manifest.EntryMetadata.fields.implementation,
	contracts: Manifest.EntryMetadata.fields.contracts,
	requirements: Manifest.Requirements,
	probes: Manifest.EntryMetadata.fields.probes,
})
export type EntryInput = typeof EntryInput.Type
export class PublicationError extends Schema.TaggedError<
	PublicationError,
	{ readonly brand: unique symbol }
>()("PublicationError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
