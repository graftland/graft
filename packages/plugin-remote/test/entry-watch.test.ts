import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import {
	Array,
	String,
	Cause,
	Effect,
	Layer,
	Logger,
	MutableList,
	Option,
	Queue,
	Ref,
	Schema,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { SecureRandom } from "effect/crypto"
import * as Contract from "../src/Contract"
import { launch } from "../src/internal/entry"

it.effect(
	"reinstalls a failed remote observation and restarts on the next change",
	() =>
		Effect.gen(function* () {
			const activations = yield* Queue.unbounded<void>()
			const subscriptions = yield* Queue.unbounded<number>()
			const changes = yield* Queue.unbounded<void>()
			const attempts = yield* Ref.make(0)
			const logs = MutableList.make<string>()
			const contract = Contract.make({
				name: "watched",
				config: Schema.Finite,
				module: "file:///implementation.mjs",
			})
			const failure = ModuleResolver.ModuleInvalid.make({
				specifier: "file:///contract.mjs",
				cause: "Transient observation failure",
			})
			const resolver = {
				resolve: () =>
					Effect.succeed(
						Plugin.make({
							name: "pending-provider",
							apply: () =>
								Queue.offer(activations, undefined).pipe(
									Effect.andThen(Effect.never),
								),
						}),
					),
				importModule: () => Effect.succeed({ contract }),
			}
			const watch = () =>
				Stream.unwrap(
					Effect.gen(function* () {
						const attempt = yield* Ref.getAndUpdate(attempts, (n) => n + 1)
						yield* Queue.offer(subscriptions, attempt)
						return attempt === 0
							? Stream.fail(failure)
							: Stream.fromQueue(changes)
					}),
				)
			yield* Effect.gen(function* () {
				yield* launch(
					contract,
					{
						contract: "file:///contract.mjs",
						config: 1,
						connect: { local: {} },
					},
					{ contractModule: "file:///contract.mjs" },
				)
				yield* Queue.take(activations)
				const first = yield* Queue.take(subscriptions)
				assert.equal(first, 0)
				yield* TestClock.adjust("1 second")
				const second = yield* Queue.take(subscriptions)
				assert.equal(second, 1)
				yield* Queue.offer(changes, undefined)
				yield* Queue.take(activations)
				assert.isTrue(
					Array.some(
						MutableList.toArray(logs),
						String.includes("Transient observation failure"),
					),
				)
			}).pipe(
				Effect.provideService(ModuleResolver.ModuleResolver, resolver),
				Effect.provideService(ModuleResolver.Watch, Option.some(watch)),
				Effect.provide(
					Logger.layer([
						Logger.make(({ cause }) => {
							MutableList.append(logs, Cause.pretty(cause))
						}),
					]),
				),
			)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Graft.layer.pipe(
					Layer.provideMerge(
						Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
					),
				),
			),
		),
)
