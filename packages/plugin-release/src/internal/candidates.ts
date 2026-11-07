import { Array, Effect, Record, Schema, type Scope } from "effect"

import type { Change } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

import type { ReleaseError } from "../Model"
import { failure, resolveInput } from "./storage"

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
	Array.isArray(value)
export const hasEnvironmentReference = (value: Schema.Json): boolean =>
	isJsonArray(value)
		? Array.some(value, hasEnvironmentReference)
		: value !== null && typeof value === "object"
			? "$env" in value ||
				Array.some(Record.values(value), hasEnvironmentReference)
			: false

/** Resolve a desired deployment anew without changing its retained input. */
export const resolve = Effect.fnUntraced(function* (
	desired: Change.Candidate,
	governed: boolean,
	validate: (
		deployment: Remote.CandidateOptions,
		input: Schema.Json,
	) => Effect.Effect<void, ReleaseError, Scope.Scope>,
) {
	const deployment = yield* Schema.decodeUnknownEffect(Remote.CandidateOptions)(
		desired.deployment,
	)
	if (governed && hasEnvironmentReference(deployment.input))
		return yield* failure(
			"Secrets",
			"Governed inputs must use host capability credential references",
		)
	const input = governed
		? deployment.input
		: yield* resolveInput(deployment.input)
	yield* validate(deployment, input)
	return Remote.candidate({ ...deployment, input })
})
