import {
	Array,
	Deferred,
	Effect,
	Exit,
	Fiber,
	JsonSchema,
	Layer,
	Option,
	Queue,
	References,
	Schema,
	SchemaRepresentation,
	Scope,
} from "effect"
import { McpSchema, McpTest, Tool, Toolkit } from "effect/ai"
import { assert, describe, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "@graftland/graft"
import { ConfigSchema } from "@graftland/loader"
import { ScopeToken } from "@graftland/plugin-http/Authorization"

import {
	advertise as advertiseOffer,
	Offered as Tools,
} from "../src/Catalog.ts"
import { HttpConfig } from "../src/Config.ts"
import core from "../src/index.ts"
import { entries } from "../src/schema.ts"
import {
	kind,
	offer,
	plugin as tools,
	type Registration,
} from "../src/Tools.ts"
import * as Testing from "./support.ts"

const Clock = Toolkit.make(
	Tool.make("now", {
		description: "The current time",
		success: Schema.String,
	}),
)

const clock = (time: string) =>
	tools({
		name: `clock ${time}`,
		toolkit: Clock,
		handlers: Effect.succeed(Clock.of({ now: () => Effect.succeed(time) })),
	})

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

const advertise = (item: Registration) => advertiseOffer({ kind, item })
const connect = Effect.gen(function* () {
	const coreFork = yield* Graft.plugin(core, {})
	yield* coreFork.await
	const transport = yield* Testing.transport({ protocolVersion: "2025-11-25" })
	yield* (yield* Graft.plugin(transport.plugin)).await
	return yield* transport.client
})

const listed = (client: McpTest.Client) =>
	Effect.map(client.listTools(), (result) =>
		Array.map(result.tools, (tool) => tool.name),
	)

const time = (client: McpTest.Client) =>
	Effect.map(client.callTool({ name: "now", arguments: {} }), (result) =>
		Array.join(
			Array.map(result.content, (content) =>
				content.type === "text" ? content.text : content.type,
			),
			"",
		),
	)

/** Notifications the client has received so far, by method. */
const notified = (client: McpTest.Client) =>
	Effect.map(Queue.clear(client.notifications), (all) =>
		Array.map(all, (notification) => notification.method),
	)

const expectListed = (
	client: McpTest.Client,
	expected: ReadonlyArray<string>,
) =>
	Effect.map(listed(client), (names) => assert.deepStrictEqual(names, expected))

const expectTime = (client: McpTest.Client, expected: string) =>
	Effect.map(time(client), (actual) => assert.strictEqual(actual, expected))

const expectListChanged = (client: McpTest.Client) =>
	Effect.map(notified(client), (methods) =>
		assert.isTrue(Array.contains(methods, "notifications/tools/list_changed")),
	)

describe("mcp-server", () => {
	it.effect("lists and calls the tools that plugins offer", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(clock("12:00"))
			yield* fork.await
			const client = yield* connect
			yield* expectListed(client, ["now"])
			yield* expectTime(client, "12:00")
		}).pipe(run),
	)

	it.effect("serves a tool offered after the client connected", () =>
		Effect.gen(function* () {
			const client = yield* connect
			yield* expectListed(client, [])
			const fork = yield* Graft.plugin(clock("12:00"))
			yield* fork.await
			yield* expectListed(client, ["now"])
			yield* expectListChanged(client)
		}).pipe(run),
	)

	it.effect("withdraws a tool when its plugin unloads", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(clock("12:00"))
			yield* fork.await
			const client = yield* connect
			yield* notified(client)
			yield* fork.dispose
			yield* expectListed(client, [])
			const call = yield* Effect.exit(time(client))
			assert.isTrue(Exit.isFailure(call))
			yield* expectListChanged(client)
		}).pipe(run),
	)

	it.effect("serves the new handler after a replacement", () =>
		Effect.gen(function* () {
			const v1 = clock("12:00")
			const v2 = clock("13:00")
			const fork = yield* Graft.plugin(v1)
			yield* fork.await
			const client = yield* connect
			yield* expectTime(client, "12:00")
			const result = yield* Graft.replace([[v1, v2]])
			assert.strictEqual(result._tag, "Replaced")
			yield* expectTime(client, "13:00")
			yield* expectListed(client, ["now"])
		}).pipe(run),
	)

	it.effect("serves neither tool when two plugins offer the same name", () =>
		Effect.gen(function* () {
			const first = yield* Graft.plugin(clock("12:00"))
			const second = yield* Graft.plugin(clock("13:00"))
			yield* first.await
			yield* second.await
			const client = yield* connect
			yield* expectListed(client, [])
			yield* second.dispose
			yield* expectListed(client, ["now"])
			yield* expectTime(client, "12:00")
		}).pipe(run),
	)

	it.effect("interrupts a call when its plugin unloads", () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const slow = tools({
				name: "slow clock",
				toolkit: Clock,
				handlers: Effect.succeed(
					Clock.of({
						now: () =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.never),
							),
					}),
				),
			})
			const fork = yield* Graft.plugin(slow)
			yield* fork.await
			const client = yield* connect
			const call = yield* Effect.forkChild(Effect.exit(time(client)))
			yield* Deferred.await(started)
			yield* fork.dispose
			const exit = yield* Fiber.join(call)
			assert.isTrue(Exit.isFailure(exit))
		}).pipe(run),
	)

	it.effect("serves tools offered with offer, in the plugin's context", () =>
		Effect.gen(function* () {
			const annotated = Plugin.make({
				name: "annotated clock",
				apply: () =>
					offer(
						Clock,
						Clock.of({
							now: () =>
								Effect.map(
									References.CurrentLogAnnotations,
									(annotations) => `${annotations["graft.plugin"]}`,
								),
						}),
					),
			})
			const fork = yield* Graft.plugin(annotated)
			yield* fork.await
			const client = yield* connect
			yield* expectTime(client, "annotated clock")
		}).pipe(run),
	)

	it.effect("keeps serving when another plugin's Tools handler fails", () =>
		Effect.gen(function* () {
			const broken = Plugin.make({
				name: "broken registry",
				apply: () => Event.on(Tools, () => Effect.die("broken registry")),
			})
			const brokenFork = yield* Graft.plugin(broken)
			yield* brokenFork.await
			const fork = yield* Graft.plugin(clock("12:00"))
			yield* fork.await
			const client = yield* connect
			yield* expectListed(client, ["now"])
			yield* fork.dispose
			yield* expectListed(client, [])
		}).pipe(run),
	)

	it.effect("serves tools advertised through the events directly", () =>
		Effect.gen(function* () {
			// No helper: any package can answer the Tools event.
			const direct = Plugin.make({
				name: "direct clock",
				apply: () =>
					Effect.gen(function* () {
						const handlers = yield* Clock.toHandlers(
							Clock.of({ now: () => Effect.succeed("direct") }),
						)
						const registration: Registration = {
							toolkit: Clock as unknown as Registration["toolkit"],
							handlers: handlers as Registration["handlers"],
						}
						yield* advertise(registration)
					}),
			})
			const fork = yield* Graft.plugin(direct)
			yield* fork.await
			const client = yield* connect
			yield* expectListed(client, ["now"])
			yield* expectTime(client, "direct")
		}).pipe(run),
	)
})

it("registers the server entry for graft schema", () => {
	const [registration] = entries()
	assert.deepStrictEqual(registration?.names, [
		"mcp-server",
		"@graftland/plugin-mcp-server",
	])
})

it.effect("provides request services without plugin injection", () =>
	Effect.gen(function* () {
		const Request = Toolkit.make(
			Tool.make("request", {
				success: Schema.String,
				dependencies: [
					McpSchema.McpRequestContext,
					McpSchema.McpServerClient,
					Scope.Scope,
				],
			}),
		)
		const source = tools({
			name: "request services",
			toolkit: Request,
			handlers: Effect.succeed(
				Request.of({
					request: () =>
						Effect.gen(function* () {
							yield* McpSchema.McpRequestContext
							yield* McpSchema.McpServerClient
							yield* Scope.Scope
							return "available"
						}),
				}),
			),
		})
		yield* (yield* Graft.plugin(source)).await
		const client = yield* connect
		const reply = yield* client.callTool({ name: "request", arguments: {} })
		assert.deepStrictEqual(reply.content, [{ type: "text", text: "available" }])
	}).pipe(run),
)

it.effect(
	"hides every tool in conflicting toolkits and restores them together",
	() =>
		Effect.gen(function* () {
			const Pair = Toolkit.make(
				Tool.make("now", { success: Schema.String }),
				Tool.make("unique", { success: Schema.String }),
			)
			const source = tools({
				name: "two tools",
				toolkit: Pair,
				handlers: Effect.succeed(
					Pair.of({
						now: () => Effect.succeed("12:00"),
						unique: () => Effect.succeed("unique"),
					}),
				),
			})
			yield* (yield* Graft.plugin(source)).await
			const client = yield* connect
			const second = yield* Graft.plugin(clock("13:00"))
			yield* second.await
			yield* expectListed(client, [])
			yield* second.dispose
			const names = yield* listed(client)
			assert.sameMembers(names, ["now", "unique"])
		}).pipe(run),
)

it.effect("registers HTTP names and decodes the omitted configuration", () =>
	Effect.gen(function* () {
		const registration = entries()[2]!
		const document = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Unknown),
		)(registration.schema)
		assert.deepStrictEqual(registration.names, [
			"mcp-server/http",
			"@graftland/plugin-mcp-server/http",
		])
		assert.include(document, '"path"')
		assert.include(document, '"scopes"')
		const observed0 = yield* Schema.decodeEffect(HttpConfig)(undefined)
		assert.deepStrictEqual(observed0, {
			path: "/mcp",
		})
	}),
)

it.effect(
	"rejects malformed scope tokens in config decoding and the graft editor schema",
	() =>
		Effect.gen(function* () {
			const document = ConfigSchema.make({ entries: entries() })
			const rule = Option.getOrThrow(
				Array.findFirst(document.definitions.Entry.allOf!, (rule) =>
					rule.if.properties.name.enum.includes("mcp-server/http"),
				),
			)
			assert.include(
				rule.if.properties.name.enum,
				"@graftland/plugin-mcp-server/http",
			)
			// JSON Schema imports use built-in checks only and cannot require Effect services.
			const editor = SchemaRepresentation.fromJsonSchemaDocument(
				JsonSchema.fromSchemaDraft07(rule.then.properties.config),
				{ patterns: "apply" },
			) as Schema.Codec<unknown>
			for (const [scope, valid] of [
				["", false],
				["notes read", false],
				['notes"read', false],
				["notes\\read", false],
				["notes\nread", false],
				["讀取", false],
				["notes:read", true],
				["!#$%&'()*+,-./:;<=>?@[]^_`{|}~", true],
			] as const) {
				const config = { authorization: { scopes: [scope] } }
				const decoded = yield* Effect.isSuccess(
					Schema.decodeEffect(HttpConfig)(config),
				)
				const checked = yield* Effect.isSuccess(
					Schema.decodeEffect(editor)(config),
				)
				const shared = yield* Effect.isSuccess(
					Schema.decodeEffect(ScopeToken)(scope),
				)
				assert.equal(decoded, valid, scope)
				assert.equal(checked, valid, scope)
				assert.equal(shared, valid, scope)
			}
		}),
)
