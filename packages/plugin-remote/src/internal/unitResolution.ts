/** Schema-independent reference resolution in the fixed runtime facility. */
import process from "node:process"

import { Array, Effect, Option, Order, Record, Schema } from "effect"
import { Digest } from "effect/crypto"

import type { Kernel } from "@graftland/graft"

export class ResolutionFailed extends Schema.TaggedError<
	ResolutionFailed,
	{ readonly brand: unique symbol }
>()("ResolutionFailed", { reference: Schema.String }) {}
const jsonArray = (value: Schema.Json): value is Schema.JsonArray =>
	Array.isArray(value)
const resolveValue = (
	value: Schema.Json,
	values: Readonly<Record<string, Schema.Json>>,
): Effect.Effect<Schema.Json, ResolutionFailed> => {
	if (jsonArray(value))
		return Effect.forEach(value, (entry) => resolveValue(entry, values))
	if (value !== null && typeof value === "object") {
		const reference = Record.get<string, Schema.Json>(value, "$reference")
		if (
			Option.isSome(reference) &&
			typeof reference.value === "string" &&
			Record.keys<string, Schema.Json>(value).length === 1
		) {
			const name = reference.value
			return Option.match(Record.get(values, name), {
				onNone: () => ResolutionFailed.make({ reference: name }),
				onSome: Effect.succeed,
			})
		}
		return Effect.forEach(
			Record.toEntries<string, Schema.Json>(value),
			([key, entry]) =>
				Effect.map(
					resolveValue(entry, values),
					(resolved) =>
						[key, resolved] satisfies readonly [string, Schema.Json],
				),
		).pipe(Effect.map(Record.fromEntries))
	}
	return Effect.succeed(value)
}
const canonical = (value: Schema.Json): Schema.Json =>
	jsonArray(value)
		? Array.map(value, canonical)
		: value !== null && typeof value === "object"
			? Record.fromEntries(
					Array.map(
						Array.sort(Record.keys<string, Schema.Json>(value), Order.String),
						(key) => [key, canonical(value[key] ?? null)],
					),
				)
			: value
export const environment = (placement: Kernel.Placement) =>
	`effect@4.1.2/node@${process.versions.node}/${placement}/protocol@1`
export const fingerprint = Effect.fnUntraced(function* (value: Schema.Json) {
	const encoded = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.Json),
	)(canonical(value))
	const digest = yield* Digest.Digest
	return yield* digest.digestHex(
		Digest.sha256,
		new TextEncoder().encode(encoded),
	)
})
export const resolve = Effect.fnUntraced(function* (
	command: Kernel.Command,
): Effect.fn.Return<
	Kernel.ResolvedInput,
	ResolutionFailed | Schema.SchemaError,
	Digest.Digest
> {
	const input = yield* resolveValue(
		command.target.deployment?.input ?? {},
		command.policy?.values ?? {},
	)
	return {
		input,
		identity: yield* fingerprint(input),
		environment: environment(command.target.placement),
	}
})
