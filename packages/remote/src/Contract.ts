import { ChildFailure } from "./internal/childErrors"
export { ChildFailure }
import { Array, Cause, Predicate, Schema } from "effect"

import type { Service } from "./internal/services"
import * as Control from "./internal/control"
export { service } from "./internal/services"

const TypeId = "~@graftland/plugin-remote/Contract"

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
	// Keys are runtime strings; tuple types cannot distinguish independently created keys.
	const keys = Array.map(
		[...(options.inject ?? []), ...(options.provides ?? [])],
		(service) => service.key.key,
	)
	if (
		Array.dedupe(keys).length !== keys.length ||
		keys.includes(Control.endpoint)
	)
		throw new Error(
			"Service keys must be unique within a remote contract and must not use the control endpoint",
		)
	const failure = Schema.Union([options.error, UndeclaredFailure, ChildFailure])
	const codec = Schema.toCodecJson(
		Schema.Cause(failure, Schema.Defect({ includeStack: true })),
	)
	const declared = Schema.is(failure)
	const normalizeCause = (cause: Cause.Cause<unknown>) =>
		Cause.map(cause, (error) =>
			declared(error) ? error : UndeclaredFailure.make({ original: error }),
		)
	return {
		...options,
		control: Control.make(codec),
		normalizeCause,
		inject: options.inject ?? [],
		provides: options.provides ?? [],
		[TypeId]: TypeId,
		encodeCause: (cause: Cause.Cause<unknown>) =>
			normalizeCause(cause).pipe(Schema.encodeEffect(codec)),
		decodeCause: Schema.decodeUnknownEffect(codec),
	}
}

/** The shared config, error codecs, and service declarations for one remote plugin. */
export type Contract<
	S extends Schema.Top & {
		readonly Encoded: Schema.Json
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	E extends Schema.Top & {
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
> = ReturnType<typeof make<S, E>>

/** Dynamic imports retain the control server and cause normalization; hosts retain the declared error type. */
export type RunnerContract = Contract<
	Schema.Codec<unknown, Schema.Json>,
	Schema.Codec<unknown>
>

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
