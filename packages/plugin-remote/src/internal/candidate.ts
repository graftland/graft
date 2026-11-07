import { Array, Record, Schema } from "effect"

import type { Change } from "@graftland/graft"

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
/** Copy JSON recursively so a caller cannot alter a retained recovery deployment. */
const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
	Array.isArray(value)
const snapshot = (value: Schema.Json): Schema.Json =>
	isJsonArray(value)
		? Object.freeze(Array.map(value, snapshot))
		: value !== null && typeof value === "object"
			? Object.freeze(Record.map(value, snapshot))
			: value

export const candidate = (options: CandidateOptions): Change.Candidate => {
	const deployment: CandidateOptions = Object.freeze({
		artifact: Object.freeze({
			...options.artifact,
			identity: Object.freeze({ ...options.artifact.identity }),
		}),
		contractModule: options.contractModule,
		target:
			options.target._tag === "Worker"
				? Object.freeze({
						_tag: "Worker",
						...(options.target.execArgv === undefined
							? {}
							: { execArgv: Object.freeze([...options.target.execArgv]) }),
					})
				: Object.freeze({
						_tag: "Local",
						...(options.target.command === undefined
							? {}
							: {
									command: Object.freeze([...options.target.command] as [
										string,
										...Array<string>,
									]),
								}),
					}),
		input: snapshot(options.input),
	})
	return Object.freeze({
		driver: driverName,
		identity: `sha256-v${deployment.artifact.identity.version}:${deployment.artifact.identity.digest}:${deployment.artifact.identity.entry}`,
		deployment,
	})
}
