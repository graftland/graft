import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"

class Config extends Context.Service<Config, { readonly region: string }>()(
	"@graftland/graft/test/availability.test/Config",
) {}
class Cache extends Context.Service<Cache, { readonly name: string }>()(
	"@graftland/graft/test/availability.test/Cache",
) {}
class Derived extends Context.Service<
	Derived,
	{ readonly region: string; readonly cache: Option.Option<string> }
>()("@graftland/graft/test/availability.test/Derived") {}

/** Runs a test inside a fresh root graph. */
const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

describe("service availability", () => {
	it.effect(
		"watch reports a service appearing, being withdrawn, and appearing again",
		() =>
			Effect.gen(function* () {
				const emitted = yield* Queue.unbounded<Option.Option<string>>()
				const observed = yield* Effect.forkScoped(
					Graft.watch(Config).pipe(
						Stream.map(Option.map((config) => config.region)),
						Stream.tap((value) => Queue.offer(emitted, value)),
						Stream.take(4),
						Stream.runCollect,
					),
				)
				const first = yield* Queue.take(emitted)
				assert.deepStrictEqual(first, Option.none())
				yield* Effect.scoped(
					Effect.gen(function* () {
						const publication = yield* Graft.publish(Config, {
							region: "eu",
						})
						yield* publication.await
					}),
				)
				const second = yield* Queue.take(emitted)
				assert.deepStrictEqual(second, Option.some("eu"))
				const third = yield* Queue.take(emitted)
				assert.deepStrictEqual(third, Option.none())
				yield* Effect.scoped(
					Effect.gen(function* () {
						const publication = yield* Graft.publish(Config, {
							region: "us",
						})
						yield* publication.await
					}),
				)
				const fourth = yield* Queue.take(emitted)
				assert.deepStrictEqual(fourth, Option.some("us"))
				const collected = yield* Fiber.join(observed)
				assert.deepStrictEqual(collected, [
					Option.none(),
					Option.some("eu"),
					Option.none(),
					Option.some("us"),
				])
			}).pipe(run),
	)

	it.effect("await blocks until the service is available", () =>
		Effect.gen(function* () {
			const waiting = yield* Effect.forkScoped(
				Graft.await(Config).pipe(Effect.map((config) => config.region)),
			)
			yield* Effect.yieldNow
			yield* Effect.yieldNow
			assert.strictEqual(waiting.pollUnsafe(), undefined)
			const region = yield* Effect.scoped(
				Effect.gen(function* () {
					const publication = yield* Graft.publish(Config, { region: "eu" })
					yield* publication.await
					return yield* Fiber.join(waiting)
				}),
			)
			assert.strictEqual(region, "eu")
		}).pipe(run),
	)

	it.effect(
		"use fails with ServiceWithdrawn when the service is withdrawn mid-use",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const seen = yield* Ref.make(Option.none<string>())
				const publication = yield* Scope.make()
				const value = yield* Graft.publish(Config, { region: "eu" }).pipe(
					Scope.provide(publication),
				)
				yield* value.await
				const using = yield* Effect.forkScoped(
					Effect.exit(
						Graft.use(Config, (config) =>
							Effect.andThen(
								Ref.set(seen, Option.some(config.region)),
								Effect.andThen(
									Deferred.succeed(entered, undefined),
									Effect.never,
								),
							),
						),
					),
				)
				yield* Deferred.await(entered)
				yield* Scope.close(publication, Exit.void)
				const exit = yield* Fiber.join(using)
				if (Exit.isSuccess(exit))
					return yield* Effect.die(new Error("use completed after withdrawal"))
				const error = Cause.squash(exit.cause)
				if (!Schema.is(Graft.ServiceWithdrawn)(error))
					return yield* Effect.die(
						new Error(`unexpected failure: ${String(error)}`),
					)
				assert.strictEqual(error.service, Config.key)
				const observed = yield* Ref.get(seen)
				assert.deepStrictEqual(observed, Option.some("eu"))
			}).pipe(run),
	)

	it.effect(
		"whileAvailable interrupts on withdrawal and restarts when the service returns",
		() =>
			Effect.gen(function* () {
				const events = yield* Queue.unbounded<string>()
				yield* Effect.forkScoped(
					Graft.whileAvailable(Config, (config) =>
						Effect.onInterrupt(
							Effect.andThen(
								Queue.offer(events, `open ${config.region}`),
								Effect.never,
							),
							() => Queue.offer(events, `close ${config.region}`),
						),
					),
				)
				yield* Effect.scoped(
					Effect.gen(function* () {
						const publication = yield* Graft.publish(Config, {
							region: "eu",
						})
						yield* publication.await
						const opened = yield* Queue.take(events)
						assert.strictEqual(opened, "open eu")
					}),
				)
				const closed = yield* Queue.take(events)
				assert.strictEqual(closed, "close eu")
				yield* Effect.scoped(
					Effect.gen(function* () {
						const publication = yield* Graft.publish(Config, {
							region: "us",
						})
						yield* publication.await
						const reopened = yield* Queue.take(events)
						assert.strictEqual(reopened, "open us")
					}),
				)
				const reclosed = yield* Queue.take(events)
				assert.strictEqual(reclosed, "close us")
			}).pipe(run),
	)

	it.effect("rebuilds a dependent mount when a publication is set again", () =>
		Effect.gen(function* () {
			const builds = yield* Ref.make<ReadonlyArray<string>>([])
			const built = yield* Queue.unbounded<string>()
			const layer = Layer.effect(
				Derived,
				Effect.gen(function* () {
					const config = yield* Config
					yield* Ref.update(builds, Array.append(config.region))
					yield* Queue.offer(built, config.region)
					return { region: config.region, cache: Option.none<string>() }
				}),
			)
			yield* Graft.mount(layer, { name: "derived", requires: [Config] })
			yield* Effect.scoped(
				Effect.gen(function* () {
					const publication = yield* Graft.publish(Config, { region: "eu" })
					yield* publication.await
					const initial = yield* Queue.take(built)
					assert.strictEqual(initial, "eu")
					yield* publication.set({ region: "us" })
					const rebuilt = yield* Queue.take(built)
					assert.strictEqual(rebuilt, "us")
				}),
			)
			const regions = yield* Ref.get(builds)
			assert.deepStrictEqual(regions, ["eu", "us"])
		}).pipe(run),
	)

	it.effect(
		"rebuilds a mount when an optional dependency appears and disappears",
		() =>
			Effect.gen(function* () {
				const builds = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
				const built = yield* Queue.unbounded<string>()
				const layer = Layer.effect(
					Derived,
					Effect.gen(function* () {
						const provided = yield* Effect.serviceOption(Cache)
						const cache = Option.map(provided, (cache) => cache.name)
						yield* Ref.update(builds, Array.append(cache))
						yield* Queue.offer(
							built,
							Option.getOrElse(cache, () => "none"),
						)
						return { region: "optional", cache }
					}),
				)
				yield* Graft.mount(layer, {
					name: "optional",
					requires: [Graft.optional(Cache)],
				})
				const initial = yield* Queue.take(built)
				assert.strictEqual(initial, "none")
				yield* Effect.scoped(
					Effect.gen(function* () {
						const publication = yield* Graft.publish(Cache, {
							name: "redis",
						})
						yield* publication.await
						const appeared = yield* Queue.take(built)
						assert.strictEqual(appeared, "redis")
					}),
				)
				const disappeared = yield* Queue.take(built)
				assert.strictEqual(disappeared, "none")
				const observed = yield* Ref.get(builds)
				assert.deepStrictEqual(observed, [
					Option.none(),
					Option.some("redis"),
					Option.none(),
				])
			}).pipe(run),
	)
})
