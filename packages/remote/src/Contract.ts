import { Cause, Effect, Schema } from "effect"

/** An undeclared failure still crosses the boundary, with its diagnostic value. */
export class UndeclaredFailure extends Schema.TaggedError<
	UndeclaredFailure,
	{ readonly brand: unique symbol }
>()("UndeclaredFailure", { original: Schema.Defect({ includeStack: true }) }) {}

/** Pure metadata shared by the host and the executable runner bootstrap. */
export const make = <
	S extends Schema.Top & {
		readonly Encoded: Schema.Json
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	E extends Schema.Top & {
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
>(options: {
	readonly name: string
	readonly config: S
	readonly error: E
	readonly module: string
}) => {
	const failure = Schema.Union([options.error, UndeclaredFailure])
	const codec = Schema.toCodecJson(
		Schema.Cause(failure, Schema.Defect({ includeStack: true })),
	)
	const declared = Schema.is(options.error)
	return {
		...options,
		encodeCause: (cause: Cause.Cause<unknown>) =>
			Schema.encodeEffect(codec)(
				Cause.map(cause, (error) =>
					declared(error) ? error : UndeclaredFailure.make({ original: error }),
				),
			),
		decodeCause: Schema.decodeUnknownEffect(codec),
	}
}

/** The runner only needs encoding; the host retains the concrete error type. */
export interface RunnerContract {
	readonly name: string
	readonly module: string
	readonly encodeCause: (
		cause: Cause.Cause<unknown>,
	) => Effect.Effect<Schema.Json, Schema.SchemaError>
}
