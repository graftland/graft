import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Queue,
	Ref,
	References,
	Schema,
	Scope,
} from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "@graftland/graft"

import * as Catalog from "../src/Catalog.ts"
import * as Extensions from "../src/Extensions.ts"
import core from "../src/index.ts"
import * as Prompts from "../src/Prompts.ts"
import * as Resources from "../src/Resources.ts"
import { transport } from "./support.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

for (const phase of ["notification", "publication"] as const) {
	it.effect(
		"emitter cancellation preserves removal " +
			phase +
			" and later reactivation",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const published = yield* Deferred.make<void>()
				const notices = yield* Ref.make(0)
				const blocking = yield* Ref.make(false)
				const adapter = yield* transport({
					registry: (server) =>
						Object.assign(server, {
							notifications: {
								...server.notifications,
								"notifications/resources/list_changed": () =>
									Effect.gen(function* () {
										if (
											phase === "notification" &&
											(yield* Ref.get(blocking))
										) {
											yield* Deferred.succeed(entered, undefined)
											yield* Deferred.await(release)
										}
										yield* Ref.update(notices, (n) => n + 1)
										if (yield* Ref.get(blocking))
											yield* Deferred.succeed(published, undefined)
									}),
							},
						}),
				})
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				const item: Resources.Resource = {
					name: "entry",
					uri: "test://entry",
					content: Effect.succeed("entry"),
				}
				const offers = yield* Ref.make<ReadonlyArray<Catalog.Offer>>([
					{ kind: Resources.kind, item },
				])
				yield* Event.on(Catalog.Offered, () => Ref.get(offers))
				yield* Event.emit(Catalog.Changed)
				assert.lengthOf((yield* client.listResources()).resources, 1)
				yield* Ref.set(notices, 0)
				yield* Ref.set(blocking, true)
				const replacement: Catalog.Offer = {
					kind: {
						...Resources.kind,
						key: "test/gated-publication",
						install: (item, annotations) =>
							// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the test preserves the public kind error until the projection logs it
							Resources.kind
								.install(item, annotations)
								.pipe(
									Effect.andThen(
										Deferred.succeed(entered, undefined).pipe(
											Effect.andThen(Deferred.await(release)),
										),
									),
								),
					},
					item: { ...item, uri: "test://replacement" },
				}
				yield* Ref.set(offers, phase === "publication" ? [replacement] : [])
				const emitter = yield* Event.emit(Catalog.Changed).pipe(
					Effect.forkScoped,
				)
				yield* Deferred.await(entered)
				assert.lengthOf(
					(yield* client.listResources()).resources,
					phase === "publication" ? 1 : 0,
				)
				// Cancelling the caller must finish even while its projection is gated immediately before publication.
				yield* Fiber.interrupt(emitter)
				yield* Deferred.succeed(release, undefined)
				const stopped = yield* Fiber.await(emitter)
				assert.isTrue(
					Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause),
				)
				// Wait for this batch's notification, never a second sync that could mask a lost publication.
				yield* Deferred.await(published)
				const listed = yield* client.listResources()
				assert.deepStrictEqual(
					Array.map(listed.resources, (resource) => resource.uri),
					phase === "publication" ? ["test://replacement"] : [],
				)
				const missing = yield* Effect.isFailure(
					client.readResource({ uri: "test://entry" }),
				)
				assert.isTrue(missing)
				const observed1 = yield* Ref.get(notices)
				assert.equal(observed1, 1)
				yield* Ref.set(blocking, false)
				yield* Ref.set(offers, [{ kind: Resources.kind, item }])
				yield* Event.emit(Catalog.Changed)
				assert.lengthOf((yield* client.listResources()).resources, 1)
			}).pipe(run),
	)
}

it.effect(
	"failed installs are logged once and retried only after the offer changes",
	() =>
		Effect.gen(function* () {
			const logs = yield* Queue.unbounded<ReadonlyArray<unknown>>()
			const logger = Logger.layer([
				Logger.make((entry) =>
					Queue.offerUnsafe(
						logs,
						Array.isArray(entry.message) ? entry.message : [entry.message],
					),
				),
			])
			yield* Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				const attempts = yield* Ref.make(0)
				const notices = yield* Ref.make(0)
				const adapter = yield* transport({
					registry: (server) =>
						Object.assign(server, {
							notifications: {
								...server.notifications,
								"notifications/resources/list_changed": () =>
									Ref.update(notices, (n) => n + 1),
							},
						}),
				})
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				const kind: Catalog.Kind<{ readonly uri: string }> = {
					key: "test/failing-kind",
					list: "resources",
					identities: (item) => [item.uri],
					install: (item, annotations) =>
						Ref.update(attempts, (n) => n + 1).pipe(
							Effect.andThen(
								McpServer.registerResource({
									...item,
									name: item.uri,
									content: Effect.succeed("hidden"),
									annotations,
								}),
							),
							Effect.andThen(Effect.die("broken install")),
						),
				}
				const item = yield* Ref.make({ uri: "test://broken" })
				yield* Event.on(Catalog.Offered, () =>
					Effect.map(Ref.get(item), (item) => [{ kind, item }]),
				)
				yield* Event.emit(Catalog.Changed)
				const initialNotices = yield* Ref.get(notices)
				for (let i = 0; i < 3; i++) yield* Event.emit(Catalog.Changed)
				const observed2 = yield* Ref.get(attempts)
				assert.equal(observed2, 1)
				const observed3 = yield* Ref.get(notices)
				assert.equal(observed3, initialNotices)
				const entries = yield* Queue.clear(logs)
				assert.lengthOf(
					Array.filter(entries, (messages) =>
						messages.includes("Installing an MCP catalog item failed"),
					),
					1,
				)
				assert.deepStrictEqual((yield* client.listResources()).resources, [])
				const conflict = yield* Scope.make()
				yield* Event.on(Catalog.Offered, () =>
					Effect.succeed([{ kind, item: { uri: "test://broken" } }]),
				).pipe(Scope.provide(conflict))
				yield* Event.emit(Catalog.Changed)
				yield* Scope.close(conflict, Exit.void)
				yield* Event.emit(Catalog.Changed)
				const afterConflict = yield* Ref.get(attempts)
				assert.equal(afterConflict, 1)
				yield* Ref.set(item, { uri: "test://broken" })
				yield* Event.emit(Catalog.Changed)
				const observed4 = yield* Ref.get(attempts)
				assert.equal(observed4, 2)
			}).pipe(run, Effect.provide(logger))
		}),
)

it.effect(
	"extension conflicts and failures log once per newly observed state per transport",
	() =>
		Effect.gen(function* () {
			const logs = yield* Queue.unbounded<{
				readonly message: ReadonlyArray<unknown>
				readonly plugin: unknown
			}>()
			const logger = Logger.layer([
				Logger.make((entry) =>
					Queue.offerUnsafe(logs, {
						message: [
							...(Array.isArray(entry.message)
								? entry.message
								: [entry.message]),
							...Array.map(entry.cause.reasons, (reason) =>
								reason._tag === "Fail"
									? reason.error
									: reason._tag === "Die"
										? reason.defect
										: reason,
							),
						],
						plugin: entry.fiber.getRef(References.CurrentLogAnnotations)[
							"graft.plugin"
						],
					}),
				),
			])
			yield* Effect.gen(function* () {
				const value = yield* Ref.make(2)
				const failing = yield* Ref.make(true)
				yield* Event.on(Extensions.Declared, () =>
					Effect.succeed({ "com.acme/x": 1 }),
				)
				yield* Event.on(Extensions.Declared, () =>
					Effect.map(Ref.get(value), (value) => ({ "com.acme/x": value })),
				)
				yield* Event.on(Extensions.Declared, () =>
					Effect.flatMap(Ref.get(failing), (fail) =>
						fail ? Effect.die("declaration failed") : Effect.succeed({}),
					),
				)
				yield* (yield* Graft.plugin(core, {})).await
				for (const name of ["test/one", "test/two"]) {
					const adapter = yield* transport({ name })
					yield* (yield* Graft.plugin(adapter.plugin)).await
				}
				for (let i = 0; i < 3; i++) yield* Event.emit(Catalog.Changed)
				const count = (
					entries: ReadonlyArray<{ readonly message: ReadonlyArray<unknown> }>,
					tag: string,
				) =>
					Array.filter(entries, ({ message }) =>
						Array.some(
							message,
							(value) =>
								value === tag ||
								(typeof value === "object" &&
									value !== null &&
									"_tag" in value &&
									value._tag === tag),
						),
					).length
				const initial = yield* Queue.clear(logs)
				assert.equal(count(initial, "ExtensionConflict"), 2)
				assert.equal(count(initial, "An extension declaration failed"), 2)
				assert.deepStrictEqual(
					Array.dedupe(
						Array.map(
							Array.filter(initial, ({ message }) =>
								message.includes("An extension declaration failed"),
							),
							(entry) => entry.plugin,
						),
					),
					["test/one", "test/two"],
				)
				yield* Ref.set(value, 3)
				yield* Ref.set(failing, false)
				yield* Event.emit(Catalog.Changed)
				const changed = yield* Queue.clear(logs)
				assert.equal(count(changed, "ExtensionConflict"), 2)
				yield* Ref.set(failing, true)
				yield* Event.emit(Catalog.Changed)
				const returned = yield* Queue.clear(logs)
				assert.equal(count(returned, "An extension declaration failed"), 2)
			}).pipe(run, Effect.provide(logger))
		}),
)

for (const protocolVersion of ["2026-07-28", "2025-11-25"] as const) {
	for (const target of ["prompt", "template"] as const) {
		it.effect(
			protocolVersion +
				": replacement cannot reach a withdrawn " +
				target +
				" completion",
			() =>
				Effect.gen(function* () {
					yield* (yield* Graft.plugin(core, {})).await
					const adapter = yield* transport({ protocolVersion })
					yield* (yield* Graft.plugin(adapter.plugin)).await
					const client = yield* adapter.client
					const owner = yield* Scope.make()
					const offer = (completion: boolean) =>
						target === "prompt"
							? Prompts.offer({
									name: "greeting://{name}",
									parameters: { name: Schema.String },
									content: () => Effect.succeed("hello"),
									...(completion
										? { completion: { name: () => Effect.succeed(["Ada"]) } }
										: {}),
								})
							: Effect.flatMap(
									Resources.template`greeting://${McpSchema.param("name", Schema.String)}`(
										{
											name: "greeting://{name}",
											content: (_uri, name) => Effect.succeed("Hello " + name),
											...(completion
												? {
														completion: { name: () => Effect.succeed(["Ada"]) },
													}
												: {}),
										},
									),
									Resources.offer,
								)
					yield* offer(true).pipe(Scope.provide(owner))
					const request = {
						ref:
							target === "prompt"
								? { type: "ref/prompt" as const, name: "greeting://{name}" }
								: { type: "ref/resource" as const, uri: "greeting://{name}" },
						argument: { name: "name", value: "A" },
					}
					assert.deepStrictEqual(
						(yield* client.complete(request)).completion.values,
						["Ada"],
					)
					yield* Scope.close(owner, Exit.void)
					yield* offer(false)
					// An identically named completion in the other list cannot authorize this stale entry.
					if (target === "prompt") {
						const other =
							yield* Resources.template`greeting://${McpSchema.param("name", Schema.String)}`(
								{
									name: "other",
									content: () => Effect.succeed("other"),
									completion: { name: () => Effect.succeed(["Other"]) },
								},
							)
						yield* Resources.offer(other)
					} else {
						yield* Prompts.offer({
							name: "greeting://{name}",
							parameters: { name: Schema.String },
							content: () => Effect.succeed("other"),
							completion: { name: () => Effect.succeed(["Other"]) },
						})
					}
					const error = yield* Effect.flip(client.complete(request))
					assert.equal(error.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
					if (target === "template")
						assert.deepStrictEqual(
							(yield* client.readResource({ uri: "greeting://Ada" })).contents,
							[{ uri: "greeting://Ada", text: "Hello Ada" }],
						)
				}).pipe(run),
		)
	}
}

it.effect(
	"public resource templates derive named and positional parameters, decoding and completions",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const adapter = yield* transport({ protocolVersion: "2026-07-28" })
			yield* (yield* Graft.plugin(adapter.plugin)).await
			const client = yield* adapter.client
			const item =
				yield* Resources.template`entry://${McpSchema.param("folder", Schema.String)}/${Schema.Finite}`(
					{
						name: "Entry",
						content: (_uri, folder, number) =>
							Effect.succeed(folder + ":" + (number + 1)),
						completion: { param1: () => Effect.succeed([42]) },
					},
				)
			assert.equal(item.uriTemplate, "entry://{folder}/{param1}")
			yield* Resources.offer(item)
			assert.deepStrictEqual(
				(yield* client.readResource({ uri: "entry://notes/42" })).contents,
				[{ uri: "entry://notes/42", text: "notes:43" }],
			)
			assert.deepStrictEqual(
				(yield* client.complete({
					ref: { type: "ref/resource", uri: item.uriTemplate },
					argument: { name: "param1", value: "4" },
				})).completion.values,
				["42"],
			)
		}).pipe(run),
)

it.effect(
	"interrupt-only offer, install and extension outcomes are not logged as errors",
	() =>
		Effect.gen(function* () {
			const errors = yield* Queue.unbounded<unknown>()
			const logger = Logger.layer([
				Logger.make((entry) => {
					if (entry.logLevel === "Error")
						Queue.offerUnsafe(errors, entry.message)
				}),
			])
			yield* Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				const adapter = yield* transport()
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const kind: Catalog.Kind<string> = {
					key: "test/interrupted-install",
					list: "resources",
					identities: (item) => [item],
					install: () => Effect.interrupt,
				}
				yield* Event.on(Catalog.Offered, () => Effect.interrupt)
				yield* Event.on(Catalog.Offered, () =>
					Effect.succeed([{ kind, item: "test://cancelled" }]),
				)
				yield* Event.on(Extensions.Declared, () => Effect.interrupt)
				yield* Event.emit(Catalog.Changed)
				const logged = yield* Queue.clear(errors)
				assert.deepStrictEqual(logged, [])
			}).pipe(run, Effect.provide(logger))
		}),
)

for (const phase of [
	"Offered",
	"install",
	"extensions",
	"notification",
] as const) {
	it.effect("transport unload interrupts a stuck projection " + phase, () =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const entered = yield* Deferred.make<void>()
			const stopped = yield* Deferred.make<void>()
			const stuck = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Deferred.succeed(stopped, undefined)),
			)
			const adapter = yield* transport({
				registry: (server) =>
					phase !== "notification"
						? server
						: Object.assign(server, {
								notifications: {
									...server.notifications,
									"notifications/resources/list_changed": () => stuck,
								},
							}),
			})
			const serving = yield* Graft.plugin(adapter.plugin)
			yield* serving.await
			if (phase === "extensions")
				yield* Event.on(Extensions.Declared, () => stuck)
			const kind: Catalog.Kind<string> = {
				key: "test/stuck",
				list: "resources",
				identities: (item) => [item],
				install: (uri, annotations) =>
					phase === "install"
						? stuck
						: McpServer.registerResource({
								uri,
								name: uri,
								annotations,
								content: Effect.succeed("entry"),
							}),
			}
			yield* Event.on(Catalog.Offered, () =>
				phase === "Offered"
					? stuck
					: Effect.succeed([{ kind, item: "test://stuck" }]),
			)
			const emitter = yield* Event.emit(Catalog.Changed).pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			yield* serving.dispose
			yield* Deferred.await(stopped)
			yield* Fiber.await(emitter)
			// With the projection gone, a contributor's own Changed dispatch has nothing to wait for.
			const contributor = yield* Graft.plugin(
				Plugin.make({
					name: "test/after-stuck",
					apply: () =>
						Resources.offer({
							uri: "test://later",
							name: "later",
							content: Effect.succeed("later"),
						}),
				}),
			)
			yield* contributor.await
			yield* contributor.dispose
		}).pipe(run),
	)
}

it.effect(
	"a cancelled emitter does not hold another contributor beyond its own sync",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const adapter = yield* transport()
			yield* (yield* Graft.plugin(adapter.plugin)).await
			const entered = yield* Deferred.make<void>()
			const owner = yield* Scope.make()
			yield* Event.on(Catalog.Offered, () =>
				Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
			).pipe(Scope.provide(owner))
			const emitter = yield* Event.emit(Catalog.Changed).pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			yield* Fiber.interrupt(emitter)
			const contributor = yield* Graft.plugin(
				Plugin.make({
					name: "test/queued",
					apply: () =>
						Resources.offer({
							uri: "test://queued",
							name: "queued",
							content: Effect.succeed("queued"),
						}),
				}),
			)
			// Removing the stuck handler releases collection; the queued contributor awaits its own generation.
			yield* Scope.close(owner, Exit.void)
			yield* contributor.await
			const client = yield* adapter.client
			assert.lengthOf((yield* client.listResources()).resources, 1)
		}).pipe(run),
)

for (const phase of ["Offered", "install"] as const) {
	it.effect(
		"coalesces Changed emitted from " + phase + " across two projections",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				const first = yield* transport({ name: "test/first" })
				const second = yield* transport({ name: "test/second" })
				yield* (yield* Graft.plugin(first.plugin)).await
				yield* (yield* Graft.plugin(second.plugin)).await
				const context = yield* Effect.context<Graft.Graft>()
				const collections = yield* Ref.make(0)
				const installs = yield* Ref.make(0)
				const kind: Catalog.Kind<string> = {
					key: "test/reentrant",
					list: "resources",
					identities: (item) => [item],
					install: (uri, annotations) =>
						Effect.gen(function* () {
							yield* Ref.update(installs, (n) => n + 1)
							if (phase === "install")
								yield* Event.emit(Catalog.Changed).pipe(Effect.provide(context))
							yield* McpServer.registerResource({
								uri,
								name: uri,
								annotations,
								content: Effect.succeed("entry"),
							})
						}),
				}
				const offer = { kind, item: "test://reentrant" }
				yield* Event.on(Catalog.Offered, () =>
					Effect.gen(function* () {
						const count = yield* Ref.updateAndGet(collections, (n) => n + 1)
						if (phase === "Offered" && count <= 2)
							yield* Event.emit(Catalog.Changed)
						return [offer]
					}),
				)
				yield* Event.emit(Catalog.Changed)
				// Fence any pass coalesced by a nested emission.
				yield* Event.emit(Catalog.Changed)
				for (const adapter of [first, second]) {
					const client = yield* adapter.client
					assert.lengthOf((yield* client.listResources()).resources, 1)
				}
				const installedCount = yield* Ref.get(installs)
				assert.equal(installedCount, 2)
				const collectedCount = yield* Ref.get(collections)
				assert.isAtLeast(collectedCount, 4)
			}).pipe(run),
	)
}

it.effect(
	"transport unload releases a contributor's waiting withdrawal finalizer",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const adapter = yield* transport()
			const serving = yield* Graft.plugin(adapter.plugin)
			yield* serving.await
			const contributor = yield* Graft.plugin(
				Plugin.make({
					name: "test/withdrawing",
					apply: () =>
						Resources.offer({
							uri: "test://withdrawing",
							name: "withdrawing",
							content: Effect.succeed("entry"),
						}),
				}),
			)
			yield* contributor.await
			const entered = yield* Deferred.make<void>()
			yield* Event.on(Catalog.Offered, () =>
				Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
			)
			const unloading = yield* contributor.dispose.pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			yield* serving.dispose
			yield* Fiber.join(unloading)
		}).pipe(run),
)

it.effect(
	"projection batches do not inherit a third-party emitter origin",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const adapter = yield* transport()
			yield* (yield* Graft.plugin(adapter.plugin)).await
			const origin = Event.makeOrigin()
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const observed = yield* Ref.make<ReadonlyArray<boolean>>([])
			yield* Event.on(Catalog.Offered, () =>
				Effect.gen(function* () {
					const within = yield* Event.isWithin(origin)
					yield* Ref.update(observed, (values) => [...values, within])
					yield* Deferred.succeed(entered, undefined)
					yield* Deferred.await(release)
					return []
				}),
			)
			const first = yield* Event.emit(Catalog.Changed).pipe(
				Event.within(origin),
				Effect.forkScoped,
			)
			yield* Deferred.await(entered)
			const second = yield* Event.emit(Catalog.Changed).pipe(Effect.forkScoped)
			yield* Effect.yieldNow
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(first)
			yield* Fiber.join(second)
			const values = yield* Ref.get(observed)
			assert.isAtLeast(values.length, 2)
			assert.deepStrictEqual(
				values,
				Array.map(values, () => false),
			)
		}).pipe(run),
)

it.effect(
	"projection shutdown rejects new syncs while an active batch is stopping",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const adapter = yield* transport()
			const serving = yield* Graft.plugin(adapter.plugin)
			yield* serving.await
			const entered = yield* Deferred.make<void>()
			const stopping = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const collections = yield* Ref.make(0)
			yield* Event.on(Catalog.Offered, () =>
				Ref.update(collections, (n) => n + 1).pipe(
					Effect.andThen(Deferred.succeed(entered, undefined)),
					Effect.andThen(Effect.never),
					Effect.onInterrupt(() =>
						Deferred.succeed(stopping, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					),
				),
			)
			const emitter = yield* Event.emit(Catalog.Changed).pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			const closing = yield* serving.dispose.pipe(Effect.forkScoped)
			yield* Deferred.await(stopping)
			// Changed is still registered while the worker's finalizer is gated.
			yield* Event.emit(Catalog.Changed)
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(closing)
			yield* Fiber.join(emitter)
			const count = yield* Ref.get(collections)
			assert.equal(count, 1)
		}).pipe(run),
)
