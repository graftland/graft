import {
	Array,
	Context,
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
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "@graftland/graft"

import * as Extensions from "../src/Extensions.ts"
import core from "../src/index.ts"
import * as Middleware from "../src/Middleware.ts"
import * as Testing from "../src/Testing.ts"
import * as Tools from "../src/Tools.ts"
import { transport } from "./support.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))
class Principal extends Context.Service<Principal, string>()(
	"@graftland/plugin-mcp-server/test/policy.test/Principal",
) {}
const kit = Toolkit.make(Tool.make("identity", { success: Schema.String }))
const connect = Effect.gen(function* () {
	yield* (yield* Graft.plugin(core, {})).await
	const adapter = yield* transport({ protocolVersion: "2026-07-28" })
	yield* (yield* Graft.plugin(adapter.plugin)).await
	return yield* adapter.client
})

it.effect(
	"middleware order survives reload, skips lists and is removed on unload",
	() =>
		Effect.gen(function* () {
			const seen = yield* Ref.make<ReadonlyArray<string>>([])
			const policy = (name: string, order: number) =>
				Plugin.make({
					name,
					apply: () =>
						Event.on(
							Middleware.Middleware,
							(call, next) =>
								Ref.update(seen, Array.append(name)).pipe(
									Effect.andThen(next(call)),
								),
							{ order },
						),
				})
			const a = yield* Graft.plugin(policy("test/a", -10))
			yield* a.await
			yield* (yield* Graft.plugin(policy("test/b", 10))).await
			yield* (yield* Graft.plugin(
				Tools.plugin({
					name: "test/tool",
					toolkit: kit,
					handlers: Effect.succeed(
						kit.of({ identity: () => Effect.succeed("ok") }),
					),
				}),
			)).await
			const client = yield* connect
			yield* client.listTools()
			const observed0 = yield* Ref.get(seen)
			assert.deepStrictEqual(observed0, [])
			yield* client.callTool({ name: "identity" })
			const observed1 = yield* Ref.get(seen)
			assert.deepStrictEqual(observed1, ["test/a", "test/b"])
			yield* Ref.set(seen, [])
			yield* a.restart
			yield* a.await
			yield* client.callTool({ name: "identity" })
			const observed2 = yield* Ref.get(seen)
			assert.deepStrictEqual(observed2, ["test/a", "test/b"])
			yield* Ref.set(seen, [])
			yield* a.dispose
			yield* client.callTool({ name: "identity" })
			const observed3 = yield* Ref.get(seen)
			assert.deepStrictEqual(observed3, ["test/b"])
		}).pipe(run),
)

it.effect(
	"request additions beat same-key plugin services and visibility cannot see middleware additions",
	() =>
		Effect.gen(function* () {
			const kit = Toolkit.make(
				Tool.make("identity", {
					success: Schema.String,
					dependencies: [Principal],
				}),
			)
			yield* Graft.provide(Principal, "plugin")
			yield* (yield* Graft.plugin(
				Tools.plugin({
					name: "test/principal",
					inject: [Principal],
					toolkit: kit,
					handlers: Effect.succeed(kit.of({ identity: () => Principal })),
				}),
			)).await
			const observed = yield* Ref.make<ReadonlyArray<string | undefined>>([])
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "test/auth",
					apply: () =>
						Effect.gen(function* () {
							yield* Event.on(Middleware.Visible, (call) =>
								Ref.update(
									observed,
									Array.append(
										Context.getOrUndefined(call.services, Principal),
									),
								).pipe(Effect.as(true)),
							)
							yield* Event.on(Middleware.Middleware, (call, next) =>
								next({
									...call,
									services: Context.add(call.services, Principal, "request"),
								}),
							)
						}),
				}),
			)).await
			const client = yield* connect
			const result = yield* client.callTool({ name: "identity" })
			assert.deepStrictEqual(result.content, [
				{ type: "text", text: '"request"' },
			])
			const checks = yield* Ref.get(observed)
			assert.isFalse(Array.contains(checks, "request"))
		}).pipe(run),
)

it.effect(
	"visibility is request-specific and middleware can reject with a custom MCP error",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(
				Tools.plugin({
					name: "test/tool",
					toolkit: kit,
					handlers: Effect.succeed(
						kit.of({ identity: () => Effect.succeed("ok") }),
					),
				}),
			)).await
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "test/policy",
					apply: () =>
						Effect.gen(function* () {
							yield* Event.on(Middleware.Visible, (call) =>
								Effect.succeed(
									call.requestContext.requestMetadata?.["user"] === "Ada",
								),
							)
							yield* Event.on(Middleware.Middleware, () =>
								Effect.fail(
									McpSchema.McpErrorBase.make({
										code: -32000,
										message: "Rate limit reached",
									}),
								),
							)
						}),
				}),
			)).await
			const client = yield* connect
			assert.equal(
				(yield* client.listTools({ _meta: { user: "Ada" } })).tools.length,
				1,
			)
			assert.equal(
				(yield* client.listTools({ _meta: { user: "Grace" } })).tools.length,
				0,
			)
			assert.equal(
				(yield* Effect.flip(
					client.callTool({ name: "identity", _meta: { user: "Ada" } }),
				)).code,
				-32000,
			)
		}).pipe(run),
)

it.effect(
	"unloading middleware interrupts a call already running through next",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const stopped = yield* Deferred.make<void>()
			const policy = yield* Graft.plugin(
				Plugin.make({
					name: "test/policy",
					apply: () =>
						Event.on(Middleware.Middleware, (call, next) => next(call)),
				}),
			)
			yield* policy.await
			yield* (yield* Graft.plugin(
				Tools.plugin({
					name: "test/slow",
					toolkit: kit,
					handlers: Effect.succeed(
						kit.of({
							identity: () =>
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Deferred.succeed(stopped, undefined)),
								),
						}),
					),
				}),
			)).await
			const client = yield* connect
			const call = yield* client
				.callTool({ name: "identity" })
				.pipe(Effect.exit, Effect.forkChild)
			yield* Deferred.await(started)
			yield* policy.dispose
			yield* Deferred.await(stopped)
			const ended = yield* Fiber.join(call)
			assert.isTrue(Exit.isFailure(ended))
		}).pipe(run),
)

it.effect(
	"extensions merge equal duplicates, hide conflicts and change only at restart",
	() =>
		Effect.gen(function* () {
			const declare = (settings: Record<string, unknown>) =>
				Plugin.make({
					name: "test/extension",
					apply: () => Extensions.declare(settings),
				})
			yield* (yield* Graft.plugin(core, {})).await
			yield* (yield* Graft.plugin(declare({ "com.acme/x": { enabled: true } })))
				.await
			const same = yield* Graft.plugin(
				declare({ "com.acme/x": { enabled: true } }),
			)
			yield* same.await
			const adapter = yield* Testing.transport
			const fork = yield* Graft.plugin(adapter.plugin)
			yield* fork.await
			const client = yield* adapter.client
			const discover = Effect.gen(function* () {
				yield* client.send({
					jsonrpc: "2.0",
					id: 1,
					method: "server/discover",
					params: { _meta: Testing.metadata },
				})
				return yield* Testing.response(client, 1)
			})
			const before = yield* discover
			const conflict = yield* Graft.plugin(
				declare({ "com.acme/x": { enabled: false } }),
			)
			yield* conflict.await
			const observed4 = yield* discover
			assert.deepStrictEqual(observed4, before)
			const second = yield* Testing.transport
			yield* (yield* Graft.plugin(second.plugin)).await
			const restarted = yield* second.client
			yield* restarted.send({
				jsonrpc: "2.0",
				id: 2,
				method: "server/discover",
				params: { _meta: Testing.metadata },
			})
			const after = yield* Testing.response(restarted, 2)
			assert.notDeepEqual(after.result, before.result)
		}).pipe(run),
)

it.effect(
	"transport request services and plugin log intercepts reach owned handlers",
	() =>
		Effect.gen(function* () {
			const logs = yield* Queue.unbounded<{
				readonly logLevel: string
				readonly annotations: Readonly<Record<string, unknown>>
			}>()
			const logger = Logger.layer([
				Logger.make((entry) => {
					Queue.offerUnsafe(logs, {
						logLevel: entry.logLevel,
						annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
					})
				}),
			])
			yield* Effect.gen(function* () {
				yield* Graft.provide(Principal, "plugin")
				const toolkit = Toolkit.make(
					Tool.make("context", {
						success: Schema.String,
						dependencies: [Principal],
					}),
				)
				yield* (yield* Graft.plugin(
					Tools.plugin({
						name: "test/owned-logger",
						toolkit,
						inject: [Principal],
						handlers: Effect.succeed(
							toolkit.of({
								context: () =>
									Effect.gen(function* () {
										const level = yield* References.MinimumLogLevel
										yield* Effect.logDebug("owned handler")
										return (yield* Principal) + ":" + level
									}),
							}),
						),
					}),
					undefined,
					{
						intercept: [
							Graft.intercept(
								References.MinimumLogLevel,
								() => "Debug" as const,
							),
						],
					},
				)).await
				yield* (yield* Graft.plugin(core, {})).await
				const adapter = yield* transport({
					protocolVersion: "2026-07-28",
					middleware: McpServer.middleware(
						(effect) =>
							Effect.provideService(effect, Principal, "transport-request"),
						{ global: true },
					),
				})
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const result = yield* (yield* adapter.client).callTool({
					name: "context",
				})
				assert.deepStrictEqual(result.content, [
					{ type: "text", text: '\"transport-request:Debug\"' },
				])
				const entries = yield* Queue.clear(logs)
				const owned = Array.findFirst(
					entries,
					(entry) => entry.logLevel === "Debug",
				)
				assert.equal(owned._tag, "Some")
				if (owned._tag === "Some")
					assert.equal(
						owned.value.annotations["graft.plugin"],
						"test/owned-logger",
					)
			}).pipe(run, Effect.provide(logger))
		}),
)

it.effect(
	"unloading middleware before next interrupts the call without bypassing policy",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const invoked = yield* Ref.make(false)
			const policy = yield* Graft.plugin(
				Plugin.make({
					name: "test/pending-policy",
					apply: () =>
						Event.on(Middleware.Middleware, () =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
							),
						),
				}),
			)
			yield* policy.await
			yield* (yield* Graft.plugin(
				Tools.plugin({
					name: "test/protected",
					toolkit: kit,
					handlers: Effect.succeed(
						kit.of({
							identity: () =>
								Ref.set(invoked, true).pipe(Effect.as("bypassed")),
						}),
					),
				}),
			)).await
			const client = yield* connect
			const call = yield* client
				.callTool({ name: "identity" })
				.pipe(Effect.exit, Effect.forkChild)
			yield* Deferred.await(entered)
			yield* policy.dispose
			const result = yield* Fiber.join(call)
			assert.isTrue(Exit.isFailure(result))
			const called = yield* Ref.get(invoked)
			assert.isFalse(called)
		}).pipe(run),
)
