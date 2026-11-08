import {
	Array,
	Context,
	Deferred,
	Effect,
	Layer,
	Logger,
	MutableRef,
	Option,
	Ref,
	Schema,
	Stream,
	String,
	Tracer,
	type Scope,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"
import otlp from "@graftland/plugin-otlp"
import { Exporter } from "@graftland/plugin-otlp/Exporter"
import http from "@graftland/plugin-otlp/http"
import * as Testing from "@graftland/plugin-otlp/Testing"

import { fixture, moduleLayer } from "./module-fixtures"
import thirdParty, { Sink, sink } from "./thirdParty"

const entry = (
	label: string,
	plugins = [{ id: "worker", name: "worker" }],
) => ({
	id: "traced",
	name: "@graftland/plugin-otlp",
	config: { exporter: { name: "third-party", config: { label } }, plugins },
})

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

describe("public exporter contract", () => {
	it.effect(
		"loads an explicit third-party exporter through Loader and keeps activations on config and plugins updates",
		() =>
			run(
				Effect.gen(function* () {
					const output = yield* sink
					const starts = yield* Ref.make(0)

					yield* Graft.provide(Sink, output)
					const resolver = yield* Layer.build(
						Layer.mergeAll(
							moduleLayer({
								"@graftland/plugin-otlp": fixture(
									"plugin-otlp-extensions-graftland-plugin-otlp-0",
								),
								"third-party": fixture("plugin-otlp-extensions-third-party-1"),
								worker: fixture("extensions-worker-1733"),
								other: fixture("extensions-other-1733"),
							}),
							Layer.succeed(
								Context.Service<{ readonly starts: typeof starts }>(
									"loader/fixture/extensions-worker-1733",
								),
								{ starts },
							),
						),
					).pipe(Effect.map(Context.get(ModuleResolver.ModuleResolver)))
					yield* Graft.provide(
						Context.Service<{ readonly starts: typeof starts }>(
							"loader/fixture/extensions-worker-1733",
						),
						{ starts },
					)
					yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
					const loader = yield* Graft.plugin(Loader.plugin, [entry("first")])
					yield* loader.stable
					const observed1 = yield* Ref.get(starts)
					assert.equal(observed1, 1)
					const found =
						yield* Deferred.make<(typeof Loader.Loader)["Service"]>()
					const probe = Plugin.make({
						name: "test/loaderProbe",
						inject: [Loader.Loader],
						apply: () =>
							Effect.flatMap(Loader.Loader, (service) =>
								Deferred.succeed(found, service),
							).pipe(Effect.asVoid),
					})
					yield* Graft.plugin(probe)
					const service = yield* Deferred.await(found)
					yield* service.update("traced", {
						config: entry("second", [
							{ id: "worker", name: "worker" },
							{ id: "other", name: "other" },
						]).config,
					})
					yield* service.ready
					yield* loader.stable
					assert.deepEqual(
						{
							worker: yield* Ref.get(starts),
							exporter: yield* Ref.get(output.starts),
						},
						{ worker: 1, exporter: 1 },
					)
					yield* loader.dispose
					const spans = yield* Ref.get(output.spans)
					assert.isTrue(Array.contains(spans, "first:graft.plugin test/worker"))
					assert.isTrue(Array.contains(spans, "second:graft.plugin test/other"))
				}),
			),
	)

	it.effect("restarts the subtree when switching exporter names", () =>
		run(
			Effect.gen(function* () {
				const output = yield* sink
				const starts = yield* Ref.make(0)

				yield* Graft.provide(Sink, output)
				const resolver = yield* Layer.build(
					Layer.mergeAll(
						moduleLayer({
							"third-party": fixture("plugin-otlp-extensions-third-party-0"),
							"another-exporter": fixture(
								"plugin-otlp-extensions-another-exporter-1",
							),
							worker: fixture("extensions-worker-3613"),
						}),
						Layer.succeed(
							Context.Service<{ readonly starts: typeof starts }>(
								"loader/fixture/extensions-worker-3613",
							),
							{ starts },
						),
					),
				).pipe(Effect.map(Context.get(ModuleResolver.ModuleResolver)))
				yield* Graft.provide(
					Context.Service<{ readonly starts: typeof starts }>(
						"loader/fixture/extensions-worker-3613",
					),
					{ starts },
				)
				yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
				const config = entry("first").config
				const fork = yield* Graft.plugin(otlp, config)
				yield* fork.stable
				yield* fork.update({
					...config,
					exporter: { name: "another-exporter", config: { label: "second" } },
				})
				yield* fork.stable
				const observed2 = yield* Ref.get(starts)
				assert.equal(observed2, 2)
				const observed3 = yield* Ref.get(output.starts)
				assert.equal(observed3, 2)
				yield* fork.dispose
				const spans = yield* Ref.get(output.spans)
				assert.isTrue(Array.contains(spans, "second:graft.plugin test/worker"))
			}),
		),
	)

	it.effect(
		"restarts after an exporter update defect and stops the subtree before flushing",
		() =>
			run(
				Effect.gen(function* () {
					const output = yield* sink
					const starts = yield* Ref.make(0)

					yield* Graft.provide(Sink, output)
					const resolver = yield* Layer.build(
						Layer.mergeAll(
							moduleLayer({
								"third-party": fixture("plugin-otlp-extensions-third-party-0"),
								worker: fixture("extensions-worker-5027"),
							}),
							Layer.succeed(
								Context.Service<{
									readonly starts: typeof starts
									readonly output: typeof output
								}>("loader/fixture/extensions-worker-5027"),
								{ starts, output },
							),
						),
					).pipe(Effect.map(Context.get(ModuleResolver.ModuleResolver)))
					yield* Graft.provide(
						Context.Service<{
							readonly starts: typeof starts
							readonly output: typeof output
						}>("loader/fixture/extensions-worker-5027"),
						{ starts, output },
					)
					yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
					const config = entry("first").config
					const fork = yield* Graft.plugin(otlp, config)
					yield* fork.stable
					yield* fork.update({
						...config,
						exporter: {
							name: "third-party",
							config: { label: "second", failUpdate: true },
						},
					})
					yield* fork.stable
					const observed4 = yield* Ref.get(starts)
					assert.equal(observed4, 2)
					yield* fork.dispose
					const observed5 = yield* Ref.get(output.journal)
					assert.deepEqual(observed5, ["stop", "flush", "stop", "flush"])
				}),
			),
	)

	it.effect("waits for HttpClient before starting the HTTP exporter", () =>
		run(
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(http, {
					url: "http://localhost:4318/v1/traces",
					serviceName: "test",
				})
				yield* fork.await
				const state = yield* Stream.runHead(fork.state)
				assert.deepEqual(Option.getOrThrow(state), {
					_tag: "Pending",
					missing: [HttpClient.HttpClient.key],
				})
			}),
		),
	)

	it.effect(
		"checks third-party publication, update identity and flush through the conformance kit",
		() =>
			run(
				Effect.gen(function* () {
					const output = yield* sink
					yield* Graft.provide(Sink, output)
					yield* Testing.exporter({
						plugin: thirdParty,
						config: { label: "one" },
						nextConfig: { label: "two" },
						received: Ref.get(output.spans),
					})
				}),
			),
	)

	it.effect("rejects an active exporter that publishes no service", () =>
		run(
			Effect.gen(function* () {
				const missing = Plugin.make({
					name: "test/missing",
					apply: () => Effect.void,
				})
				const result = yield* Effect.flip(
					Testing.exporter({
						plugin: missing,
						config: {},
						received: Effect.succeed(["exporter-conformance"]),
					}),
				)
				assert.equal(
					result.message,
					"The active plugin did not publish Exporter",
				)
			}),
		),
	)
})

it.effect("does not update an unchanged exporter when plugins change", () =>
	run(
		Effect.gen(function* () {
			const starts = yield* Ref.make(0)

			const resolver = yield* Layer.build(
				Layer.mergeAll(
					moduleLayer({
						fixed: fixture("extensions-fixed-7584"),
						worker: fixture("extensions-worker-7584"),
					}),
					Layer.succeed(
						Context.Service<{ readonly starts: typeof starts }>(
							"loader/fixture/extensions-fixed-7584",
						),
						{ starts },
					),
				),
			).pipe(Effect.map(Context.get(ModuleResolver.ModuleResolver)))
			yield* Graft.provide(
				Context.Service<{ readonly starts: typeof starts }>(
					"loader/fixture/extensions-fixed-7584",
				),
				{ starts },
			)
			yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
			const config = { exporter: { name: "fixed", config: {} }, plugins: [] }
			const fork = yield* Graft.plugin(otlp, config)
			yield* fork.stable
			yield* fork.update({ ...config, plugins: [{ name: "worker" }] })
			yield* fork.stable
			const count = yield* Ref.get(starts)
			assert.equal(count, 1)
		}),
	),
)

it.effect(
	"switches the HTTP shorthand to an explicit third-party exporter",
	() =>
		run(
			Effect.gen(function* () {
				const output = yield* sink
				const starts = yield* Ref.make(0)

				const resolver = yield* Layer.build(
					Layer.mergeAll(
						moduleLayer({
							"@graftland/plugin-otlp/http": fixture(
								"plugin-otlp-extensions-graftland-plugin-otlp-http-0",
							),
							"third-party": fixture("plugin-otlp-extensions-third-party-1"),
							worker: fixture("extensions-worker-8451"),
						}),
						Layer.succeed(
							Context.Service<{ readonly starts: typeof starts }>(
								"loader/fixture/extensions-worker-8451",
							),
							{ starts },
						),
					),
				).pipe(Effect.map(Context.get(ModuleResolver.ModuleResolver)))
				yield* Graft.provide(
					Context.Service<{ readonly starts: typeof starts }>(
						"loader/fixture/extensions-worker-8451",
					),
					{ starts },
				)
				yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
				yield* Graft.provide(Sink, output)
				yield* Graft.provide(
					HttpClient.HttpClient,
					HttpClient.make((request) =>
						Effect.succeed(HttpClientResponse.fromWeb(request, new Response())),
					),
				)
				const fork = yield* Graft.plugin(otlp, {
					url: "http://collector/v1/traces",
					serviceName: "test",
					plugins: [{ id: "worker", name: "worker" }],
				})
				yield* fork.stable
				yield* fork.update(entry("custom").config)
				yield* fork.stable
				const count = yield* Ref.get(starts)
				assert.equal(count, 2)
				yield* fork.dispose
				const spans = yield* Ref.get(output.spans)
				assert.isTrue(Array.contains(spans, "custom:graft.plugin test/worker"))
			}),
		),
)

it.effect("rejects an exporter that does not flush", () =>
	run(
		Effect.gen(function* () {
			const exporter = Plugin.make({
				name: "test/noFlush",
				apply: () => Graft.provide(Exporter, Tracer.nativeTracer),
			})
			const result = yield* Effect.flip(
				Testing.exporter({
					plugin: exporter,
					config: {},
					received: Effect.succeed([]),
				}),
			)
			assert.equal(
				result.message,
				"Closing the exporter did not flush the conformance span",
			)
		}),
	),
)

it.effect("isolates two exporter instances", () =>
	run(
		Effect.gen(function* () {
			const output = yield* sink

			const resolver = yield* Layer.build(
				moduleLayer({
					"third-party": fixture("plugin-otlp-extensions-third-party-0"),
					worker: fixture("extensions-worker-10154"),
				}),
			).pipe(Effect.map(Context.get(ModuleResolver.ModuleResolver)))
			yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
			yield* Graft.provide(Sink, output)
			const first = yield* Graft.plugin(otlp, entry("first").config)
			const second = yield* Graft.plugin(otlp, entry("second").config)
			yield* first.stable
			yield* second.stable
			yield* first.dispose
			yield* second.dispose
			const spans = yield* Ref.get(output.spans)
			assert.isTrue(Array.contains(spans, "first:graft.plugin test/worker"))
			assert.isTrue(Array.contains(spans, "second:graft.plugin test/worker"))
		}),
	),
)

it.effect("rejects an exporter that replaces its tracer on update", () =>
	run(
		Effect.gen(function* () {
			const exporter = Plugin.make({
				name: "test/replacingExporter",
				config: Schema.String,
				apply: Effect.fnUntraced(function* () {
					yield* Graft.provide(
						Exporter,
						Tracer.make({ span: Tracer.nativeTracer.span }),
					)
					return () => Effect.succeed(false)
				}),
			})
			const result = yield* Effect.flip(
				Testing.exporter({
					plugin: exporter,
					config: "first",
					nextConfig: "second",
					received: Effect.succeed([
						"exporter-conformance",
						"exporter-conformance",
					]),
				}),
			)
			assert.equal(result.message, "An update replaced the published tracer")
		}),
	),
)

for (const phase of ["startup", "task"] as const) {
	it.effect(
		`recovers the traced subtree after an exporter ${phase} retry without a config change`,
		() =>
			Effect.gen(function* () {
				const logs = MutableRef.make<ReadonlyArray<string>>([])
				const attempts = yield* Ref.make(0)
				const starts = yield* Ref.make(0)
				const started = yield* Deferred.make<void>()
				const stopped = yield* Deferred.make<void>()
				const recovered = yield* Deferred.make<void>()
				const retrying = yield* Deferred.make<void>()
				const resume = yield* Deferred.make<void>()

				const RetryGate = Context.Reference<
					Option.Option<{
						readonly retrying: typeof retrying
						readonly resume: typeof resume
					}>
				>("otlp/retry-gate", { defaultValue: () => Option.none() })
				return yield* run(
					Effect.gen(function* () {
						yield* Graft.provide(
							Context.Service<{
								readonly attempts: typeof attempts
								readonly phase: typeof phase
								readonly started: typeof started
								readonly retrying: typeof retrying
								readonly resume: typeof resume
							}>("otlp/retrying-exporter"),
							{ attempts, phase, started, retrying, resume },
						)
						yield* Graft.provide(
							Context.Service<{
								readonly attempts: typeof attempts
								readonly starts: typeof starts
								readonly started: typeof started
								readonly stopped: typeof stopped
								readonly recovered: typeof recovered
							}>("otlp/retrying-traced-worker"),
							{ attempts, starts, started, stopped, recovered },
						)

						const resolver = yield* Layer.build(
							moduleLayer({
								exporter: fixture("retrying-exporter"),
								worker: fixture("retrying-traced-worker"),
							}),
						).pipe(Effect.map(Context.get(ModuleResolver.ModuleResolver)))
						yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
						const fork = yield* Graft.plugin(otlp, {
							exporter: { name: "exporter" },
							plugins: [{ name: "worker" }],
						})
						yield* Deferred.await(retrying)
						if (phase === "task") yield* Deferred.await(stopped)
						yield* fork.stable
						const snapshot = yield* Stream.runHead(fork.state)
						const waiting = Option.getOrThrow(snapshot)
						assert.equal(waiting._tag, "Active")
						const before = yield* Ref.get(starts)
						assert.equal(before, phase === "startup" ? 0 : 1)
						yield* Deferred.succeed(resume, undefined)
						yield* Deferred.await(recovered)
						const after = yield* Ref.get(starts)
						assert.equal(after, phase === "startup" ? 1 : 2)
						const count = yield* Ref.get(attempts)
						assert.equal(count, 2)
						yield* fork.dispose
						assert.lengthOf(
							Array.filter(
								MutableRef.get(logs),
								String.includes(`exporter ${phase} failure`),
							),
							1,
						)
					}),
				).pipe(
					Effect.provide(
						Logger.layer([
							Logger.map(Logger.formatJson, (line) =>
								MutableRef.update(logs, Array.append(line)),
							),
						]),
					),
					Effect.provideService(RetryGate, Option.some({ retrying, resume })),
				)
			}),
	)
}
