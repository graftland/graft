import {
	Array,
	Clock,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Tracer,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import otlp from "@graftland/plugin-otlp"
import { Exporter } from "@graftland/plugin-otlp/Exporter"
import http from "@graftland/plugin-otlp/http"

const worker = Plugin.make({ name: "test/worker", apply: () => Effect.void })
const base = {
	url: "http://collector/v1/traces",
	serviceName: "test",
	plugins: [{ name: "worker" }],
}
const layer = Layer.fresh(Graft.layer).pipe(
	Layer.provideMerge(
		ModuleResolver.fromRecord({ worker, "@graftland/plugin-otlp/http": http }),
	),
)

it.effect("honors exportInterval before shutdown", () =>
	Effect.gen(function* () {
		const requests = yield* Queue.unbounded<string>()
		yield* Graft.provide(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Queue.offer(requests, request.url).pipe(
					Effect.as(HttpClientResponse.fromWeb(request, new Response())),
				),
			),
		)
		const fork = yield* Graft.plugin(otlp, {
			...base,
			exportInterval: "50",
			maxBatchSize: "1000",
		})
		yield* fork.stable
		yield* TestClock.adjust("49 millis")
		const before = yield* Queue.clear(requests)
		assert.deepEqual(before, [])
		yield* TestClock.adjust("1 millis")
		const sent = yield* Queue.take(requests)
		assert.equal(sent, base.url)
	}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect("exports at maxBatchSize without waiting for the interval", () =>
	Effect.gen(function* () {
		const requests = yield* Queue.unbounded<string>()
		yield* Graft.provide(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Queue.offer(requests, request.url).pipe(
					Effect.as(HttpClientResponse.fromWeb(request, new Response())),
				),
			),
		)
		const fork = yield* Graft.plugin(otlp, {
			...base,
			exportInterval: "60000",
			maxBatchSize: "1",
		})
		yield* fork.stable
		const sent = yield* Queue.take(requests)
		assert.equal(sent, base.url)
	}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect("bounds a stalled shutdown flush with shutdownTimeout", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const interrupted = yield* Deferred.make<void>()
		yield* Graft.provide(
			HttpClient.HttpClient,
			HttpClient.make(() =>
				Deferred.succeed(started, undefined).pipe(
					Effect.andThen(Effect.never),
					Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
				),
			),
		)
		const fork = yield* Graft.plugin(otlp, {
			...base,
			exportInterval: "60000",
			shutdownTimeout: "50",
		})
		yield* fork.stable
		const disposing = yield* Effect.forkChild(fork.dispose)
		yield* Deferred.await(started)
		yield* TestClock.adjust("49 millis")
		const beforeTimeout = yield* Deferred.isDone(interrupted)
		assert.isFalse(beforeTimeout)
		yield* TestClock.adjust("1 millis")
		yield* Fiber.join(disposing)
		const afterTimeout = yield* Deferred.isDone(interrupted)
		assert.isTrue(afterTimeout)
	}).pipe(Effect.scoped, Effect.provide(layer)),
)

const publishedTracer = Effect.gen(function* () {
	const found = yield* Deferred.make<Tracer.Tracer>()
	yield* Graft.plugin(
		Plugin.make({
			name: "test/tracerProbe",
			inject: [Exporter],
			apply: () =>
				Effect.flatMap(Exporter, (tracer) =>
					Deferred.succeed(found, tracer),
				).pipe(Effect.asVoid),
		}),
	)
	return yield* Deferred.await(found)
})

it.effect(
	"flushes and closes a retired exporter when its last span ends while the plugin stays active",
	() =>
		Effect.gen(function* () {
			const requests = yield* Queue.unbounded<string>()
			yield* Graft.provide(
				HttpClient.HttpClient,
				HttpClient.make((request) =>
					Queue.offer(requests, request.url).pipe(
						Effect.as(HttpClientResponse.fromWeb(request, new Response())),
					),
				),
			)
			const config = {
				url: base.url,
				serviceName: "test",
				exportInterval: 60000,
				shutdownTimeout: 50,
			}
			const periodicStopped = yield* Deferred.make<void>()
			const clock = yield* Clock.Clock
			const fork = yield* Graft.plugin(http, config, {
				intercept: [
					Graft.intercept(Clock.Clock, () => ({
						...clock,
						sleep: (duration) =>
							clock
								.sleep(duration)
								.pipe(
									Effect.onInterrupt(() =>
										Duration.toMillis(duration) === 60000
											? Deferred.succeed(periodicStopped, undefined)
											: Effect.void,
									),
								),
					})),
				],
			})
			const tracer = yield* publishedTracer
			const span = yield* Effect.makeSpan("in-flight").pipe(
				Effect.withTracer(tracer),
			)
			yield* fork.update({ ...config, url: "http://replacement/v1/traces" })
			yield* fork.stable
			const observed1 = yield* Queue.clear(requests)
			assert.deepEqual(observed1, [])
			span.end(1n, Exit.void)
			const observed2 = yield* Queue.take(requests)
			assert.equal(observed2, base.url)
			yield* TestClock.adjust(0)
			// Closing the retired scope cancels its periodic export fiber.
			yield* Deferred.await(periodicStopped)

			yield* fork.await
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

for (const updates of [1, 5]) {
	it.effect(
		`closes ${updates} retired exporters and the current exporter within one shutdown timeout`,
		() =>
			Effect.gen(function* () {
				const started = yield* Queue.unbounded<string>()
				const interrupted = yield* Queue.unbounded<string>()
				yield* Graft.provide(
					HttpClient.HttpClient,
					HttpClient.make((request) =>
						Queue.offer(started, request.url).pipe(
							Effect.andThen(Effect.never),
							Effect.onInterrupt(() => Queue.offer(interrupted, request.url)),
						),
					),
				)
				const config = {
					url: base.url,
					serviceName: "test",
					exportInterval: 60000,
					shutdownTimeout: 50,
				}
				const fork = yield* Graft.plugin(http, config)
				const tracer = yield* publishedTracer
				for (const index of Array.range(0, updates)) {
					yield* Effect.makeSpan(`still-running-${index}`).pipe(
						Effect.withTracer(tracer),
					)
					yield* Effect.void.pipe(
						Effect.withSpan(`buffered-${index}`),
						Effect.withTracer(tracer),
					)
					if (index < updates) {
						yield* fork.update({
							...config,
							url: `http://collector-${index}/v1/traces`,
						})
						yield* fork.stable
					}
				}
				const disposing = yield* Effect.forkChild(fork.dispose)
				yield* Effect.forEach(Array.range(0, updates), () =>
					Queue.take(started),
				)
				yield* TestClock.adjust(49)
				const observed4 = yield* Queue.clear(interrupted)
				assert.deepEqual(observed4, [])
				yield* TestClock.adjust(1)
				assert.isDefined(disposing.pollUnsafe())
				yield* Fiber.join(disposing)
				const observed5 = yield* Queue.clear(interrupted)
				assert.lengthOf(observed5, updates + 1)
			}).pipe(Effect.scoped, Effect.provide(layer)),
	)
}

it.effect(
	"bounds draining and the subsequent Effect shutdown flush separately",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const interrupted = yield* Deferred.make<void>()
			yield* Graft.provide(
				HttpClient.HttpClient,
				HttpClient.make(() =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
					),
				),
			)
			const config = {
				url: base.url,
				serviceName: "test",
				exportInterval: 60000,
				shutdownTimeout: 50,
			}
			const fork = yield* Graft.plugin(http, config)
			const tracer = yield* publishedTracer
			yield* Effect.makeSpan("slow-span").pipe(Effect.withTracer(tracer))
			yield* Effect.void.pipe(
				Effect.withSpan("buffered-before-retirement"),
				Effect.withTracer(tracer),
			)
			yield* fork.update({ ...config, url: "http://replacement/v1/traces" })
			yield* fork.stable
			yield* TestClock.adjust(49)
			const beforeDrain = yield* Deferred.isDone(started)
			assert.isFalse(beforeDrain)
			yield* TestClock.adjust(1)
			yield* Deferred.await(started)
			yield* TestClock.adjust(49)
			const observed6 = yield* Deferred.isDone(interrupted)
			assert.isFalse(observed6)
			yield* TestClock.adjust(1)
			const observed7 = yield* Deferred.isDone(interrupted)
			assert.isTrue(observed7)
		}).pipe(Effect.scoped, Effect.provide(layer)),
)
