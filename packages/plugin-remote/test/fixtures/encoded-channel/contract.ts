import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { identity, operation } from "../../../src/internal/operations"
import { Mode, type Declaration } from "./wire"

export class Rejected extends Schema.TaggedError<
	Rejected,
	{ readonly brand: unique symbol }
>()("Rejected", {
	reason: Schema.String,
	at: Schema.DateFromString,
}) {}

export const Input = Schema.Struct({
	id: Schema.String,
	mode: Mode,
	at: Schema.DateFromString,
})

export const makeContract = (tag: string, build: string) => {
	const rpc = operation(
		"@prototype/inspect",
		1,
		Rpc.make(tag, {
			payload: Input,
			success: Schema.DateFromString,
			error: Rejected,
		}),
	)
	const declared = identity(rpc)
	if (declared._tag === "None") throw new Error("Missing operation identity")
	// Extracted from the actual Rpc in each unit. Provenance is fixture input,
	// not a schema hash or evidence of compatibility.
	const declaration: Declaration = {
		identity: `${declared.value.name}@${declared.value.version}`,
		tag: rpc._tag,
		build,
	}
	return { group: RpcGroup.make(rpc), declaration }
}
