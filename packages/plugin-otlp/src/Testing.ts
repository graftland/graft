/** Conformance checks for third-party trace exporter plugins. */
import { Array, Effect, Option, Ref, Schema, Tracer } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Exporter } from "./Exporter"
import { awaitExporter } from "./internal/awaitExporter"

export class ConformanceError extends Schema.TaggedError<
	ConformanceError,
	{ readonly brand: unique symbol }
>()("ConformanceError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}

/** Checks publication, stable identity on update, and flushing completed spans on close.
 * Supply a fresh Graft layer and a collector whose received effect returns flushed span names.
 */
export const exporter = <E, R>(options: {
	readonly plugin: Plugin.Plugin
	readonly config: unknown
	readonly nextConfig?: unknown
	readonly received: Effect.Effect<ReadonlyArray<string>, E, R>
}) =>
	Effect.gen(function* () {
		const previous = yield* Ref.make(Option.none<Tracer.Tracer>())
		const probe = Plugin.make({
			name: "@graftland/plugin-otlp/Testing/probe",
			inject: [Plugin.optional(Exporter)],
			apply: Effect.fnUntraced(function* () {
				const current = yield* Effect.serviceOption(Exporter)
				if (Option.isNone(current))
					return yield* ConformanceError.make({
						message: "The active plugin did not publish Exporter",
					})
				const before = yield* Ref.get(previous)
				if (Option.isSome(before) && before.value !== current.value)
					return yield* ConformanceError.make({
						message: "An update replaced the published tracer",
					})
				yield* Ref.set(previous, current)
				yield* Effect.void.pipe(
					Effect.withSpan("exporter-conformance"),
					Effect.withTracer(current.value),
				)
			}),
		})
		const fixture = Plugin.make({
			name: "@graftland/plugin-otlp/Testing/fixture",
			apply: Effect.fnUntraced(function* () {
				const provider = yield* Graft.plugin(options.plugin, options.config)
				yield* provider.stable
				yield* awaitExporter(provider).pipe(
					Effect.catchCause((cause) =>
						Effect.fail(
							ConformanceError.make({ message: "The exporter failed", cause }),
						),
					),
				)
				const first = yield* Graft.plugin(probe)
				yield* first.await
				yield* first.dispose
				if (options.nextConfig !== undefined) {
					yield* provider.update(options.nextConfig)
					yield* provider.stable
					yield* awaitExporter(provider).pipe(
						Effect.catchCause((cause) =>
							Effect.fail(
								ConformanceError.make({
									message: "The exporter failed",
									cause,
								}),
							),
						),
					)
					const second = yield* Graft.plugin(probe)
					yield* second.await
				}
			}),
		})
		yield* Effect.scoped(
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(fixture, undefined, {
					isolate: [Exporter],
				})
				yield* fork.await
			}),
		)
		const received = yield* options.received
		if (
			Array.filter(received, (name) => name === "exporter-conformance").length <
			(options.nextConfig === undefined ? 1 : 2)
		)
			return yield* ConformanceError.make({
				message: "Closing the exporter did not flush the conformance span",
			})
	})
