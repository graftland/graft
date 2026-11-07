import { Array, Deferred, Effect, Exit, Layer, Schema, Scope } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import core from "../src/index.ts"
import * as Resources from "../src/Resources.ts"
import { isolate } from "../src/Server.ts"
import * as Testing from "../src/Testing.ts"
import * as Tools from "../src/Tools.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

it.effect(
	"C8: isolated servers keep catalogs, request emissions and notifications in their own realms",
	() =>
		Effect.gen(function* () {
			const make = Effect.fnUntraced(function* (name: string) {
				const ready = yield* Deferred.make<Testing.Connection>()
				const group = Plugin.make({
					name: "test/group/" + name,
					apply: () =>
						Effect.gen(function* () {
							yield* (yield* Graft.plugin(core, { name })).await
							const kit = Toolkit.make(
								Tool.make(name, {
									success: Schema.Void,
									dependencies: [Graft.Graft],
								}),
							)
							yield* (yield* Graft.plugin(
								Plugin.make({
									name: "test/contributor/" + name,
									apply: () =>
										Tools.offer(
											kit,
											kit.of({
												[name]: () => Resources.updated("test://shared"),
											}),
										),
								}),
							)).await
							const adapter = yield* Testing.transport
							yield* (yield* Graft.plugin(adapter.plugin)).await
							const client = yield* adapter.client
							yield* Deferred.succeed(ready, client)
						}),
				})
				yield* (yield* Graft.plugin(group, undefined, {
					isolate: Array.map(isolate, (key) => ({ key })),
				})).await
				return yield* Deferred.await(ready)
			})
			const a = yield* make("alpha")
			const b = yield* make("beta")
			for (const [client, name] of [
				[a, "alpha"],
				[b, "beta"],
			] as const) {
				yield* client.send({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: { _meta: Testing.metadata },
				})
				const reply = yield* Testing.response(client, 1)
				assert.deepStrictEqual(
					Array.map(
						(reply.result as { tools: ReadonlyArray<{ name: string }> }).tools,
						(tool) => tool.name,
					),
					[name],
				)
				yield* client.send({
					jsonrpc: "2.0",
					id: 10,
					method: "subscriptions/listen",
					params: {
						notifications: { resourceSubscriptions: ["test://shared"] },
						_meta: Testing.metadata,
					},
				})
				const ack = yield* client.receive
				assert.propertyVal(
					ack,
					"method",
					"notifications/subscriptions/acknowledged",
				)
			}
			yield* a.send({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "alpha", arguments: {}, _meta: Testing.metadata },
			})
			const first = yield* a.receive
			const second = yield* a.receive
			assert.isTrue(
				Array.some(
					[first, second],
					(message) =>
						"method" in message &&
						message.method === "notifications/resources/updated",
				),
			)
			assert.isTrue(
				Array.some(
					[first, second],
					(message) => "id" in message && message.id === 2,
				),
			)
			// FIFO barrier: a leaked notification would precede this response.
			yield* b.send({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/list",
				params: { _meta: Testing.metadata },
			})
			const next = yield* b.receive
			assert.propertyVal(next, "id", 3)
		}).pipe(run),
)

it.effect("a second core in one realm fails with ServiceConflict", () =>
	Effect.gen(function* () {
		yield* (yield* Graft.plugin(core, {})).await
		const second = yield* Graft.plugin(core, {})
		const result = yield* Effect.exit(second.await)
		assert.isTrue(Exit.isFailure(result))
	}).pipe(run),
)

it.effect(
	"withdrawing Server stops every transport without unloading contributors",
	() =>
		Effect.gen(function* () {
			const server = yield* Graft.plugin(core, {})
			yield* server.await
			const stopped = yield* Deferred.make<void>()
			const contributor = yield* Graft.plugin(
				Plugin.make({
					name: "test/still-alive",
					apply: () =>
						Effect.addFinalizer(() => Deferred.succeed(stopped, undefined)),
				}),
			)
			yield* contributor.await
			const first = yield* Testing.transport
			const second = yield* Testing.transport
			yield* (yield* Graft.plugin(first.plugin)).await
			yield* (yield* Graft.plugin(second.plugin)).await
			const a = yield* first.client
			const b = yield* second.client
			yield* server.dispose
			yield* a.closed
			yield* b.closed
			const done = yield* Deferred.isDone(stopped)
			assert.isFalse(done)
		}).pipe(run),
)
