import { Schema } from "effect"

import type { Transition } from "@graftland/graft"

import * as Artifact from "../Artifact"

export const CandidateOptions = Schema.Struct({
	artifact: Artifact.Artifact,
	contractModule: Schema.NonEmptyString,
	target: Schema.Union([
		Schema.TaggedStruct("Worker", {
			execArgv: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
		Schema.TaggedStruct("Local", {
			command: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
		}),
	]),
	input: Schema.Json,
})
/** Deployment data for a captured direct execution unit. */
export type CandidateOptions = typeof CandidateOptions.Type
export const driverName = "@graftland/plugin-remote/direct"
export const candidate = (options: CandidateOptions): Transition.Candidate => ({
	driver: driverName,
	identity: `sha256-v${options.artifact.identity.version}:${options.artifact.identity.digest}:${options.artifact.identity.entry}`,
	deployment: options,
})
