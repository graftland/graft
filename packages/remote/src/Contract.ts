import { Array, Cause, Effect, Predicate, Schema } from "effect"

import { validateTags, type Service } from "./internal/services"
import { Control } from "./internal/control"
import { RpcGroup } from "effect/rpc"
export { service } from "./internal/services"

const TypeId = "~@graftland/remote/Contract"

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
	readonly inject?: ReadonlyArray<Service>
	readonly provides?: ReadonlyArray<Service>
}) => {
	validateTags(RpcGroup.make(), options.inject ?? [])
	validateTags(Control, options.provides ?? [])
	const failure = Schema.Union([options.error, UndeclaredFailure])
	const codec = Schema.toCodecJson(
		Schema.Cause(failure, Schema.Defect({ includeStack: true })),
	)
	const declared = Schema.is(options.error)
	return {
		...options,
		inject: options.inject ?? [],
		provides: options.provides ?? [],
		[TypeId]: TypeId,
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
	readonly [TypeId]: string
	readonly inject: ReadonlyArray<Service>
	readonly provides: ReadonlyArray<Service>
	readonly name: string
	readonly module: string
	readonly encodeCause: (
		cause: Cause.Cause<unknown>,
	) => Effect.Effect<Schema.Json, Schema.SchemaError>
}

export const isContract = (value: unknown): value is RunnerContract =>
	Predicate.hasProperty(value, TypeId) && value[TypeId] === TypeId

/** A contract module exports either default or a named contract. */
export const fromModule = (module: unknown) =>
	Array.findFirst(
		[
			Predicate.hasProperty(module, "default") ? module.default : undefined,
			Predicate.hasProperty(module, "contract") ? module.contract : undefined,
		],
		isContract,
	)
