import { Cause, Schema } from "effect"
import * as Contract from "../Contract"
import { ChildFailure } from "./childErrors"
import * as Control from "./control"

/** Control RPCs and child failures belong to the execution protocol, not the public descriptor. */
export const prepare = <
	S extends Schema.Top & {
		readonly Encoded: Schema.Json
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	E extends Schema.Top & {
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
>(
	contract: Contract.Contract<S, E>,
) => {
	const failure = Schema.Union([
		contract.error,
		Contract.UndeclaredFailure,
		ChildFailure,
	])
	const codec = Schema.toCodecJson(
		Schema.Cause(failure, Schema.Defect({ includeStack: true })),
	)
	const declared = Schema.is(failure)
	const normalizeCause = (cause: Cause.Cause<unknown>) =>
		Cause.map(cause, (error) =>
			declared(error)
				? error
				: Contract.UndeclaredFailure.make({ original: error }),
		)
	return {
		...contract,
		control: Control.make(codec),
		normalizeCause,
		encodeCause: (cause: Cause.Cause<unknown>) =>
			normalizeCause(cause).pipe(Schema.encodeEffect(codec)),
		decodeCause: Schema.decodeUnknownEffect(codec),
	}
}

export type RunnerContract = ReturnType<
	typeof prepare<Schema.Codec<unknown, Schema.Json>, Schema.Codec<unknown>>
>
