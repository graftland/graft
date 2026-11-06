/** The built-in OTLP/HTTP exporter, with a stable tracer across updates. */
import {
	Context,
	Effect,
	Exit,
	FiberSet,
	Latch,
	Layer,
	MutableRef,
	Record,
	Redacted,
	Ref,
	Schema,
	Scope,
	Tracer,
} from "effect"
import { HttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"

import { Graft, Plugin } from "@graftland/graft"

import { Http as Config } from "./Config"
import { Exporter } from "./Exporter"

export { Http as Config } from "./Config"

/** An exporter that lives in its own scope, so it can be swapped and flushed. */
const exporter = Effect.fnUntraced(function* (
	config: Config,
	parent: Scope.Scope,
) {
	const client = yield* HttpClient.HttpClient
	const scope = yield* Scope.fork(parent)
	const context = yield* Layer.buildWithScope(
		OtlpTracer.layer({
			url: config.url,
			resource: { serviceName: config.serviceName, ...config.resource },
			headers: Record.map(config.headers, Redacted.value),
			compression: config.compression,
			exportInterval: config.exportInterval,
			maxBatchSize: config.maxBatchSize,
			shutdownTimeout: config.shutdownTimeout,
		}).pipe(
			Layer.provide(
				config.serialization === "json"
					? OtlpSerialization.layerJson
					: OtlpSerialization.layerProtobuf,
			),
			Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
		),
		scope,
	).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
	const underlying = Context.get(context, Tracer.Tracer)
	const drained = yield* Latch.make(true)
	// Span creation and completion are synchronous Effect tracer callbacks.
	const active = MutableRef.make(0)
	const tracer = Tracer.make({
		span: (options) => {
			const span = underlying.span(options)
			MutableRef.update(active, (n) => n + 1)
			drained.closeUnsafe()
			const end = span.end.bind(span)
			span.end = (...args) => {
				if (span.status._tag === "Ended") return
				end(...args)
				if (MutableRef.updateAndGet(active, (n) => n - 1) === 0)
					drained.openUnsafe()
			}
			return span
		},
	})
	const retire = Effect.gen(function* () {
		yield* drained.await.pipe(Effect.timeoutOption(config.shutdownTimeout))
		yield* Scope.close(scope, Exit.void)
	})
	return { tracer, retire }
})

const sameExporter = Schema.toEquivalence(Config)

export default Plugin.make({
	name: "@graftland/plugin-otlp/http",
	config: Config,
	inject: [HttpClient.HttpClient],
	apply: Effect.fnUntraced(function* (config) {
		const parent = yield* Effect.acquireRelease(
			Scope.make("parallel"),
			(scope) => Scope.close(scope, Exit.void),
		)
		// The parent closes exporters and their retirement tasks concurrently.
		const retiring = yield* FiberSet.make<void, never>().pipe(
			Scope.provide(parent),
		)
		yield* Plugin.fork(FiberSet.join(retiring))
		const current = yield* Effect.map(exporter(config, parent), MutableRef.make)
		const tracer = Tracer.make({
			span: (options) => MutableRef.get(current).tracer.span(options),
		})
		yield* Graft.provide(Exporter, tracer)
		const settings = yield* Ref.make<Config>(config)
		// A new endpoint swaps the exporter; the traced plugins keep running.
		return Effect.fnUntraced(function* (next: Config) {
			const previousSettings = yield* Ref.get(settings)
			if (!sameExporter(previousSettings, next))
				yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const replacement = yield* exporter(next, parent)
						const previous = MutableRef.getAndSet(current, replacement)
						yield* Ref.set(settings, next)
						yield* FiberSet.run(retiring, Effect.interruptible(previous.retire))
					}),
				)
			return true
		})
	}),
})
