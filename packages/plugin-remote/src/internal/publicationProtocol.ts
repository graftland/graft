import { Schema } from "effect"

import { Manifest } from "@graftland/graft"

import { EntryInput } from "./publicationModel"

export const Request = Schema.Struct({
	directory: Schema.String,
	entry: EntryInput,
})
export const Response = Schema.toCodecJson(
	Schema.Exit(
		Manifest.Entry,
		Schema.Defect({ includeStack: true }),
		Schema.Defect({ includeStack: true }),
	),
)
