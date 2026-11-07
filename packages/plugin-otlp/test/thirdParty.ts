/** A third-party exporter fixture: all package imports use public subpaths. */
import { Array, Context, Effect, MutableRef, Ref, Schema, Tracer } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Exporter } from "@graftland/plugin-otlp/Exporter"

export class Sink extends Context.Service<
	Sink,
	{
		readonly spans: Ref.Ref<ReadonlyArray<string>>
		readonly journal: Ref.Ref<ReadonlyArray<string>>
		readonly starts: Ref.Ref<number>
	}
>()("@graftland/plugin-otlp/test/thirdParty/Sink") {}

export const sink = Effect.gen(function* () {
	return Sink.of({
		spans: yield* Ref.make<ReadonlyArray<string>>([]),
		journal: yield* Ref.make<ReadonlyArray<string>>([]),
		starts: yield* Ref.make(0),
	})
})
const Config = Schema.Struct({
	label: Schema.String,
	failUpdate: Schema.Boolean.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(false)),
	),
})
export default Plugin.make({
	name: "test/thirdParty",
	config: Config,
	inject: [Sink],
	apply: Effect.fnUntraced(function* (config) {
		const output = yield* Sink
		yield* Ref.update(output.starts, (n) => n + 1)
		// Tracer callbacks are synchronous; immutable arrays live behind mutable references.
		const buffer = MutableRef.make<ReadonlyArray<string>>([])
		const label = MutableRef.make(config.label)
		yield* Effect.addFinalizer(() =>
			Ref.update(output.journal, Array.append("flush")).pipe(
				Effect.andThen(
					Ref.update(output.spans, (spans) => [
						...spans,
						...MutableRef.get(buffer),
					]),
				),
			),
		)
		yield* Graft.provide(
			Exporter,
			Tracer.make({
				span: (options) => {
					const span = Tracer.nativeTracer.span(options)
					const destination = MutableRef.get(label)
					const end = span.end.bind(span)
					span.end = (endTime, exit) => {
						end(endTime, exit)
						MutableRef.update(
							buffer,
							Array.append(`${destination}:${span.name}`),
						)
						MutableRef.update(buffer, Array.append(span.name))
					}
					return span
				},
			}),
		)
		return Effect.fnUntraced(function* (next: typeof Config.Type) {
			if (next.failUpdate) return yield* Effect.die("Exporter update failed")
			MutableRef.set(label, next.label)
			return true
		})
	}),
})
